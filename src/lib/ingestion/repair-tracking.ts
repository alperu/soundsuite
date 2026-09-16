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
  | 'ocr-quality-rejected'
  | 'image-only'
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
  /** OCR found no text AND the ink check says the page is not blank. */
  inkedNoText?: boolean;
  /** OCR produced output and the quality gate discarded it. */
  ocrRejected?: boolean;
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
  // Checked before the "no text" codes, because it is the reason there
  // appears to be no text. OCR read the page and the gate threw the output
  // away: on real pages of a tax schedule it discarded 11,766-32,467
  // characters of correct text for a repetition loop, and two of those pages
  // later extracted at density 1132 and 1362. Calling that "image-only" or
  // "ocr-empty" blames the page for a model failure.
  if (input.ocrRejected) {
    return {
      code: 'ocr-quality-rejected',
      reason:
        'OCR read this page but its output was rejected by the quality gate (usually a repetition loop on a '
        + 'dense page). The page HAS text — OCR could not return it cleanly. Not a page defect: fix or change '
        + 'the OCR model and the page becomes indexable.',
    };
  }
  // A page that OCRs to nothing but carries ink is not a failure and not
  // blank — it is an image. Two real pages measured 32% and 74% ink coverage
  // with no extractable text, and the panel described them as "have extracted
  // text but produced no chunks - re-embedding is likely to fix them", which
  // is wrong in both halves. Terminal on the first attempt: the page has no
  // text, so no number of re-embeddings will produce a chunk.
  if (input.inkedNoText) {
    return {
      code: 'image-only',
      reason:
        'Image-only page: the page carries content but no extractable text '
        + '(OCR ran through every path and found none, and the page is too inked to be blank). '
        + 'Re-indexing cannot add it to the text index — it belongs to exhibit/image retrieval.',
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

/**
 * Retrying can never change the outcome.
 *
 * - `dimension-mismatch` is a config problem, not a page problem.
 * - `image-only` is a fact about the page: it carries ink but no text, so
 *   there is nothing for a text chunk to contain. Spending three attempts to
 *   rediscover that just delays telling the operator what the page is.
 */
export function isImmediatelyTerminal(code: RepairReasonCode): boolean {
  return code === 'dimension-mismatch' || code === 'image-only';
}

/**
 * Did this failure tell us anything about the PAGE?
 *
 * `reindex-request-failed` means the reindex call itself did not complete —
 * the embedding host was unreachable, the model was not pulled, a socket
 * timed out. That says nothing about the page, so it must not consume the
 * page's retry budget.
 *
 * It used to. A real page 8 was marked "given up after 3 attempts" with:
 *
 *   Ollama embedding failed (http://<lan-host>:11434,
 *   model=qwen3-embedding:4b-fp16): model not found, try pulling it first
 *
 * — the operator had switched embedding to OpenRouter-only and the repair
 * path was still routing to a local model that did not exist. Three attempts
 * burned on a misconfiguration, and once the routing was fixed the page
 * stayed permanently terminal: `remainingEligible: 0`, "re-indexing them
 * again cannot help". It took a manual resetTerminal to re-arm, after which
 * it repaired in 2.4 seconds.
 *
 * Left unfixed, every page attempted during any infrastructure outage stays
 * given-up forever, and Repair All Partials would skip them all and
 * cheerfully report nothing to do.
 *
 * Infinite retries are not the risk here: fix-partial does not loop, and the
 * batch runner stops a document as soon as a round makes no forward progress.
 */
export function isInfrastructureFailure(code: RepairReasonCode): boolean {
  // 'ocr-quality-rejected' belongs here for the same reason: the page is
  // fine, the OCR model is not. Spending the retry budget on it would leave
  // every dense page permanently given-up over a model that can be swapped.
  return code === 'reindex-request-failed' || code === 'ocr-quality-rejected';
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
    // An infrastructure failure is not evidence about the page, so it does
    // not spend the page's budget — see isInfrastructureFailure. The entry is
    // still written (the operator needs to see WHY nothing happened), it just
    // does not advance `attempts` or become terminal.
    const infra = isInfrastructureFailure(code);
    const attempts = infra ? (prior?.attempts ?? 0) : (prior?.attempts ?? 0) + 1;
    const terminal = infra
      ? false
      : isImmediatelyTerminal(code) || attempts >= MAX_REPAIR_ATTEMPTS;
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
