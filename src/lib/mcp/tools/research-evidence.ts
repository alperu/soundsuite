/**
 * `research_evidence` (sync) and `research_start` (async) — the entry points
 * of the local evidence engine (docs/tasks/06-mcp-two-profiles.md, item 6).
 *
 * Both return evidence, never prose, and both run local-only regardless of
 * profile: retrieval, rerank, RLM rounds and the outline all stay on this
 * machine. Under `routed` the same tools exist so a client can gather
 * evidence cheaply before deciding whether to spend a `report_*` call.
 */

import { BaseMCPTool } from './base-tool';
import type { ToolMetadata, ToolDependency, ToolExecutionContext, ToolConfigEntry } from '../tool-types';
import type { EvidenceResult, ResearchJobStatusView, McpProfile } from '../research-types';
import { EVIDENCE_DEFAULTS } from '../research-types';
import { estimateResearchSeconds } from '../research/estimate';
import { McpError } from '../llm-policy';
import { ollamaAvailable } from '../shared-dependencies';
import { parseResearchParams } from '../research/research-params';
import { startResearchJob } from '../research/start-research-job';

export const RESEARCH_INPUT_SCHEMA: ToolMetadata['inputSchema'] = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'The research question. Natural language; `{{ … }}` scope chips are honoured.',
    },
    caseId: {
      type: 'string',
      description: 'Restrict retrieval to one case (Case id).',
    },
    mode: {
      type: 'string',
      enum: ['auto', 'fast', 'deep', 'deep-report', 'deep-rlm'],
      description:
        'Retrieval tier. `auto` (default) lets the query router choose. `fast`: one retrieval on the query as written, no outline. `deep` / `deep-report`: LLM decomposition into sub-queries, rerank, outline. `deep-rlm`: adds recursive RLM evidence rounds on the sidecar — always runs as a job.',
    },
    whereClauses: {
      type: 'array',
      description: 'Extra SQL-style filters applied to every retrieval (advanced).',
      items: { type: 'string' },
    },
    maxEvidence: {
      type: 'integer',
      description: `Cap on the returned evidence list (default ${EVIDENCE_DEFAULTS.maxEvidence}). Same as retrieval.maxEvidence; this wins if both are given.`,
    },
    maxCharsPerChunk: {
      type: 'integer',
      description: `Cap on each chunk's text, truncated on a word boundary (default ${EVIDENCE_DEFAULTS.maxCharsPerChunk}). Same as retrieval.maxCharsPerChunk; this wins if both are given.`,
    },
    retrieval: {
      type: 'object',
      description: 'Retrieval knobs — the only settings the local engine honours.',
      properties: {
        rerankPoolSize: { type: 'integer', description: 'Candidates sent to the reranker (default: configured pool size, 150).' },
        limitPerSubQuery: { type: 'integer', description: 'Chunks fetched per sub-query (default 50).' },
        rlmMaxRounds: { type: 'integer', description: 'RLM tool-use rounds for deep-rlm (default 2).' },
        maxEvidence: { type: 'integer', description: `Cap on the returned evidence list (default ${EVIDENCE_DEFAULTS.maxEvidence}).` },
        maxCharsPerChunk: { type: 'integer', description: `Cap on each chunk's text (default ${EVIDENCE_DEFAULTS.maxCharsPerChunk}); longer chunks are cut at a word boundary with an ellipsis.` },
        decomposeTimeoutMs: { type: 'integer', description: 'Budget for the LLM decomposition step in ms (default 20000); on expiry a keyword split is used.' },
        outlineTimeoutMs: { type: 'integer', description: 'Budget for the LLM outline step in ms; on expiry the result carries outline: null.' },
      },
    },
    history: {
      type: 'array',
      description: 'Prior conversation turns, for follow-up questions.',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['user', 'assistant'] },
          content: { type: 'string' },
        },
        required: ['role', 'content'],
      },
    },
    preset: {
      description:
        'A saved preset name or an inline preset object. Only its `retrieval` section is used; any routing, provider, model, effort or thinking fields are IGNORED here and listed in routing.ignored[].',
      oneOf: [{ type: 'string' }, { type: 'object' }],
    },
  },
  required: ['query'],
};

/** Ollama must be reachable: decomposition and the outline run there. */
export function localLlmDependency(): ToolDependency {
  return {
    key: 'localLlm',
    label: 'Local LLM (Ollama)',
    required: true,
    check: () => ollamaAvailable(),
  };
}

export interface ResearchToolParams {
  query: string;
  caseId?: string;
  mode?: string;
  retrieval?: Record<string, unknown>;
  history?: Array<{ role: string; content: string }>;
  preset?: string | Record<string, unknown>;
  [k: string]: unknown;
}

export interface ResearchPromotedResult {
  promoted: true;
  jobId: string;
  kind: 'research';
  status: ResearchJobStatusView['status'];
  hint: string;
}

function requireQuery(params: ResearchToolParams): string {
  const q = typeof params?.query === 'string' ? params.query.trim() : '';
  if (!q) throw new McpError('INVALID_PARAMS', 'query is required');
  return q;
}

/** Profile of the calling session; absent (internal caller) means local, fail-closed. */
function profileOf(context: ToolExecutionContext): McpProfile {
  return context.profile === 'routed' ? 'routed' : 'local';
}

// ---------------------------------------------------------------------------
// research_evidence — synchronous
// ---------------------------------------------------------------------------

export class ResearchEvidenceTool extends BaseMCPTool<ResearchToolParams, EvidenceResult | ResearchPromotedResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'research_evidence',
      displayName: 'Research Evidence',
      description:
        'Gather ranked evidence for a legal research question — decomposition, hybrid retrieval, keyword backstop, rerank and a sections→evidence outline. Returns EVIDENCE ONLY (chunks with citations, sub-queries, outline, gaps): it never writes a report or any prose — you write that from the evidence. Everything runs locally (Ollama, sidecar reranker, sidecar RLM); nothing leaves this machine. Any provider/model/routing fields in the request are ignored and reported in routing.ignored[]; unknown fields are rejected. Evidence is capped (defaults: ' + `${EVIDENCE_DEFAULTS.maxEvidence} items, ${EVIDENCE_DEFAULTS.maxCharsPerChunk} chars per chunk` + ') and the applied caps are reported in stats.caps — raise maxEvidence / maxCharsPerChunk if you need more. A request the router expects to run long is promoted to a job: poll research_status with the returned jobId.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: RESEARCH_INPUT_SCHEMA,
    };
  }

  getDependencies(): ToolDependency[] {
    return [localLlmDependency()];
  }

  validateParams(params: ResearchToolParams): void {
    requireQuery(params);
  }

  async executeImpl(params: ResearchToolParams, context: ToolExecutionContext, _config: ToolConfigEntry) {
    const query = requireQuery(params);
    const profile = profileOf(context);
    const { query: _q, ...rest } = params;
    const { options, ignored } = await parseResearchParams(rest);

    // Self-promotion: RLM rounds run for minutes, past any MCP call timeout.
    const { resolveResearchMode, gatherEvidence } = await import('../../search/gather-evidence');
    const routing = resolveResearchMode(query, options.mode);
    // Anything the shared estimator expects to outrun the caller's MCP timeout
    // becomes a job — not just deep-rlm, which was the only self-promoting
    // tier while `deep` sat 2.5 s under the proxy timeout (REPORT-v4 N-8).
    // Research is always local-only, whatever the session profile.
    const { wouldPromoteToJob } = estimateResearchSeconds(routing.mode, {
      localOnly: true,
      settings: { useRlm: routing.mode === 'deep-rlm' },
    });
    if (wouldPromoteToJob) {
      const job = await startResearchJob({ query, profile, sessionId: context.sessionId, params: rest });
      return {
        promoted: true as const,
        jobId: job.id,
        kind: 'research' as const,
        status: job.status,
        hint: `${routing.mode} runs longer than one MCP call allows — poll research_status { jobId: "${job.id}", cursor } for evidence as it arrives, then research_result`,
      };
    }

    const { getToolRegistry } = await import('../get-tool-registry');
    const registry = await getToolRegistry();
    return gatherEvidence(query, registry, {
      ...options,
      profile,
      localOnly: true,
      ignored,
      sessionId: context.sessionId,
    });
  }
}

// ---------------------------------------------------------------------------
// research_start — asynchronous
// ---------------------------------------------------------------------------

export interface ResearchStartResult {
  jobId: string;
  kind: 'research';
  status: ResearchJobStatusView['status'];
  startedAt: number;
}

export class ResearchStartTool extends BaseMCPTool<ResearchToolParams, ResearchStartResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'research_start',
      displayName: 'Research Start (job)',
      description:
        'Start an evidence-gathering job for a research question and return immediately with a jobId. Same pipeline and same evidence-only, local-only contract as research_evidence (no prose, nothing leaves the machine). Poll research_status { jobId, cursor } for phase, new evidence and RLM notes; fetch the final EvidenceResult with research_result; stop early with research_cancel.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: RESEARCH_INPUT_SCHEMA,
    };
  }

  getDependencies(): ToolDependency[] {
    return [localLlmDependency()];
  }

  validateParams(params: ResearchToolParams): void {
    requireQuery(params);
  }

  async executeImpl(params: ResearchToolParams, context: ToolExecutionContext, _config: ToolConfigEntry): Promise<ResearchStartResult> {
    const query = requireQuery(params);
    const { query: _q, ...rest } = params;
    const job = await startResearchJob({ query, profile: profileOf(context), sessionId: context.sessionId, params: rest });
    return { jobId: job.id, kind: 'research', status: job.status, startedAt: job.startedAt };
  }
}
