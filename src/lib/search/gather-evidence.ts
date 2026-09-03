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
import { LOCAL_ROUTING } from '../mcp/routing-defaults';
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
    llmModel = options.model ?? LOCAL_ROUTING.deep.model ?? config.ollamaCompletionModel ?? DEFAULT_MODELS.ollama;
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
    decomposition = await decomposeQuery(query, {
      provider: llmProvider,
      model: llmModel,
      history: options.history,
      thinking: options.thinking,
      effort: options.effort,
      signal,
    });
    dispatchSpecs = decomposition.subQueries;
    modelsUsed.decompose = `${llmProvider ?? 'auto'}/${llmModel ?? 'auto'}`;
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
    outline = await timed('outline', () =>
      buildEvidenceOutline(query, decomposition!.subQueries, finalEvidence, {
        provider: provider!,
        model: model!,
        thinking: options.thinking,
        effort: options.effort,
        signal,
        profile: options.localOnly ? 'local' : options.profile,
      }),
    );
    modelsUsed.outline = `${provider}/${model}`;
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
