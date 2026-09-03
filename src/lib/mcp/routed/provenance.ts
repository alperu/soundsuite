/**
 * Provenance logging for the `routed` profile (REPORT-v2.1 Part B.4, work
 * item 11).
 *
 * Every routed call writes one `ActionLog` row (`logType: 'mcp-routed'`)
 * recording which tier ran, on which provider/model, with what settings, how
 * many tokens went in/out, how long it took, and — the part that matters —
 * the `documentId`s whose text left the machine.
 *
 * `detail` never contains the query text or any document text. Only ids,
 * settings and counts.
 */

import { prisma } from '../../db/prisma';
import { createLogger } from '../../logger';
import type { EffortLevel, ResearchTier } from '../research-types';

const logger = createLogger('McpProvenance');

export const ROUTED_LOG_TYPE = 'mcp-routed';
export const ROUTED_ACTION = 'mcp-routed-call';

export interface RoutedCallRecord {
  sessionId?: string;
  tier: ResearchTier;
  provider: string;
  model: string;
  effort?: EffortLevel;
  thinking?: boolean;
  maxTokens?: number;
  multiPass?: boolean;
  useRlm?: boolean;
  inputTokens: number;
  outputTokens: number;
  /** True when token counts are a chars/3.2 estimate, not provider usage. */
  tokensEstimated?: boolean;
  ms: number;
  documentIdsSent: string[];
  presetUsed?: string;
  caseId?: string;
  /**
   * Accepted for signature parity with the spec but deliberately NOT
   * persisted — the query is case-identifying text.
   */
  query?: string;
  status?: 'completed' | 'error' | 'cancelled';
  errorCode?: string;
}

/** The exact object serialised into `ActionLog.detail`. Exported for tests. */
export function toDetail(rec: RoutedCallRecord): Record<string, unknown> {
  return {
    tier: rec.tier,
    provider: rec.provider,
    model: rec.model,
    ...(rec.effort ? { effort: rec.effort } : {}),
    ...(rec.thinking !== undefined ? { thinking: rec.thinking } : {}),
    ...(rec.maxTokens !== undefined ? { maxTokens: rec.maxTokens } : {}),
    ...(rec.multiPass !== undefined ? { multiPass: rec.multiPass } : {}),
    ...(rec.useRlm !== undefined ? { useRlm: rec.useRlm } : {}),
    inputTokens: rec.inputTokens,
    outputTokens: rec.outputTokens,
    ...(rec.tokensEstimated ? { tokensEstimated: true } : {}),
    ms: rec.ms,
    documentIdsSent: Array.from(new Set(rec.documentIdsSent)),
    documentCount: new Set(rec.documentIdsSent).size,
    ...(rec.presetUsed ? { presetUsed: rec.presetUsed } : {}),
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
    ...(rec.errorCode ? { errorCode: rec.errorCode } : {}),
    queryChars: rec.query ? rec.query.length : undefined,
  };
}

/** Write the row. Resolves to the row id, or null on failure (never throws). */
export async function recordRoutedCall(rec: RoutedCallRecord): Promise<string | null> {
  try {
    const row = await prisma.actionLog.create({
      data: {
        ...(rec.caseId ? { caseId: rec.caseId } : {}),
        action: ROUTED_ACTION,
        target: `${rec.provider}/${rec.model}`,
        status: rec.status ?? 'completed',
        logType: ROUTED_LOG_TYPE,
        detail: JSON.stringify(toDetail(rec)),
      },
    });
    return row.id;
  } catch (err) {
    logger.warn('failed to write mcp-routed provenance row', {
      error: err instanceof Error ? err.message : String(err),
      tier: rec.tier,
      provider: rec.provider,
    });
    return null;
  }
}
