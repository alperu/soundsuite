/**
 * `research_status` / `research_result` / `research_cancel` — the polling
 * side of the research job pattern (REPORT-v2.1 Part D). Pure job-store
 * reads; no LLM, no retrieval, so no dependencies.
 */

import { BaseMCPTool } from './base-tool';
import type { ToolMetadata, ToolExecutionContext, ToolConfigEntry } from '../tool-types';
import type { EvidenceResult, ResearchJobStatusView } from '../research-types';
import { McpError } from '../llm-policy';
import { getJobStatus, getJobResult, cancelJob } from '../research-jobs';

function requireJobId(params: { jobId?: unknown }): string {
  const id = typeof params?.jobId === 'string' ? params.jobId.trim() : '';
  if (!id) throw new McpError('INVALID_PARAMS', 'jobId is required');
  return id;
}

function requireResearchJob(jobId: string): ResearchJobStatusView {
  const view = getJobStatus(jobId);
  if (!view || view.kind !== 'research') {
    throw new McpError('JOB_NOT_FOUND', `no research job "${jobId}" (jobs are kept 30 minutes after they finish)`);
  }
  return view;
}

const JOB_ID_PROP = { type: 'string', description: 'Job id returned by research_start or a promoted research_evidence call.' };

// ---------------------------------------------------------------------------

export class ResearchStatusTool extends BaseMCPTool<{ jobId: string; cursor?: number }, ResearchJobStatusView> {
  getMetadata(): ToolMetadata {
    return {
      name: 'research_status',
      displayName: 'Research Status',
      description:
        'Poll a research job. Returns status, current phase, the evidence items delivered since `cursor` (pass the returned cursor back next time to receive only new items), RLM notes, and the outline once it is ready. Evidence only — no prose.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: {
        type: 'object',
        properties: {
          jobId: JOB_ID_PROP,
          cursor: { type: 'integer', description: 'Evidence cursor from the previous research_status call (default 0 = everything so far).' },
        },
        required: ['jobId'],
      },
    };
  }

  validateParams(params: { jobId: string }): void {
    requireJobId(params);
  }

  async executeImpl(params: { jobId: string; cursor?: number }, _context: ToolExecutionContext, _config: ToolConfigEntry): Promise<ResearchJobStatusView> {
    const jobId = requireJobId(params);
    const cursor = typeof params.cursor === 'number' && Number.isFinite(params.cursor) ? Math.max(0, Math.floor(params.cursor)) : 0;
    const view = getJobStatus(jobId, cursor);
    if (!view || view.kind !== 'research') {
      throw new McpError('JOB_NOT_FOUND', `no research job "${jobId}" (jobs are kept 30 minutes after they finish)`);
    }
    return view;
  }
}

// ---------------------------------------------------------------------------

export class ResearchResultTool extends BaseMCPTool<{ jobId: string }, EvidenceResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'research_result',
      displayName: 'Research Result',
      description:
        'Fetch the final EvidenceResult of a finished research job (ranked evidence, sub-queries, outline, gaps, RLM notes, stats). Errors with JOB_RUNNING while the job is still in progress — poll research_status first.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: { type: 'object', properties: { jobId: JOB_ID_PROP }, required: ['jobId'] },
    };
  }

  validateParams(params: { jobId: string }): void {
    requireJobId(params);
  }

  async executeImpl(params: { jobId: string }, _context: ToolExecutionContext, _config: ToolConfigEntry): Promise<EvidenceResult> {
    const jobId = requireJobId(params);
    const view = requireResearchJob(jobId);
    switch (view.status) {
      case 'done': {
        const result = getJobResult(jobId);
        if (!result) throw new McpError('JOB_NOT_FOUND', `result of research job "${jobId}" is no longer available`);
        return result as EvidenceResult;
      }
      case 'queued':
      case 'running':
        throw new McpError('JOB_RUNNING', `research job "${jobId}" is still ${view.status}${view.phase ? ` (phase: ${view.phase})` : ''} — poll research_status`);
      case 'cancelled':
        throw new McpError('JOB_CANCELLED', `research job "${jobId}" was cancelled`);
      case 'error':
      default:
        throw new McpError('JOB_FAILED', `research job "${jobId}" failed: ${view.error ?? 'unknown error'}`);
    }
  }
}

// ---------------------------------------------------------------------------

export interface ResearchCancelResult {
  jobId: string;
  cancelled: boolean;
  status: ResearchJobStatusView['status'];
}

export class ResearchCancelTool extends BaseMCPTool<{ jobId: string }, ResearchCancelResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'research_cancel',
      displayName: 'Research Cancel',
      description: 'Cancel a running research job. Evidence already delivered stays readable via research_status; `cancelled: false` means the job had already finished.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: { type: 'object', properties: { jobId: JOB_ID_PROP }, required: ['jobId'] },
    };
  }

  validateParams(params: { jobId: string }): void {
    requireJobId(params);
  }

  async executeImpl(params: { jobId: string }, _context: ToolExecutionContext, _config: ToolConfigEntry): Promise<ResearchCancelResult> {
    const jobId = requireJobId(params);
    requireResearchJob(jobId);
    const cancelled = cancelJob(jobId);
    const after = getJobStatus(jobId);
    return { jobId, cancelled, status: after?.status ?? 'cancelled' };
  }
}
