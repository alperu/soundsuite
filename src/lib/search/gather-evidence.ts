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
import { EVIDENCE_DEFAULTS } from '../mcp/research-types';
import { enforceProvider, LOCAL_PROVIDER } from '../mcp/llm-policy';
import { LOCAL_ROUTING, localDecomposeModel, localOutlineModel } from '../mcp/routing-defaults';
import { DEFAULT_MODELS } from '../mcp/tools/ai-helper';
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
  summariseSubQueryTimings,
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
 * Fallback hard cap on the LLM evidence-outline step, used only when
 * `LOCAL_ROUTING.outline.timeoutMs` is absent. Same failure mode as decompose
 * (a 60K-char prompt at ~16 tok/s on a queued Ollama); past this the result
 * carries `outline: null` rather than a fabricated grouping. Override via
 * `retrieval.outlineTimeoutMs`.
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
 * Shorten a chunk to `max` characters on a word boundary with a visible
 * ellipsis. Never cuts mid-word: if the last space sits implausibly early
 * (a long unbroken run, e.g. a table row), the hard slice is used instead.
 */
export function truncateChunkText(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const head = (lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice).trimEnd();
  return `${head} …`;
}

/**
 * Marker appended to a shortened `tableMarkdown`. Deliberately a separate
 * line rather than a fake row: a markdown table cut mid-row renders as
 * garbage, whereas a table followed by a plain line renders as a table plus a
 * note.
 */
export const TABLE_TRUNCATION_MARKER = '\n… (table truncated)';

/**
 * Shorten a markdown table to `max` characters on a ROW boundary. The marker's
 * length is reserved inside `max`, so the returned string is a true bound.
 *
 * Whole lines are kept in order, which means the header and its `|---|`
 * delimiter survive whenever `max` admits them — the prefix still renders as a
 * table. If not even the first line fits the budget the cut degrades to a hard
 * slice of that line (nothing renders as a table at that size anyway).
 */
export function truncateTableMarkdown(md: string, max: number): string {
  if (max <= 0 || md.length <= max) return md;
  const budget = max - TABLE_TRUNCATION_MARKER.length;
  // Too small to carry both content and the marker — bound it and stop.
  if (budget <= 0) return md.slice(0, max);
  const kept: string[] = [];
  let used = 0;
  for (const line of md.split('\n')) {
    const cost = kept.length === 0 ? line.length : line.length + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  const head = kept.length > 0 ? kept.join('\n') : md.slice(0, budget).trimEnd();
  return `${head}${TABLE_TRUNCATION_MARKER}`;
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
  const config = await getConfig().catch(() => ({} as { ollamaCompletionModel?: string }));
  if (options.localOnly) {
    llmProvider = enforceProvider('local', options.provider) ?? LOCAL_PROVIDER;
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
  const outlineTimeoutMs = retrieval.outlineTimeoutMs && retrieval.outlineTimeoutMs > 0
    ? retrieval.outlineTimeoutMs
    : (LOCAL_ROUTING.outline?.timeoutMs ?? OUTLINE_TIMEOUT_MS);
  // Caps always apply: an uncapped payload is what flooded callers in v4.
  const maxEvidence = retrieval.maxEvidence && retrieval.maxEvidence > 0 ? retrieval.maxEvidence : EVIDENCE_DEFAULTS.maxEvidence;
  const maxCharsPerChunk = retrieval.maxCharsPerChunk && retrieval.maxCharsPerChunk > 0
    ? retrieval.maxCharsPerChunk
    : EVIDENCE_DEFAULTS.maxCharsPerChunk;
  /** Ids of items whose text was shortened — counted over the RETURNED set. */
  const truncatedIds = new Set<string>();
  /** Same, for items whose `tableMarkdown` was shortened (separate counter). */
  const truncatedTableIds = new Set<string>();
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
  // Per-sub-query timings (stream B's instrumentation): summed >> wall clock
  // means the fan-out really is parallel; summed ≈ wall clock means something
  // downstream serialised it. Retrieve is 91 s of the local `deep` run.
  const retrieveTimings = summariseSubQueryTimings(subQueryResults);
  emit('retrieve', `retrieved ${retrieveTimings.count} sub-quer${retrieveTimings.count === 1 ? 'y' : 'ies'} in ${phases.retrieve ?? 0} ms`, {
    detail: { timings: retrieveTimings },
  });

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
  /**
   * The single construction point for evidence items. `maxCharsPerChunk` is
   * applied here, not at the final cap, because `onEvidence` streams items to
   * job clients before the cap runs — truncating later would leave that path
   * unbounded, which is the flood N-2 is about. Which ids were shortened is
   * remembered so `stats.caps.chunksTruncated` / `.tablesTruncated` can be
   * counted over the returned set only.
   *
   * `tableMarkdown` is bounded by the same knob (R-3): capping `text` alone
   * left a table-heavy result set able to defeat the payload bound N-2 exists
   * to enforce. It gets its own counter because `chunksTruncated` is defined
   * as "returned items whose TEXT was shortened" — folding tables in would
   * make it mean "text or table" and stop answering that question.
   */
  const toItem = (source: DeepSearchSource, origin: EvidenceItem['source'], rerankScore?: number): EvidenceItem => {
    const item = sourceToEvidenceItem(source, origin, rerankScore);
    if (item.text.length > maxCharsPerChunk) {
      item.text = truncateChunkText(item.text, maxCharsPerChunk);
      truncatedIds.add(item.id);
    }
    if (item.tableMarkdown && item.tableMarkdown.length > maxCharsPerChunk) {
      item.tableMarkdown = truncateTableMarkdown(item.tableMarkdown, maxCharsPerChunk);
      truncatedTableIds.add(item.id);
    }
    return item;
  };
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
  const initial = addItems(sources.map((s) => toItem(s, evidenceOrigin(s), reranked ? s.score : undefined)));
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
              ...toItem(s, `rlm-round-${round}`),
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
  // Count is capped only on the final list: RLM rounds add high-value items
  // late, so trimming the stream by count would hide them from a job client.
  // Reported unconditionally: `evidenceTruncated: true` tells a caller items
  // were dropped but not how many existed. The `cap` progress event carries
  // it, but a client that only polls `research_result` never sees that stream.
  const evidenceTotalBeforeCap = evidence.length;
  const evidenceTruncated = evidence.length > maxEvidence;
  const finalEvidence = evidenceTruncated ? evidence.slice(0, maxEvidence) : evidence;
  // Never counts chunks the caller does not receive: "63 truncations" in a
  // 3-item result is only confusing to someone debugging a short response.
  const chunksTruncated = finalEvidence.reduce((n, it) => n + (truncatedIds.has(it.id) ? 1 : 0), 0);
  const tablesTruncated = finalEvidence.reduce((n, it) => n + (truncatedTableIds.has(it.id) ? 1 : 0), 0);
  if (evidenceTruncated) {
    emit('cap', `evidence capped at ${maxEvidence} of ${evidence.length} items`, {
      detail: { maxEvidence, total: evidence.length, maxCharsPerChunk, chunksTruncated },
    });
  }

  // -- Outline (skipped for fast) --------------------------------------------
  let outline: EvidenceResult['outline'] | undefined;
  if (mode !== 'fast') {
    checkAbort();
    emit('outline', `outlining ${finalEvidence.length} evidence items`);
    // The builder owns its own budget (`LOCAL_ROUTING.outline.timeoutMs`,
    // 25 s). `retrieval.outlineTimeoutMs` is the OUTER phase bound only —
    // passing it inward would hand the builder the whole phase budget, which
    // is how the outline came to burn 60 s every run (report v4, N-3).
    const provider = options.localOnly ? LOCAL_PROVIDER : (llmProvider ?? LOCAL_PROVIDER);
    // Resolved independently of decompose (report N-3). This used to read
    // `llmModel ?? LOCAL_ROUTING.outline?.model`, and `llmModel` is the
    // already-resolved DECOMPOSE model, so it always won: the outline ran on
    // the decompose model and `localOutlineModel()` was never called from
    // anywhere. A resolver failure falls back to the preferred tag rather than
    // breaking the run — same defensiveness as the decompose resolution.
    const outlineModel = options.localOnly
      ? await localOutlineModel(config).catch(() => LOCAL_ROUTING.outline?.model)
      : (options.model ?? LOCAL_ROUTING.outline?.model);
    const outlineOptions = {
      timeoutMs: LOCAL_ROUTING.outline?.timeoutMs,
      model: outlineModel,
      maxItems: LOCAL_ROUTING.outline?.maxItems,
      maxCharsPerItem: LOCAL_ROUTING.outline?.maxCharsPerItem,
      // Policy stamp and abort plumbing stay on the call: the outline is an
      // LLM step and `local` must never reach a non-Ollama provider.
      provider,
      profile: options.localOnly ? ('local' as const) : options.profile,
      // Structured-JSON task — see the decompose note on reasoning models.
      thinking: options.thinking ?? false,
      effort: options.effort,
      onWarn: (reason: string) => emit('warning', `outline: ${reason}`),
    };
    try {
      // `null` means the outline step produced nothing usable — that is a
      // reported absence, not a licence to fabricate a per-document grouping.
      outline = await timed('outline', () =>
        withPhaseTimeout('outline', outlineTimeoutMs, signal, (outlineSignal) =>
          buildEvidenceOutline(finalEvidence, query, decomposition!.subQueries, { ...outlineOptions, signal: outlineSignal }),
        ),
      );
      if (outline) {
        modelsUsed.outline = `${provider}/${outlineOptions.model}`;
      } else {
        outline = null;
        modelsUsed.outline = 'none';
        emit('warning', `outline unavailable (${provider}/${outlineOptions.model}) — returning evidence without one`, {
          detail: { timeoutMs: outlineTimeoutMs },
        });
      }
    } catch (err) {
      checkAbort();
      const timedOut = err instanceof PhaseTimeoutError;
      const msg = err instanceof Error ? err.message : String(err);
      outline = null;
      modelsUsed.outline = 'none';
      emit(
        'warning',
        timedOut
          ? `outline timed out after ${outlineTimeoutMs} ms (${provider}/${outlineOptions.model}) — returning evidence without an outline`
          : `outline failed (${msg.slice(0, 160)}) — returning evidence without an outline`,
        { detail: { timedOut, timeoutMs: outlineTimeoutMs } },
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
    // `undefined` = the tier has no outline phase (fast); `null` = it ran and
    // produced nothing. The two are not the same to a caller.
    ...(outline !== undefined ? { outline } : {}),
    ...(rlm ? { rlm } : {}),
    stats: {
      retrievals,
      chunksFused: stats.uniqueAfterDedup,
      rerankPool: stats.rerankPool,
      ms: Date.now() - t0,
      phases,
      caps: { maxEvidence, maxCharsPerChunk, evidenceTruncated, evidenceTotalBeforeCap, chunksTruncated, tablesTruncated },
    },
    profile: 'local',
    localOnly: true,
    modelsUsed,
  };
}
