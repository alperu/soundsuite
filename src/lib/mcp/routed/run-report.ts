/**
 * The `routed` report pipeline (REPORT-v2.1 Part B, work item 10).
 *
 * `planReport()`  — resolve tier + settings for a query without running it
 *                   (used by `routing_explain` and by `research_report` to
 *                   decide on self-promotion).
 * `runReport()`   — plan, run `deepSearch` with the resolved settings, and
 *                   shape the result as `ReportResult`. Writes a provenance
 *                   row at the end (fire-and-forget).
 *
 * Preset precedence: `overrides > inline preset (opts.preset) > active
 * session preset (or saved "default") > getDefaultRouting()`.
 */

import { deepSearch, type ConversationTurn, type DeepSearchProgress } from '../../search/deep-search';
import { documentIdsOf, sourcesToEvidence } from '../../search/evidence-mapping';
import type { ToolRegistry } from '../tool-registry';
import { McpError } from '../llm-policy';
import { getDefaultRouting } from '../routing-defaults';
import type {
  EvidenceItem,
  PresetV2,
  ReportResult,
  ResearchMode,
  ResearchProgress,
  ResearchTier,
  TierSettings,
} from '../research-types';
import { validatePreset } from '../presets/preset-schema';
import { getPreset } from '../presets/preset-store';
import { getActiveOrDefault, getTemp, isTempHandle } from '../presets/preset-session';
import {
  classifyTier,
  estimateCostClass,
  estimateSeconds,
  resolveTierSettings,
  wouldPromoteToJob,
  type CostClass,
} from './routing';
import { recordRoutedCall } from './provenance';

export interface RunReportOptions {
  profile: 'routed';
  sessionId?: string;
  caseId?: string;
  mode?: ResearchMode;
  /** Saved preset id/name, a `tmp_` handle, or an inline `PresetV2` (one-shot). */
  preset?: string | PresetV2;
  overrides?: Partial<TierSettings>;
  history?: ConversationTurn[];
  /** Default true. False → `evidence: []` (provenance still lists the ids). */
  includeEvidence?: boolean;
  /** Default false. True → forward model/RLM narration to `onThoughts`. */
  includeThoughts?: boolean;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onProgress?: (p: ResearchProgress) => void;
  onThoughts?: (text: string) => void;
  onEvidence?: (items: EvidenceItem[]) => void;
  /** Fires once routing is resolved, before any LLM call. */
  onPlan?: (plan: ReportPlan) => void;
}

export interface ReportPlan {
  requested: ResearchMode;
  tier: ResearchTier;
  reason: string;
  confidence: number;
  resolved: TierSettings;
  presetUsed?: string;
  clamps: string[];
  costClass: CostClass;
  estimatedSeconds: number;
  wouldPromoteToJob: boolean;
}

/** chars → tokens when the pipeline does not surface provider usage. */
export const CHARS_PER_TOKEN = 3.2;
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Preset layers
// ---------------------------------------------------------------------------

async function resolveInlinePreset(preset: string | PresetV2 | undefined): Promise<PresetV2 | null> {
  if (preset === undefined || preset === null) return null;
  if (typeof preset === 'string') {
    const key = preset.trim();
    if (!key) return null;
    if (isTempHandle(key)) {
      const temp = getTemp(key);
      if (!temp) throw new McpError('NOT_FOUND', `preset handle "${key}" is unknown or expired — call preset_define again`);
      return temp;
    }
    const stored = await getPreset(key);
    if (!stored) throw new McpError('NOT_FOUND', `preset "${key}" not found`);
    return stored.preset;
  }
  const result = await validatePreset(preset);
  if (!result.ok) throw new McpError('INVALID_PRESET', `inline preset rejected: ${result.errors.join('; ')}`);
  return result.preset;
}

export async function planReport(
  query: string,
  opts: Pick<RunReportOptions, 'sessionId' | 'mode' | 'preset' | 'overrides'>,
): Promise<ReportPlan> {
  const requested: ResearchMode = opts.mode ?? 'auto';
  const decision = classifyTier(query, requested);
  const [inlinePreset, active, defaults] = await Promise.all([
    resolveInlinePreset(opts.preset),
    getActiveOrDefault(opts.sessionId),
    getDefaultRouting(),
  ]);
  const { resolved, presetUsed, clamps } = resolveTierSettings(decision.tier, {
    activePreset: active?.preset ?? null,
    inlinePreset,
    overrides: opts.overrides ?? null,
    defaults,
  });
  return {
    requested,
    tier: decision.tier,
    reason: decision.reason,
    confidence: decision.confidence,
    resolved,
    ...(presetUsed ? { presetUsed } : {}),
    clamps,
    costClass: estimateCostClass(decision.tier, resolved),
    estimatedSeconds: estimateSeconds(decision.tier, resolved),
    wouldPromoteToJob: wouldPromoteToJob(decision.tier, resolved),
  };
}

// ---------------------------------------------------------------------------
// Progress mapping
// ---------------------------------------------------------------------------

function toResearchProgress(p: DeepSearchProgress): ResearchProgress {
  const detail: Record<string, unknown> = {};
  if (p.subQueryIndex !== undefined) detail.subQueryIndex = p.subQueryIndex;
  if (p.subQueryTotal !== undefined) detail.subQueryTotal = p.subQueryTotal;
  if (p.subQueries) detail.subQueries = p.subQueries;
  if (p.searchStats) detail.searchStats = p.searchStats;
  if (p.warnings) detail.warnings = p.warnings;
  if (p.rlmModel) detail.rlmModel = p.rlmModel;
  if (p.rlmChunkCount !== undefined) detail.rlmChunkCount = p.rlmChunkCount;
  return {
    phase: p.step,
    message: p.message,
    ...(p.rlmRound !== undefined ? { rlmRound: p.rlmRound } : {}),
    ...(Object.keys(detail).length ? { detail } : {}),
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export async function runReport(
  query: string,
  registry: ToolRegistry,
  opts: RunReportOptions,
): Promise<ReportResult> {
  if (opts.profile !== 'routed') {
    throw new McpError('POLICY_VIOLATION', 'runReport is only available under the "routed" profile');
  }
  const q = query.trim();
  if (!q) throw new McpError('INVALID_PARAMS', 'query is required');

  const plan = await planReport(q, opts);
  opts.onPlan?.(plan);
  const { tier, resolved } = plan;

  const startedAt = Date.now();
  const phases: Record<string, number> = {};
  let phaseName: string | null = null;
  let phaseStart = startedAt;
  const closePhase = (now: number) => {
    if (phaseName) phases[phaseName] = (phases[phaseName] ?? 0) + (now - phaseStart);
  };

  let rlmRoundsSeen = 0;
  let rlmToolCalls = 0;
  const rlmNotes: string[] = [];

  const onProgress = (p: DeepSearchProgress) => {
    const now = Date.now();
    if (p.step !== phaseName) {
      closePhase(now);
      phaseName = p.step;
      phaseStart = now;
    }
    if (p.step === 'rlm-subcall') {
      rlmToolCalls += 1;
      if (p.rlmRound !== undefined) rlmRoundsSeen = Math.max(rlmRoundsSeen, p.rlmRound);
      if (p.rlmSubQuery) rlmNotes.push(`round ${p.rlmRound ?? '?'}: ${p.message}`);
    }
    const mapped = toResearchProgress(p);
    if (resolved.rlmMaxRounds !== undefined && mapped.rlmRound !== undefined) mapped.rlmMaxRounds = resolved.rlmMaxRounds;
    opts.onProgress?.(mapped);
  };

  let outputChars = 0;
  const onToken = (text: string) => {
    outputChars += text.length;
    opts.onToken?.(text);
  };

  const historyChars = (opts.history ?? []).reduce((n, t) => n + (t.content?.length ?? 0), 0);

  let result: Awaited<ReturnType<typeof deepSearch>>;
  try {
    result = await deepSearch(q, registry, {
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      thinking: resolved.thinking,
      maxTokens: resolved.maxTokens,
      multiPass: resolved.multiPass,
      useRlm: resolved.useRlm,
      rlmMaxRounds: resolved.rlmMaxRounds,
      caseId: opts.caseId,
      history: opts.history,
      signal: opts.signal,
      onToken,
      onProgress,
      ...(opts.includeThoughts && opts.onThoughts ? { onThoughts: opts.onThoughts } : {}),
    });
  } catch (err) {
    const aborted = opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError');
    void recordRoutedCall({
      sessionId: opts.sessionId,
      tier,
      provider: resolved.provider,
      model: resolved.model ?? '',
      effort: resolved.effort,
      thinking: resolved.thinking,
      maxTokens: resolved.maxTokens,
      multiPass: resolved.multiPass,
      useRlm: resolved.useRlm,
      inputTokens: 0,
      outputTokens: estimateTokens(outputChars),
      tokensEstimated: true,
      ms: Date.now() - startedAt,
      documentIdsSent: [],
      presetUsed: plan.presetUsed,
      caseId: opts.caseId,
      status: aborted ? 'cancelled' : 'error',
      errorCode: (err as { code?: string })?.code ?? (aborted ? 'ABORTED' : 'EXECUTION_ERROR'),
    });
    throw err;
  }
  const finishedAt = Date.now();
  closePhase(finishedAt);

  // deepSearch returns the reranked source set in one go; it cannot tell a
  // retrieval hit from an RLM-discovered extra, so every item is tagged
  // 'retrieval' (rlmExtraSourceCount is reported in `rlm` instead).
  const evidence = sourcesToEvidence(result.sources, 'retrieval');
  if (evidence.length) opts.onEvidence?.(evidence);

  const documentIdsSent = documentIdsOf(result.sources);
  const sourceChars = result.sources.reduce((n, s) => n + (s.text?.length ?? 0), 0);
  const modelUsed = result.model || resolved.model || '';
  const providerUsed = result.provider || resolved.provider;

  const cost: ReportResult['cost'] = {
    provider: providerUsed,
    model: modelUsed,
    inputTokens: estimateTokens(q.length + historyChars + sourceChars),
    outputTokens: estimateTokens(result.report.length || outputChars),
    estimated: true,
  };

  const report: ReportResult = {
    profile: 'routed',
    query: q,
    report: result.report,
    routing: {
      requested: plan.requested,
      mode: tier,
      reason: plan.reason,
      confidence: plan.confidence,
      resolved,
      ...(plan.presetUsed ? { presetUsed: plan.presetUsed } : {}),
      ...(plan.clamps.length ? { ignored: plan.clamps } : {}),
    },
    subQueries: result.subQueries,
    evidence: opts.includeEvidence === false ? [] : evidence,
    ...(result.rlmAssisted
      ? { rlm: { rounds: rlmRoundsSeen, toolCalls: rlmToolCalls, notes: rlmNotes } }
      : {}),
    stats: {
      retrievals: result.searchStats.totalRetrieved,
      chunksFused: result.searchStats.uniqueAfterDedup,
      rerankPool: result.searchStats.finalAfterRerank,
      ms: finishedAt - startedAt,
      phases,
    },
    cost,
    provenance: { documentIdsSent, provider: providerUsed },
    modelsUsed: {
      decompose: modelUsed,
      rerank: 'n/a',
      rlm: result.rlmAssisted ? (result.rlmHost ? `ss-rlm@${result.rlmHost}` : 'ss-rlm') : 'n/a',
      outline: 'n/a',
      synthesis: modelUsed,
    },
  };

  // Provenance: fire-and-forget, never blocks or fails the report.
  void recordRoutedCall({
    sessionId: opts.sessionId,
    tier,
    provider: providerUsed,
    model: modelUsed,
    effort: resolved.effort,
    thinking: resolved.thinking,
    maxTokens: resolved.maxTokens,
    multiPass: resolved.multiPass,
    useRlm: resolved.useRlm,
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    tokensEstimated: true,
    ms: report.stats.ms,
    documentIdsSent,
    presetUsed: plan.presetUsed,
    caseId: opts.caseId,
    status: 'completed',
  });

  return report;
}
