/**
 * `research_report` and the `report_*` job tools for the `routed` profile
 * (REPORT-v2.1 Part B.3 / Part D, work item 10).
 *
 * - research_report — sync. Plans first; when the router estimates more than
 *   45 s it self-promotes to a job and returns `{ promoted: true, jobId }`
 *   instead of blocking the MCP call.
 * - report_start / report_status / report_result / report_cancel — async job
 *   surface. `report_status` carries `partialReport` (synthesis so far) and
 *   `cost`.
 */

import { BaseMCPTool } from './base-tool';
import type { ToolMetadata, ToolExecutionContext, ToolConfigEntry } from '../tool-types';
import type { ToolRegistry } from '../tool-registry';
import { McpError } from '../llm-policy';
import { cancelJob, getJobResult, getJobStatus } from '../research-jobs';
import type {
  PresetV2,
  ReportResult,
  ResearchJobStatus,
  ResearchJobStatusView,
  ResearchMode,
  TierSettings,
} from '../research-types';
import type { ConversationTurn } from '../../search/deep-search';
import { planReport, runReport } from '../routed/run-report';
import { PROMOTE_THRESHOLD_SECONDS } from '../routed/routing';
import { startReportJob } from '../routed/start-report-job';
import { MODE_SCHEMA, PRESET_REF_SCHEMA, TIER_SETTINGS_SCHEMA } from './routed-routing-explain';

const PROFILES: ToolMetadata['profiles'] = ['routed'];

export interface ReportRequestParams {
  query: string;
  caseId?: string;
  mode?: ResearchMode;
  preset?: string | PresetV2;
  overrides?: Partial<TierSettings>;
  history?: ConversationTurn[];
  includeEvidence?: boolean;
  includeThoughts?: boolean;
}

const REPORT_REQUEST_SCHEMA: ToolMetadata['inputSchema'] = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The research question' },
    caseId: { type: 'string', description: 'Restrict retrieval to one case' },
    mode: MODE_SCHEMA,
    preset: PRESET_REF_SCHEMA,
    overrides: { ...TIER_SETTINGS_SCHEMA, description: 'Per-call tier setting overrides (highest precedence)' },
    history: {
      type: 'array',
      description: 'Previous conversation turns for follow-up questions',
      items: {
        type: 'object',
        properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } },
        required: ['role', 'content'],
      },
    },
    includeEvidence: { type: 'boolean', description: 'Include the evidence items behind the report (default true)' },
    includeThoughts: { type: 'boolean', description: 'Stream model/RLM narration as thoughts (default false)' },
  },
  required: ['query'],
};

function requireQuery(params: { query?: unknown }): void {
  if (typeof params?.query !== 'string' || !params.query.trim()) {
    throw new McpError('INVALID_PARAMS', 'query is required');
  }
}

function requireJobId(params: { jobId?: unknown }): void {
  if (typeof params?.jobId !== 'string' || !params.jobId.trim()) {
    throw new McpError('INVALID_PARAMS', 'jobId is required');
  }
}

function toJobParams(p: ReportRequestParams): Record<string, unknown> {
  const { query: _q, ...rest } = p;
  return rest as Record<string, unknown>;
}

async function resolveRegistry(): Promise<ToolRegistry> {
  // Lazy import: tools/index → this file → get-tool-registry → tools/index
  // would otherwise be a load-time cycle.
  const { getToolRegistry } = await import('../get-tool-registry');
  return getToolRegistry();
}

/** Returned by `research_report` when it self-promotes to a job. */
export interface PromotedReport {
  promoted: true;
  jobId: string;
  kind: 'report';
  status: ResearchJobStatus;
  estimatedSeconds: number;
  hint: string;
}

// ---------------------------------------------------------------------------

export class ResearchReportTool extends BaseMCPTool<ReportRequestParams, ReportResult | PromotedReport> {
  getMetadata(): ToolMetadata {
    return {
      name: 'research_report',
      displayName: 'Research Report',
      description:
        'Full research pipeline with synthesis: route the question to a tier, run retrieval + rerank (+ RLM), and write a cited report with the provider/model the active preset maps to. Self-promotes to a background job (report_status / report_result) when the router expects the run to exceed ~45 s.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: REPORT_REQUEST_SCHEMA,
    };
  }

  validateParams(params: ReportRequestParams): void {
    requireQuery(params);
  }

  async executeImpl(
    params: ReportRequestParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ReportResult | PromotedReport> {
    const plan = await planReport(params.query, {
      sessionId: context.sessionId,
      mode: params.mode,
      preset: params.preset,
      overrides: params.overrides,
    });

    const registry = await resolveRegistry();

    if (plan.wouldPromoteToJob) {
      const job = await startReportJob({
        query: params.query,
        profile: 'routed',
        sessionId: context.sessionId,
        params: toJobParams(params),
        registry,
      });
      return {
        promoted: true,
        jobId: job.id,
        kind: 'report',
        status: job.status,
        estimatedSeconds: plan.estimatedSeconds,
        hint:
          `Estimated ${plan.estimatedSeconds}s (> ${PROMOTE_THRESHOLD_SECONDS}s) for tier "${plan.tier}" on ` +
          `${plan.resolved.provider}/${plan.resolved.model ?? ''}; started as a job. Poll report_status { jobId, cursor } ` +
          '(partialReport grows as synthesis streams), then report_result { jobId }.',
      };
    }

    return runReport(params.query, registry, {
      profile: 'routed',
      sessionId: context.sessionId,
      caseId: params.caseId,
      mode: params.mode,
      preset: params.preset,
      overrides: params.overrides,
      history: params.history,
      includeEvidence: params.includeEvidence !== false,
      includeThoughts: params.includeThoughts === true,
    });
  }
}

// ---------------------------------------------------------------------------

export class ReportStartTool extends BaseMCPTool<ReportRequestParams, ResearchJobStatusView> {
  getMetadata(): ToolMetadata {
    return {
      name: 'report_start',
      displayName: 'Start Report Job',
      description:
        'Start research_report as a background job and return its initial status. Poll report_status; fetch with report_result; abort with report_cancel.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: REPORT_REQUEST_SCHEMA,
    };
  }

  validateParams(params: ReportRequestParams): void {
    requireQuery(params);
  }

  async executeImpl(params: ReportRequestParams, context: ToolExecutionContext): Promise<ResearchJobStatusView> {
    const registry = await resolveRegistry();
    return startReportJob({
      query: params.query,
      profile: 'routed',
      sessionId: context.sessionId,
      params: toJobParams(params),
      registry,
    });
  }
}

// ---------------------------------------------------------------------------

export interface ReportStatusParams { jobId: string; cursor?: number }

export class ReportStatusTool extends BaseMCPTool<ReportStatusParams, ResearchJobStatusView> {
  getMetadata(): ToolMetadata {
    return {
      name: 'report_status',
      displayName: 'Report Job Status',
      description:
        'Status of a report job: phase, evidence since `cursor`, RLM notes, outline when ready, `partialReport` (synthesis text so far) and `cost`. Pass the returned cursor back to receive only new evidence.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          cursor: { type: 'number', description: 'Evidence cursor from the previous status call (default 0)' },
        },
        required: ['jobId'],
      },
    };
  }

  validateParams(params: ReportStatusParams): void {
    requireJobId(params);
  }

  async executeImpl(params: ReportStatusParams): Promise<ResearchJobStatusView> {
    const view = getJobStatus(params.jobId, typeof params.cursor === 'number' ? params.cursor : 0);
    if (!view || view.kind !== 'report') throw new McpError('NOT_FOUND', `report job "${params.jobId}" not found`);
    return view;
  }
}

// ---------------------------------------------------------------------------

export interface ReportResultParams { jobId: string }
export type ReportResultResponse =
  | ({ ready: true } & ReportResult)
  | { ready: false; jobId: string; status: ResearchJobStatus; error?: string; partialReport?: string };

export class ReportResultTool extends BaseMCPTool<ReportResultParams, ReportResultResponse> {
  getMetadata(): ToolMetadata {
    return {
      name: 'report_result',
      displayName: 'Report Job Result',
      description: 'The finished ReportResult of a report job. Returns { ready: false, status } while the job is still running or if it failed.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    };
  }

  validateParams(params: ReportResultParams): void {
    requireJobId(params);
  }

  async executeImpl(params: ReportResultParams): Promise<ReportResultResponse> {
    const view = getJobStatus(params.jobId);
    if (!view || view.kind !== 'report') throw new McpError('NOT_FOUND', `report job "${params.jobId}" not found`);
    const result = getJobResult(params.jobId) as ReportResult | null;
    if (view.status !== 'done' || !result) {
      return {
        ready: false,
        jobId: view.id,
        status: view.status,
        ...(view.error ? { error: view.error } : {}),
        ...(view.partialReport ? { partialReport: view.partialReport } : {}),
      };
    }
    return { ready: true, ...result };
  }
}

// ---------------------------------------------------------------------------

export interface ReportCancelParams { jobId: string }
export interface ReportCancelResult { jobId: string; cancelled: boolean; status: ResearchJobStatus }

export class ReportCancelTool extends BaseMCPTool<ReportCancelParams, ReportCancelResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'report_cancel',
      displayName: 'Cancel Report Job',
      description: 'Abort a running report job.',
      version: '1.0.0',
      category: 'search',
      profiles: PROFILES,
      inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
    };
  }

  validateParams(params: ReportCancelParams): void {
    requireJobId(params);
  }

  async executeImpl(params: ReportCancelParams): Promise<ReportCancelResult> {
    const before = getJobStatus(params.jobId);
    if (!before || before.kind !== 'report') throw new McpError('NOT_FOUND', `report job "${params.jobId}" not found`);
    const cancelled = cancelJob(params.jobId);
    const after = getJobStatus(params.jobId);
    return { jobId: params.jobId, cancelled, status: after?.status ?? before.status };
  }
}

// ---------------------------------------------------------------------------

export function getRoutedReportTools(): BaseMCPTool[] {
  return [
    new ResearchReportTool(),
    new ReportStartTool(),
    new ReportStatusTool(),
    new ReportResultTool(),
    new ReportCancelTool(),
  ];
}
