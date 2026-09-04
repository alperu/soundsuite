/**
 * Local evidence engine (docs/tasks/06-mcp-two-profiles.md, work item 2;
 * REPORT-v2.1 Part A).
 *
 * `gatherEvidence()` is `deepSearch()` with synthesis cut off: it runs
 * routing → decompose → parallel retrieval → pattern backstop → fuse →
 * rerank → RLM rounds → evidence outline and returns an `EvidenceResult` —
 * ranked chunks, sub-queries, RLM notes and a sections→evidenceIds outline.
 * Nothing in here writes prose.
 *
 * The dashboard keeps `deepSearch()`; this module only reuses its exported
 * stages so the two paths retrieve identically.
 *
 * Policy: with `localOnly` every LLM call (decompose, outline) is pinned to
 * Ollama via `enforceProvider('local', …)` and the RLM rounds run on the
 * sidecar endpoint; a cloud provider in the options is a POLICY_VIOLATION,
 * raised before any retrieval starts.
 */

import type { ToolRegistry } from '../mcp/tool-registry';
import type {
  EvidenceItem,
  EvidenceResult,
  GatherEvidenceOptions,
  ResearchMode,
  ResearchProgress,
  ResearchTier,
} from '../mcp/research-types';
import { enforceProvider, LOCAL_PROVIDER } from '../mcp/llm-policy';
import { LOCAL_ROUTING, localDecomposeModel } from '../mcp/routing-defaults';
import { DEFAULT_MODELS, getAvailableProvider } from '../mcp/tools/ai-helper';
import { getConfig } from '../db/config';
import { RLM_MODEL_ID } from '../ai/stream-rlm';
import {
  buildChipSpecs,
  buildRlmInheritedWhereClauses,
  decomposeQuery,
  deduplicateAndMerge,
  executeParallelSearches,
  executePatternSearch,
  executePerChipPatternSearches,
  runRlmEvidenceRounds,
  type DecompositionResult,
  type DeepSearchProgress,
  type DeepSearchSource,
  type SubQueryResult,
  type SubQuerySpec,
} from './deep-search';
import { classifyQueryComplexity, routeToResearchMode } from './query-router';
import { sourceToEvidenceItem } from './evidence-mapping';
import { buildEvidenceOutline } from './evidence-outline';
import { heuristicDecompose } from './heuristic-decompose';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface ResolvedResearchMode {
  requested: ResearchMode;
  mode: ResearchTier;
  reason: string;
  confidence: number;
}

/**
 * Resolve the tier a request runs at. `auto` (or nothing) defers to the
 * deterministic query router; an explicit tier is honoured as-is. Shared by
 * `gatherEvidence` and the `research_evidence` tool, which needs the answer
 * up-front to decide whether to self-promote to a job.
 */
export function resolveResearchMode(query: string, requested?: ResearchMode): ResolvedResearchMode {
  const req: ResearchMode = requested ?? 'auto';
  if (req !== 'auto') {
    return { requested: req, mode: req, reason: 'mode requested by caller', confidence: 1 };
  }
  const decision = classifyQueryComplexity(query);
  return {
    requested: 'auto',
    mode: routeToResearchMode(decision.route),
    reason: decision.reason,
    confidence: decision.confidence,
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** RLM tool-use rounds over MCP when neither the preset nor the caller says. */
export const MCP_RLM_DEFAULT_ROUNDS = LOCAL_ROUTING['deep-rlm'].rlmMaxRounds ?? 2;
/** Cap on RLM narration forwarded to `onThoughts` (mirrors deepSearch). */
const RLM_THOUGHTS_CAP = 3000;
/**
 * Hard cap on the LLM decompose step (report M-1). A wedged or queued Ollama
 * used to hold the pipeline in `decompose` until the 5-minute socket timeout;
 * past this the engine switches to `heuristicDecompose` and carries on.
 * Override per request via `retrieval.decomposeTimeoutMs`.
 */
export const DECOMPOSE_TIMEOUT_MS = 20_000;
/**
 * Hard cap on the LLM evidence-outline step. Same failure mode as decompose
 * (a 60K-char prompt at ~16 tok/s on a queued Ollama); past this the outline
 * degrades to a per-document grouping. Override via `retrieval.outlineTimeoutMs`.
 */
export const OUTLINE_TIMEOUT_MS = 60_000;
/** `modelsUsed.decompose` / `.outline` when the LLM step was replaced by a heuristic. */
export const DECOMPOSE_HEURISTIC_FALLBACK = 'heuristic-fallback';

class PhaseTimeoutError extends Error {
  constructor(phase: string, ms: number) {
    super(`${phase} timed out after ${ms} ms`);
    this.name = 'PhaseTimeoutError';
  }
}

/**
 * Run `fn` with a signal that aborts on the caller's signal OR after `ms`,
 * and additionally race a timer so the pipeline moves on even if the
 * transport ignores the abort. The loser is left to settle on its own.
 */
async function withPhaseTimeout<T>(
  phase: string,
  ms: number,
  parent: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(ms);
  const signal = parent ? AbortSignal.any([parent, timeoutSignal]) : timeoutSignal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PhaseTimeoutError(phase, ms)), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([fn(signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Zero-LLM outline: one section per document in evidence-rank order, so a
 * consumer still gets a sections→evidenceIds map when the model is unavailable.
 */
function heuristicOutline(evidence: EvidenceItem[]): NonNullable<EvidenceResult['outline']> {
  const byDoc = new Map<string, { title: string; evidenceIds: string[] }>();
  for (const item of evidence) {
    const key = item.documentId || 'unknown';
    let section = byDoc.get(key);
    if (!section) {
      const label = item.headingPath?.split(' > ')[0]?.trim();
      section = { title: label ? `${label} (${key})` : `Document ${key}`, evidenceIds: [] };
      byDoc.set(key, section);
    }
    section.evidenceIds.push(item.id);
  }
  return { sections: [...byDoc.values()], gaps: [] };
}

export type GatherEvidenceInput = GatherEvidenceOptions & {
  /** Request fields the caller already knows the local profile ignores (reported in `routing.ignored`). */
  ignored?: string[];
  /** Dashboard chat id — only used to scope per-chat retrieval caches. */
  chatId?: string;
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function abortError(): Error {
  const err = new Error('Research aborted by client');
  err.name = 'AbortError';
  return err;
}

function evidenceOrigin(source: DeepSearchSource): EvidenceItem['source'] {
  const tags = source.matchedSubQueries ?? [];
  return tags.length > 0 && tags.every((t) => t.startsWith('[pattern')) ? 'pattern' : 'retrieval';
}

export async function gatherEvidence(
  query: string,
  registry: ToolRegistry,
  options: GatherEvidenceInput,
): Promise<EvidenceResult> {
  const t0 = Date.now();
  const phases: Record<string, number> = {};
  const progress = options.onProgress ?? (() => {});
  const signal = options.signal;
  const checkAbort = () => { if (signal?.aborted) throw abortError(); };
  const timed = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try { return await fn(); } finally { phases[phase] = (phases[phase] ?? 0) + (Date.now() - start); }
  };
  const emit = (phase: ResearchProgress['phase'], message: string, extra: Partial<ResearchProgress> = {}) =>
    progress({ phase, message, ...extra });

  // -- Policy: resolve before touching anything (fail-closed) ---------------
  let llmProvider: string | undefined;
  let llmModel: string | undefined;
  if (options.localOnly) {
    llmProvider = enforceProvider('local', options.provider) ?? LOCAL_PROVIDER;
    const config = await getConfig().catch(() => ({} as { ollamaCompletionModel?: string }));
    // Decompose and the outline are short JSON prompts: prefer the dedicated
    // small model (config → env → small tag on the host → completion model).
    llmModel =
      options.model ??
      LOCAL_ROUTING.deep.model ??
      (await localDecomposeModel(config).catch(() => config.ollamaCompletionModel ?? DEFAULT_MODELS.ollama));
  } else {
    llmProvider = options.provider;
    llmModel = options.model;
  }
  const rerankModel = await getConfig().then((c) => c.rerankModel || 'unknown').catch(() => 'unknown');

  // -- Routing ---------------------------------------------------------------
  checkAbort();
  const routing = await timed('routing', async () => resolveResearchMode(query, options.mode));
  const mode = routing.mode;
  emit('routing', `mode ${mode} (${routing.reason})`, { detail: { requested: routing.requested, confidence: routing.confidence } });

  const retrieval = options.retrieval ?? {};
  const limitPerSubQuery = retrieval.limitPerSubQuery && retrieval.limitPerSubQuery > 0 ? retrieval.limitPerSubQuery : 50;
  const rlmMaxRounds = retrieval.rlmMaxRounds && retrieval.rlmMaxRounds > 0 ? retrieval.rlmMaxRounds : MCP_RLM_DEFAULT_ROUNDS;
  const decomposeTimeoutMs = retrieval.decomposeTimeoutMs && retrieval.decomposeTimeoutMs > 0 ? retrieval.decomposeTimeoutMs : DECOMPOSE_TIMEOUT_MS;
  const outlineTimeoutMs = retrieval.outlineTimeoutMs && retrieval.outlineTimeoutMs > 0 ? retrieval.outlineTimeoutMs : OUTLINE_TIMEOUT_MS;
  const scopeWhere = options.whereClauses && options.whereClauses.length > 0 ? options.whereClauses : undefined;

  // Warnings are informational for the evidence engine — surfaced as progress.
  const pushWarning = (w: { source: string; host?: string; reason?: string; message: string }) => {
    emit('warning', `${w.source}${w.host ? ` (${w.host})` : ''}: ${w.reason ? `${w.reason}: ` : ''}${w.message}`);
  };

  // -- Decompose -------------------------------------------------------------
  checkAbort();
  const modelsUsed: EvidenceResult['modelsUsed'] = { decompose: 'none', rerank: rerankModel, rlm: 'none', outline: 'none' };
  let chipSpecs: SubQuerySpec[] | null = null;
  let dispatchSpecs: ReadonlyArray<string | SubQuerySpec>;
  let decomposition: DecompositionResult;

  await timed('decompose', async () => {
    if (mode === 'fast') {
      // Fast tier: a single retrieval on the query as written — no LLM.
      emit('decompose', 'fast mode — searching the query as written');
      decomposition = { subQueries: [query], intent: query };
      dispatchSpecs = [query];
      return;
    }
    chipSpecs = buildChipSpecs(query);
    if (chipSpecs && chipSpecs.length > 0) {
      emit('decompose', `chip dispatch — ${chipSpecs.length} scoped sub-quer${chipSpecs.length === 1 ? 'y' : 'ies'}`);
      const framing = chipSpecs.find((s) => s.label === 'framing');
      decomposition = {
        subQueries: chipSpecs.map((s) => s.query),
        intent: framing?.query ?? chipSpecs.map((s) => s.query).filter(Boolean).join(' · ') ?? query,
      };
      dispatchSpecs = chipSpecs;
      return;
    }
    emit('decompose', options.history?.length ? 'analysing follow-up in context' : 'breaking question into sub-queries');
    try {
      decomposition = await withPhaseTimeout('decompose', decomposeTimeoutMs, signal, (decomposeSignal) =>
        decomposeQuery(query, {
          provider: llmProvider,
          model: llmModel,
          history: options.history,
          // Decompose is a structured-JSON task; reasoning models (qwen3.x)
          // otherwise spend the whole token budget thinking and return no JSON.
          thinking: options.thinking ?? false,
          effort: options.effort,
          signal: decomposeSignal,
        }),
      );
      modelsUsed.decompose = `${llmProvider ?? 'auto'}/${llmModel ?? 'auto'}`;
    } catch (err) {
      // The client went away — propagate; anything else degrades to the heuristic.
      checkAbort();
      const timedOut = err instanceof PhaseTimeoutError;
      const msg = err instanceof Error ? err.message : String(err);
      decomposition = heuristicDecompose(query);
      modelsUsed.decompose = DECOMPOSE_HEURISTIC_FALLBACK;
      emit(
        'warning',
        timedOut
          ? `decomposition timed out after ${decomposeTimeoutMs} ms (${llmProvider ?? 'auto'}/${llmModel ?? 'auto'}) — using heuristic keyword split (${decomposition.subQueries.length} sub-queries)`
          : `decomposition failed (${msg.slice(0, 160)}) — using heuristic keyword split (${decomposition.subQueries.length} sub-queries)`,
        { detail: { fallback: DECOMPOSE_HEURISTIC_FALLBACK, timedOut, timeoutMs: decomposeTimeoutMs } },
      );
    }
    dispatchSpecs = decomposition.subQueries;
  });

  // -- Retrieve --------------------------------------------------------------
  checkAbort();
  const scopedSpecs: ReadonlyArray<string | SubQuerySpec> = scopeWhere
    ? dispatchSpecs!.map((s) => {
        const spec: SubQuerySpec = typeof s === 'string' ? { query: s } : s;
        return { ...spec, whereClauses: [...(spec.whereClauses ?? []), ...scopeWhere] };
      })
    : dispatchSpecs!;
  emit('retrieve', `searching ${decomposition!.subQueries.length} sub-quer${decomposition!.subQueries.length === 1 ? 'y' : 'ies'}`, {
    detail: { subQueries: decomposition!.subQueries },
  });
  const subQueryResults: SubQueryResult[] = await timed('retrieve', () =>
    executeParallelSearches(scopedSpecs, options.caseId, registry, pushWarning, options.chatId, limitPerSubQuery),
  );

  // -- Pattern backstop ------------------------------------------------------
  checkAbort();
  emit('pattern', 'keyword pattern backstop for exact text matches');
  await timed('pattern', async () => {
    if (chipSpecs && chipSpecs.length > 0) {
      const perChip = await executePerChipPatternSearches(chipSpecs, options.caseId, registry, pushWarning, scopeWhere);
      for (const r of perChip) if (r.sources.length > 0) subQueryResults.push(r);
    } else {
      const r = await executePatternSearch(query, options.caseId, registry, pushWarning, scopeWhere);
      if (r.sources.length > 0) subQueryResults.push(r);
    }
  });
  const retrievals = subQueryResults.reduce((n, r) => n + r.sources.length, 0);

  // -- Fuse + rerank ---------------------------------------------------------
  // `deduplicateAndMerge` fuses and reranks in one call, so the wall time
  // lands under `fuse`; the `rerank` progress line reports the pool sizes.
  checkAbort();
  emit('fuse', `fusing ${retrievals} chunks`);
  const { sources, stats } = await timed('fuse', () =>
    deduplicateAndMerge(subQueryResults, query, pushWarning, retrieval.rerankPoolSize ? { rerankPoolSize: retrieval.rerankPoolSize } : undefined),
  );
  emit('rerank', `rerank ${stats.rerankPool} → ${stats.finalAfterRerank}`, {
    detail: { chunksFused: stats.uniqueAfterDedup, rerankPool: stats.rerankPool },
  });

  const evidence: EvidenceItem[] = [];
  const seenIds = new Set<string>();
  const addItems = (items: EvidenceItem[]): EvidenceItem[] => {
    const fresh: EvidenceItem[] = [];
    for (const it of items) {
      if (seenIds.has(it.id)) continue;
      seenIds.add(it.id);
      evidence.push(it);
      fresh.push(it);
    }
    return fresh;
  };
  const reranked = stats.rerankPool > 0;
  const initial = addItems(sources.map((s) => sourceToEvidenceItem(s, evidenceOrigin(s), reranked ? s.score : undefined)));
  if (initial.length > 0) options.onEvidence?.(initial);

  // -- RLM rounds (deep-rlm only) --------------------------------------------
  let rlm: EvidenceResult['rlm'] | undefined;
  if (mode === 'deep-rlm') {
    checkAbort();
    emit('rlm', `rlm round 1/${rlmMaxRounds}`, { rlmRound: 1, rlmMaxRounds });
    let streamed = 0;
    const onToken = options.onThoughts
      ? (t: string) => { if (streamed < RLM_THOUGHTS_CAP) { streamed += t.length; options.onThoughts!(t); } }
      : undefined;
    const onProgress = (p: DeepSearchProgress) => {
      if (p.step === 'rlm-subcall' && p.rlmRound) {
        emit('rlm', `rlm round ${p.rlmRound}/${rlmMaxRounds}`, { rlmRound: p.rlmRound, rlmMaxRounds, detail: { message: p.message } });
      } else if (p.step === 'warning') {
        emit('warning', p.message);
      } else {
        emit('rlm', p.message, { rlmMaxRounds });
      }
    };
    try {
      const out = await timed('rlm', () =>
        runRlmEvidenceRounds(query, decomposition!, sources, registry, {
          caseId: options.caseId,
          chatId: options.chatId,
          history: options.history,
          signal,
          onToken,
          onProgress,
          pushWarning,
          maxRounds: rlmMaxRounds,
          inheritedWhereClauses: buildRlmInheritedWhereClauses(chipSpecs, scopeWhere),
          onRound: ({ round, sources: roundSources, note }) => {
            const items = addItems(roundSources.map((s) => ({
              ...sourceToEvidenceItem(s, `rlm-round-${round}`),
              rlmNote: note,
            })));
            if (items.length > 0) options.onEvidence?.(items);
          },
        }),
      );
      rlm = { rounds: out.rounds, toolCalls: out.toolCalls, notes: out.notes };
      modelsUsed.rlm = out.model;
    } catch (err) {
      checkAbort();
      if ((err as Error)?.name === 'AbortError') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      emit('warning', `rlm unavailable — continuing with reranked evidence (${msg.slice(0, 200)})`);
      rlm = { rounds: 0, toolCalls: 0, notes: [`rlm unavailable: ${msg.slice(0, 200)}`] };
    }
  }

  // -- Cap -------------------------------------------------------------------
  const maxEvidence = retrieval.maxEvidence && retrieval.maxEvidence > 0 ? retrieval.maxEvidence : undefined;
  const finalEvidence = maxEvidence ? evidence.slice(0, maxEvidence) : evidence;

  // -- Outline (skipped for fast) --------------------------------------------
  let outline: EvidenceResult['outline'] | undefined;
  if (mode !== 'fast') {
    checkAbort();
    emit('outline', `outlining ${finalEvidence.length} evidence items`);
    let provider = llmProvider;
    let model = llmModel;
    if (!provider || !model) {
      const auto = await getAvailableProvider();
      provider = provider ?? auto.provider;
      model = model ?? auto.model;
    }
    try {
      outline = await timed('outline', () =>
        withPhaseTimeout('outline', outlineTimeoutMs, signal, (outlineSignal) =>
          buildEvidenceOutline(query, decomposition!.subQueries, finalEvidence, {
            provider: provider!,
            model: model!,
            // Structured-JSON task — see the decompose note on reasoning models.
            thinking: options.thinking ?? false,
            effort: options.effort,
            signal: outlineSignal,
            profile: options.localOnly ? 'local' : options.profile,
          }),
        ),
      );
      modelsUsed.outline = `${provider}/${model}`;
    } catch (err) {
      checkAbort();
      const timedOut = err instanceof PhaseTimeoutError;
      const msg = err instanceof Error ? err.message : String(err);
      outline = heuristicOutline(finalEvidence);
      modelsUsed.outline = DECOMPOSE_HEURISTIC_FALLBACK;
      emit(
        'warning',
        timedOut
          ? `outline timed out after ${outlineTimeoutMs} ms (${provider}/${model}) — using per-document grouping (${outline.sections.length} sections)`
          : `outline failed (${msg.slice(0, 160)}) — using per-document grouping (${outline.sections.length} sections)`,
        { detail: { fallback: DECOMPOSE_HEURISTIC_FALLBACK, timedOut, timeoutMs: outlineTimeoutMs } },
      );
    }
  }

  return {
    query,
    routing: {
      requested: routing.requested,
      mode,
      reason: routing.reason,
      confidence: routing.confidence,
      ...(options.ignored && options.ignored.length > 0 ? { ignored: options.ignored } : {}),
    },
    subQueries: decomposition!.subQueries,
    evidence: finalEvidence,
    ...(outline ? { outline } : {}),
    ...(rlm ? { rlm } : {}),
    stats: {
      retrievals,
      chunksFused: stats.uniqueAfterDedup,
      rerankPool: stats.rerankPool,
      ms: Date.now() - t0,
      phases,
    },
    profile: 'local',
    localOnly: true,
    modelsUsed,
  };
}
