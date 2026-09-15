/**
 * Repair bookkeeping for the "Fix Partial" flow (task: fix-partial button).
 *
 * Persisted on `Document.tags.repair` — no schema migration, same pattern
 * draft-detector uses for `tags.recordStatus` (see ingestion-pipeline.ts
 * "draft-detection" stage). Keyed by page number (as a string, since JSON
 * object keys are always strings).
 *
 * Why this exists: re-embedding a page is not guaranteed to fix it. Some
 * pages have no extractable text (OCR quality gate rejected the output, or
 * the page is genuinely unreadable) and some failures are systemic (an
 * embedding-dimension mismatch means EVERY page in the batch will fail the
 * same way, no matter how many times you retry). Without a bound, a "fix"
 * button becomes a loop that reburns the same OCR/embedding cost forever
 * and never tells the operator why. This module decides, after each
 * attempt, whether a page is worth trying again.
 */

export const MAX_REPAIR_ATTEMPTS = 3;

export type RepairReasonCode =
  | 'ocr-empty'
  | 'dimension-mismatch'
  | 'reindex-request-failed'
  | 'unknown';

export interface RepairEntry {
  attempts: number;
  lastAttemptAt: string; // ISO timestamp
  reasonCode?: RepairReasonCode;
  reason?: string;
  /** Once true, this page is excluded from future auto-selection. */
  terminal?: boolean;
}

export type RepairTags = Record<string, RepairEntry>;

/** Safely pull the repair map out of a Document.tags JSON blob. */
export function readRepairTags(tags: unknown): RepairTags {
  if (!tags || typeof tags !== 'object') return {};
  const repair = (tags as Record<string, unknown>).repair;
  if (!repair || typeof repair !== 'object') return {};
  return repair as RepairTags;
}

/** Merge an updated repair map back into an existing tags blob without disturbing other keys. */
export function mergeRepairTags(existingTags: unknown, repair: RepairTags): Record<string, unknown> {
  const base = existingTags && typeof existingTags === 'object' ? { ...(existingTags as Record<string, unknown>) } : {};
  return { ...base, repair };
}

/**
 * Classify why a page is still unindexed after a fix attempt, using signals
 * the reindex-pages response already gives us — never a log grep.
 *
 * - requestError: the reindex-pages call itself failed (non-2xx / threw).
 *   Its message is checked for the dimension-mismatch signature
 *   (`dimensionMismatchError` in vector-store.ts / a LanceDB schema-width
 *   error) since that failure is systemic, not page-specific: retrying
 *   burns attempts for no reason, so callers should mark it terminal
 *   immediately (see `isImmediatelyTerminal`).
 * - stillEmptyAfterOcr: the page came back in reindex-pages' own
 *   `emptyPages` array — every extraction path (embedded image OCR,
 *   full-page render OCR) ran and produced no text.
 * - otherwise: the request succeeded, the page wasn't reported empty, but
 *   page-report still shows it unindexed (e.g. chunking/insert dropped it).
 */
export function classifyRepairFailure(input: {
  requestError?: string;
  stillEmptyAfterOcr?: boolean;
}): { code: RepairReasonCode; reason: string } {
  if (input.requestError) {
    if (/dimension/i.test(input.requestError)) {
      return {
        code: 'dimension-mismatch',
        reason: `Embedding dimension mismatch — reindexing cannot fix this until the embedding model/config is corrected: ${truncate(input.requestError)}`,
      };
    }
    return {
      code: 'reindex-request-failed',
      reason: `Reindex request failed: ${truncate(input.requestError)}`,
    };
  }
  if (input.stillEmptyAfterOcr) {
    return {
      code: 'ocr-empty',
      reason: 'OCR produced no text after all extraction attempts (quality gate rejected the output or the page has no readable content)',
    };
  }
  return {
    code: 'unknown',
    reason: 'Re-embedded successfully but the page still did not appear in the index',
  };
}

/** Dimension mismatches are a config problem, not a page problem — retrying never helps. */
export function isImmediatelyTerminal(code: RepairReasonCode): boolean {
  return code === 'dimension-mismatch';
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export interface RepairUpdateResult {
  tags: RepairTags;
  /** Pages that are indexed/empty now and had their history cleared. */
  cleared: number[];
  /** Pages that failed again this round but stayed under the retry bound. */
  retriable: number[];
  /** Pages that just crossed the bound (or hit an immediately-terminal reason) this round. */
  newlyTerminal: number[];
}

/**
 * Update repair bookkeeping after one fix attempt.
 *
 * @param existing        Current repair map (before this attempt).
 * @param attemptedPages   Pages that were included in this fix-partial call.
 * @param stillUnindexed   Subset of attemptedPages that are still unindexed
 *                          per the post-attempt page-report.
 * @param reasonFor         Reason classifier for a still-unindexed page.
 * @param now                Injectable clock for tests.
 */
export function updateRepairTags(
  existing: RepairTags,
  attemptedPages: number[],
  stillUnindexed: ReadonlySet<number>,
  reasonFor: (page: number) => { code: RepairReasonCode; reason: string },
  now: () => Date = () => new Date(),
): RepairUpdateResult {
  const tags: RepairTags = { ...existing };
  const cleared: number[] = [];
  const retriable: number[] = [];
  const newlyTerminal: number[] = [];

  for (const page of attemptedPages) {
    const key = String(page);
    if (!stillUnindexed.has(page)) {
      if (tags[key]) {
        delete tags[key];
        cleared.push(page);
      }
      continue;
    }

    const prior = tags[key];
    const { code, reason } = reasonFor(page);
    const attempts = (prior?.attempts ?? 0) + 1;
    const terminal = isImmediatelyTerminal(code) || attempts >= MAX_REPAIR_ATTEMPTS;
    tags[key] = {
      attempts,
      lastAttemptAt: now().toISOString(),
      reasonCode: code,
      reason,
      terminal,
    };
    if (terminal) newlyTerminal.push(page);
    else retriable.push(page);
  }

  return { tags, cleared, retriable, newlyTerminal };
}

/** Split a set of unindexed pages into ones worth attempting vs. already given up on. */
export function partitionEligiblePages(
  unindexedPages: number[],
  repair: RepairTags,
): { eligible: number[]; terminal: Array<{ page: number; attempts: number; reason?: string }> } {
  const eligible: number[] = [];
  const terminal: Array<{ page: number; attempts: number; reason?: string }> = [];
  for (const page of unindexedPages) {
    const entry = repair[String(page)];
    if (entry?.terminal) {
      terminal.push({ page, attempts: entry.attempts, reason: entry.reason });
    } else {
      eligible.push(page);
    }
  }
  return { eligible, terminal };
}
