/**
 * Starts a `research` job — the local evidence engine running under the
 * job pattern (REPORT-v2.1 Part D). Called by `POST /api/mcp/research`, by
 * `research_start`, and by `research_evidence` when it self-promotes a
 * `deep-rlm` request.
 *
 * Research jobs are evidence-only, so `localOnly` is always true here even
 * under the `routed` profile: nothing a research job does leaves the
 * machine. The profile is still recorded on the job for the status view.
 */

import type { ResearchJobStatusView, McpProfile } from '../research-types';
import { startJob } from '../research-jobs';
import { McpError } from '../llm-policy';
import { parseResearchParams } from './research-params';

export interface StartResearchJobInput {
  query: string;
  profile: McpProfile;
  sessionId?: string;
  params?: Record<string, unknown>;
}

export async function startResearchJob(input: StartResearchJobInput): Promise<ResearchJobStatusView> {
  const query = typeof input.query === 'string' ? input.query.trim() : '';
  if (!query) throw new McpError('INVALID_PARAMS', 'query is required');

  // Parse (and validate) before the job exists so a bad request fails the
  // call, not the job.
  const { options, ignored } = await parseResearchParams(input.params);

  // Lazy imports keep this module free of the registry ↔ tools import cycle
  // (tools/index.ts → research tools → here → get-tool-registry → tools/index.ts).
  const [{ getToolRegistry }, { gatherEvidence }] = await Promise.all([
    import('../get-tool-registry'),
    import('../../search/gather-evidence'),
  ]);
  const registry = await getToolRegistry();

  return startJob({
    kind: 'research',
    profile: input.profile,
    query,
    sessionId: input.sessionId,
    run: async (job) => {
      const result = await gatherEvidence(query, registry, {
        ...options,
        profile: input.profile,
        localOnly: true,
        ignored,
        sessionId: input.sessionId,
        signal: job.signal,
        onProgress: job.progress,
        onEvidence: job.evidence,
        onThoughts: job.thoughts,
      });
      for (const note of result.rlm?.notes ?? []) job.rlmNote(note);
      if (result.outline) job.setOutline(result.outline);
      return result;
    },
  });
}
