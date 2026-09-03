/**
 * Starts a `report` job (profile `routed` LLM router) from an HTTP body
 * (`POST /api/mcp/report`) or the `report_start` / `research_report` tools
 * (work item 10).
 *
 * The job wraps `runReport`: synthesis tokens go to `job.token` (accumulated
 * as `partialReport`), progress/thoughts/evidence to their channels, and the
 * resolved plan stamps an early `cost` row so `report_status` can show the
 * provider/model before the first token arrives.
 */

import type { ConversationTurn } from '../../search/deep-search';
import type { ToolRegistry } from '../tool-registry';
import { McpError } from '../llm-policy';
import { startJob } from '../research-jobs';
import type { McpProfile, PresetV2, ResearchJobStatusView, ResearchMode, TierSettings } from '../research-types';
import { runReport } from './run-report';

export interface StartReportJobInput {
  query: string;
  profile: McpProfile;
  sessionId?: string;
  params?: Record<string, unknown>;
  /** Injected by tools that already hold the registry; HTTP callers omit it. */
  registry?: ToolRegistry;
}

const MODES: ResearchMode[] = ['auto', 'fast', 'deep', 'deep-report', 'deep-rlm'];

function pickMode(v: unknown): ResearchMode | undefined {
  return typeof v === 'string' && (MODES as string[]).includes(v) ? (v as ResearchMode) : undefined;
}

function pickHistory(v: unknown): ConversationTurn[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const turns = v.filter(
    (t): t is ConversationTurn =>
      !!t && typeof t === 'object' && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string',
  );
  return turns.length ? turns : undefined;
}

export async function startReportJob(input: StartReportJobInput): Promise<ResearchJobStatusView> {
  if (input.profile !== 'routed') {
    throw new McpError('POLICY_VIOLATION', 'report jobs require profile "routed"');
  }
  const query = input.query.trim();
  if (!query) throw new McpError('INVALID_PARAMS', 'query is required');

  const p = input.params ?? {};
  const registry = input.registry ?? (await (await import('../get-tool-registry')).getToolRegistry());

  return startJob({
    kind: 'report',
    profile: 'routed',
    query,
    sessionId: input.sessionId,
    run: (job) =>
      runReport(query, registry, {
        profile: 'routed',
        sessionId: input.sessionId,
        caseId: typeof p.caseId === 'string' ? p.caseId : undefined,
        mode: pickMode(p.mode),
        preset: typeof p.preset === 'string' || (p.preset && typeof p.preset === 'object')
          ? (p.preset as string | PresetV2)
          : undefined,
        overrides: p.overrides && typeof p.overrides === 'object' ? (p.overrides as Partial<TierSettings>) : undefined,
        history: pickHistory(p.history),
        includeEvidence: p.includeEvidence !== false,
        includeThoughts: p.includeThoughts === true,
        signal: job.signal,
        onToken: (t) => job.token(t),
        onProgress: (pr) => job.progress(pr),
        onThoughts: (t) => job.thoughts(t),
        onEvidence: (items) => job.evidence(items),
        onPlan: (plan) => {
          job.progress({
            phase: 'routing',
            message: `tier ${plan.tier} → ${plan.resolved.provider}/${plan.resolved.model ?? ''} (${plan.reason})`,
            detail: { tier: plan.tier, resolved: plan.resolved, clamps: plan.clamps, presetUsed: plan.presetUsed },
          });
          job.setCost({
            provider: plan.resolved.provider,
            model: plan.resolved.model ?? '',
            inputTokens: 0,
            outputTokens: 0,
            estimated: true,
          });
        },
      }).then((result) => {
        job.setCost(result.cost);
        if (result.outline) job.setOutline(result.outline);
        return result;
      }),
  });
}
