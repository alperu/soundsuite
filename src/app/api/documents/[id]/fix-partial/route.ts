/**
 * POST /api/documents/[id]/fix-partial
 *
 * The actuator behind the PARTIAL badge: find the pages of an INDEXED
 * document that genuinely have no vectors, re-embed the ones still worth
 * attempting, then re-verify and record *why* anything that failed failed.
 *
 * Three things this route deliberately does NOT do:
 *
 * 1. **It does not define "partial" or "unindexed" itself.** There were
 *    already two conflicting definitions in the repo (src/app/page.tsx and
 *    /api/documents/partial-status count distinct page_number values in
 *    LanceDB against pageCount with *no* allowance for blank-by-design
 *    pages; /api/vectors/page-report classifies per page as
 *    empty | indexed | unindexed and is the correct one). A third copy here
 *    would be a third thing to keep in sync, so page selection delegates to
 *    page-report's GET handler in-process and takes only `status ===
 *    'unindexed'` — never `!== 'indexed'`, which would drag 'empty' pages
 *    back in and recreate exactly the unfixable retry loop this route
 *    exists to kill. `computePartialDocumentIds` (the batched, badge-level
 *    counterpart of the same rule) is used as a liveness probe and to answer
 *    "will the badge actually clear?", not to pick pages.
 *
 * 2. **It does not reimplement reindexing.** The repair itself is delegated
 *    to POST /api/documents/[id]/reindex-pages — 500 lines of extraction,
 *    OCR fallback, chunking, embedding and vector replacement that already
 *    publishes progress to `soundsuite:doc_progress:<id>` and emits
 *    `document_status_changed`, so the existing document-card progress UI
 *    works for free. Both calls are in-process (the repo already imports
 *    across route modules, e.g. `commitEntity` from
 *    `@/app/api/haystack/[op]/route`) rather than self-HTTP: no reliance on
 *    `nextUrl.origin` being right behind a proxy, and no second
 *    serialization of a page report that can be 1400 entries long.
 *
 * 3. **It does not loop.** One invocation attempts at most `maxPages` pages
 *    (default 50; the largest real gap on this corpus is 45) in a single
 *    delegated call, with `statusAfterSuccess: 'INDEXED'`. That is what
 *    keeps FIXING_PARTIAL from becoming a trap: reindex-pages restores the
 *    *previous* status on failure, so if a batch runner ever passed
 *    `statusAfterSuccess: 'FIXING_PARTIAL'` for a non-final batch, a crash
 *    would strand the document in FIXING_PARTIAL with no orchestrator left
 *    alive to clear it. Here the document is always on its way back to
 *    INDEXED, and the response reports `remainingEligible` so the caller can
 *    simply POST again.
 *
 * Retry bounding lives in `@/lib/ingestion/repair-tracking` and persists on
 * the existing `Document.tags.repair` JSON key — no schema change, no
 * migration (`Document.status` is a plain String too, so 'FIXING_PARTIAL'
 * needs none either).
 */

import { NextRequest, NextResponse } from 'next/server';
import * as lancedb from '@lancedb/lancedb';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logger';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import {
  computePartialDocumentIds,
  type PartialDetectionPrisma,
} from '@/lib/ingestion/partial-detection';
import {
  MAX_REPAIR_ATTEMPTS,
  classifyRepairFailure,
  mergeRepairTags,
  partitionEligiblePages,
  readRepairTags,
  updateRepairTags,
  type RepairReasonCode,
  type RepairTags,
} from '@/lib/ingestion/repair-tracking';
import { GET as pageReportGET } from '@/app/api/vectors/page-report/route';
import { POST as reindexPagesPOST } from '@/app/api/documents/[id]/reindex-pages/route';

const logger = createLogger('fix-partial');

/** Status the document wears while a repair is in flight. Plain String column — no migration. */
const FIXING_STATUS = 'FIXING_PARTIAL';
/** Only an INDEXED document can be "partial" — every other status is a different problem. */
const REPAIRABLE_STATUS = 'INDEXED';

const DEFAULT_MAX_PAGES = 50;
const HARD_MAX_PAGES = 200;

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = process.env.LANCEDB_TABLE || 'chunks';

// ---------------------------------------------------------------------------
// Page report (in-process reuse of the canonical per-page classifier)
// ---------------------------------------------------------------------------

type PageStatus = 'indexed' | 'unindexed' | 'empty';

interface PageReportPage {
  pageNumber: number;
  status: PageStatus;
  chunkCount: number;
}

interface PageReport {
  totalPages: number;
  pages: PageReportPage[];
  summary: {
    indexedPages: number;
    unindexedPages: number;
    emptyPages?: number;
    totalChunks: number;
  };
}

async function fetchPageReport(documentId: string): Promise<PageReport> {
  // page-report's GET only ever touches `request.nextUrl.searchParams`, so a
  // URL-shaped stand-in is the whole contract (same duck-typing the repo's
  // own route tests use).
  const url = new URL(`http://internal/api/vectors/page-report?documentId=${encodeURIComponent(documentId)}`);
  const res = await pageReportGET({ nextUrl: url } as unknown as NextRequest);
  const body = await res.json();
  if (res.status !== 200) {
    throw new Error(body?.error?.message || `page-report failed with HTTP ${res.status}`);
  }
  return body as PageReport;
}

function unindexedPageNumbers(report: PageReport): number[] {
  // `status === 'unindexed'` ONLY. 'empty' pages are blank by design: there
  // is no text on them to embed, so re-embedding can never close that gap.
  return report.pages.filter((p) => p.status === 'unindexed').map((p) => p.pageNumber);
}

// ---------------------------------------------------------------------------
// Failure-message normalization
// ---------------------------------------------------------------------------

/**
 * `classifyRepairFailure` short-circuits a systemic embedding-width failure
 * to terminal-on-first-attempt by matching /dimension/i against the reindex
 * error. That word only ever appears on the *search* path though
 * (`dimensionMismatchError`, vector-store.ts): `VectorStore.insertChunks`
 * has no width branch and rethrows `Failed to insert chunks: <raw LanceDB
 * message>`, so a 2560-dim model writing into the 1024-wide `chunks` table
 * would classify as a generic request failure and burn all three attempts.
 *
 * This bridges that gap conservatively — it requires BOTH the insert-path
 * wrapper AND an Arrow fixed-width signature before relabelling, because the
 * two errors are asymmetric: over-matching marks a page terminal on attempt
 * #1 and needs a manual `resetTerminal`, while under-matching merely spends
 * two extra attempts. Under-matching is the cheaper mistake, so the patterns
 * stay narrow rather than guessing at LanceDB message text.
 */
const INSERT_PATH_SIGNATURE = /failed to insert chunks/i;
const VECTOR_WIDTH_SIGNATURE = /fixed[_\s-]?size[_\s-]?list|list<\s*item\s*:\s*float(?:32|64)?\s*>\s*\[\s*\d+\s*\]/i;

function normalizeFailureMessage(message: string): string {
  if (/dimension/i.test(message)) return message;
  if (INSERT_PATH_SIGNATURE.test(message) && VECTOR_WIDTH_SIGNATURE.test(message)) {
    return `Embedding dimension mismatch (vector width rejected on insert): ${message}`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * One page's repair outcome.
 *
 * `stillFailing` and `terminal` are returned as arrays of these rather than
 * bare counts, deliberately: the whole point of the feature is that an
 * operator sees "page 47: 3 attempts, OCR produced no text" instead of a
 * button that silently does nothing. Consumers that only want a number read
 * `.length` (or the explicit `stillFailingCount` / `terminalCount` fields).
 */
interface PageOutcome {
  page: number;
  attempts: number;
  reasonCode: RepairReasonCode | 'unknown';
  reason?: string;
}

/**
 * `partitionEligiblePages` returns `{ page, attempts, reason }` — it does not
 * carry the machine-readable code, which is what a caller wants to group by,
 * so join it back off the repair map here.
 */
function withReasonCodes(
  entries: Array<{ page: number; attempts: number; reason?: string }>,
  repair: RepairTags,
): PageOutcome[] {
  return entries.map((e) => ({
    page: e.page,
    attempts: e.attempts,
    reasonCode: repair[String(e.page)]?.reasonCode ?? 'unknown',
    reason: e.reason ?? repair[String(e.page)]?.reason,
  }));
}

function countByReasonCode(entries: PageOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.reasonCode] = (counts[e.reasonCode] ?? 0) + 1;
  return counts;
}

/**
 * Does the badge still light up? This is the doc-level counterpart of the
 * per-page rule (same blank-page allowance), so it answers the question the
 * operator actually asked. It throws rather than failing open, so callers own
 * the try/catch; `null` means "could not determine", never "fine".
 */
async function isStillPartial(documentId: string, pageCount: number): Promise<boolean | null> {
  try {
    const partial = await computePartialDocumentIds([{ id: documentId, pageCount }], {
      // The real client is structurally incompatible with the narrow port
      // (Prisma's Exact<> generics); the cast is what keeps tsc at baseline.
      prisma: prisma as unknown as PartialDetectionPrisma,
      lancedb,
      lancedbPath: LANCEDB_PATH,
    });
    return partial.has(documentId);
  } catch (err) {
    logger.warn('Partial re-check failed', { documentId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Is the vector index readable at all?
 *
 * A liveness check about the INDEX, asked of the index — not inferred from
 * one document's chunk count. `countRows()` with no filter is the cheapest
 * question that distinguishes the three states that matter:
 *
 *   connect/open throws  -> LanceDB unreachable            -> refuse
 *   table absent         -> nothing has ever been indexed  -> refuse
 *   table present, rows  -> index is alive                 -> proceed
 *
 * A live index with zero rows corpus-wide is indistinguishable from a broken
 * one from here, and on a system whose dashboard shows 91 indexed documents
 * it means something is wrong, so that also refuses.
 */
async function probeIndexHealth(): Promise<{ ok: true; totalRows: number } | { ok: false; reason: string }> {
  try {
    const db = await lancedb.connect(LANCEDB_PATH);
    const tables = await db.tableNames();
    if (!tables.includes(TABLE_NAME)) {
      return {
        ok: false,
        reason: `The vector index has no "${TABLE_NAME}" table — refusing to queue a repair against an index that cannot be read.`,
      };
    }
    const table = await db.openTable(TABLE_NAME);
    const totalRows = await table.countRows();
    if (totalRows === 0) {
      return {
        ok: false,
        reason: 'The vector index is empty (zero rows for every document) — refusing to queue a repair against an index that looks unreadable rather than merely incomplete.',
      };
    }
    return { ok: true, totalRows };
  } catch (err) {
    return {
      ok: false,
      reason: `Could not read the vector index (${err instanceof Error ? err.message : String(err)}) — refusing to queue a repair.`,
    };
  }
}

function sanitizePageList(pages: unknown, pageCount: number): number[] | null {
  if (!Array.isArray(pages)) return null;
  const out = new Set<number>();
  for (const p of pages) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1 && n <= pageCount) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdminApiAccess(request, 'documents/fix-partial');
  if (denied) return denied;

  const { id } = await params;
  let claimedStatus = false;

  try {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const maxPages = Math.max(
      1,
      Math.min(HARD_MAX_PAGES, Number.isFinite(Number(body?.maxPages)) ? Number(body.maxPages) : DEFAULT_MAX_PAGES),
    );
    const forceOcr = body?.forceOcr === true;
    const dryRun = body?.dryRun === true;
    /**
     * Operator escape hatch: clear the repair history for this document's
     * currently-unindexed pages before partitioning. Needed because a
     * terminal verdict is permanent by design — after fixing the underlying
     * cause (e.g. correcting an embedding model width) there would otherwise
     * be no way to re-arm those pages.
     */
    const resetTerminal = body?.resetTerminal === true;

    const doc = await prisma.document.findUnique({
      where: { id },
      // updatedAt backs the stale-lock check below: a live repair touches it
      // every round, so a quiet FIXING_PARTIAL document is an abandoned lock.
      select: { id: true, caseId: true, pageCount: true, status: true, tags: true, updatedAt: true },
    });
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const pageCount = doc.pageCount ?? 0;
    if (pageCount <= 0) {
      return NextResponse.json(
        { error: 'Document has no page count — it has not been extracted yet, so there is nothing to repair' },
        { status: 400 },
      );
    }

    // Repair is a read-modify-write on a JSON blob and is therefore not
    // atomic: two concurrent runs would clobber each other's repair map (and
    // double-charge OCR). The FIXING_PARTIAL status is the lock.
    //
    // A lock with no owner is a dead end, though. reindex-pages restores the
    // previous status on both success and throw, but neither runs if the
    // process holding the lock simply goes away — and that has happened
    // twice: once when a batch driver was killed, and once when a client's
    // body timeout aborted the SSE run mid-document. The document then sits
    // in FIXING_PARTIAL and every subsequent repair is refused with 409
    // forever, which is precisely the "it says fixing and nothing happens"
    // report that started this work.
    //
    // So: only honour the lock while someone is demonstrably holding it.
    // Freshness is judged by `updatedAt`, which reindex-pages touches at the
    // start of every round (rounds are 8 pages, and the slowest single page
    // measured 107s) — so a genuinely active repair is never this quiet.
    if (doc.status === FIXING_STATUS) {
      const heldForMs = Date.now() - new Date(doc.updatedAt).getTime();
      const STALE_LOCK_MS = Number(process.env.FIX_PARTIAL_STALE_LOCK_MS) || 10 * 60_000;
      if (!Number.isFinite(heldForMs) || heldForMs < STALE_LOCK_MS) {
        return NextResponse.json(
          {
            error: 'A repair is already running for this document',
            status: doc.status,
            heldForMs: Number.isFinite(heldForMs) ? heldForMs : undefined,
          },
          { status: 409 },
        );
      }
      logger.warn('Reclaiming a stale FIXING_PARTIAL lock — no progress for longer than the stale window', {
        documentId: id,
        heldForMinutes: Math.round(heldForMs / 60_000),
        staleWindowMinutes: Math.round(STALE_LOCK_MS / 60_000),
      });
      // Hand the rest of the route an INDEXED document, so the normal path
      // (including restoring the status afterwards) applies unchanged.
      doc.status = REPAIRABLE_STATUS;
    }
    if (doc.status !== REPAIRABLE_STATUS) {
      return NextResponse.json(
        {
          error: `Only ${REPAIRABLE_STATUS} documents can be repaired — this one is ${doc.status}`,
          status: doc.status,
        },
        { status: 409 },
      );
    }

    // --- 1. Which pages are genuinely unindexed? -------------------------
    let report: PageReport;
    try {
      report = await fetchPageReport(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Page report failed; refusing to queue a repair', { documentId: id, error: message });
      return NextResponse.json({ error: `Could not read the page report: ${message}` }, { status: 502 });
    }

    // page-report swallows LanceDB errors and proceeds with empty chunk data,
    // which is right for a read-only display but dangerous for an actuator:
    // an unreachable index makes EVERY page look unindexed and would burn OCR
    // on a document that is perfectly fine. So the liveness check must stay.
    //
    // What it must NOT do is infer index health from THIS document's chunk
    // count. The original guard did, on the stated premise that "an INDEXED
    // document with pages and zero chunks cannot occur legitimately". That
    // premise is false. Six documents in the live corpus had exactly that
    // shape against a completely healthy index: 30,961 rows present, chunks
    // table readable, no orphaned document_ids — ingestion had simply marked
    // them INDEXED without ever writing a vector (now guarded at the source
    // in ingestion-pipeline.ts). The refusal fired on the documents that most
    // needed the repair, and told the operator their index was broken when
    // it was not.
    //
    // Probe the index itself instead: is the table there, and does it hold
    // rows for anything at all? That separates "index unreadable" (refuse)
    // from "this document has no vectors" (a real state, repairable page by
    // page since the pages do have text).
    const health = await probeIndexHealth();
    if (!health.ok) {
      logger.error('Vector index is not readable — refusing to queue a repair', {
        documentId: id, reason: health.reason,
      });
      return NextResponse.json({ error: health.reason }, { status: 503 });
    }
    if (report.summary.totalChunks === 0) {
      // Not an error, and not a reason to refuse — just worth saying plainly,
      // because a full re-ingest is usually cheaper than N one-page repairs
      // on a large document.
      logger.warn('Document has no vectors at all; repairing page by page', {
        documentId: id, pageCount, indexRows: health.totalRows,
      });
    }

    // Second liveness gate: unlike page-report, computePartialDocumentIds
    // does not catch, so a LanceDB fault surfaces here as null instead of
    // being silently absorbed. (It cannot cover the missing-table case — it
    // reports every document as partial then — which is what the totalChunks
    // gate above is for. Both are needed.)
    const partialBefore = await isStillPartial(id, pageCount);
    if (partialBefore === null) {
      return NextResponse.json(
        { error: 'Could not verify index state (LanceDB unavailable) — refusing to queue a repair' },
        { status: 503 },
      );
    }

    const unindexedBefore = unindexedPageNumbers(report);

    let repair = readRepairTags(doc.tags);
    if (resetTerminal && unindexedBefore.length > 0) {
      const cleared: RepairTags = { ...repair };
      for (const page of unindexedBefore) delete cleared[String(page)];
      repair = cleared;
      logger.info('Repair history reset for currently-unindexed pages', { documentId: id, pages: unindexedBefore.length });
    }

    if (unindexedBefore.length === 0) {
      return NextResponse.json({
        documentId: id,
        requeued: false,
        message: 'No unindexed pages — every page is either indexed or blank by design',
        attempted: 0,
        attemptedPages: [],
        repaired: 0,
        repairedPages: [],
        stillFailing: [],
        stillFailingCount: 0,
        terminal: [],
        terminalCount: 0,
        terminalByReasonCode: {},
        remainingEligible: 0,
        unindexedBefore: 0,
        unindexedAfter: 0,
        emptyPages: report.summary.emptyPages ?? 0,
        stillPartial: partialBefore,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      });
    }

    // --- 2. Drop pages we have already given up on ------------------------
    const { eligible, terminal } = partitionEligiblePages(unindexedBefore, repair);
    const terminalPages = withReasonCodes(terminal, repair);

    // Optional caller-supplied subset ("retry just this page" from the UI).
    // Intersected with `eligible`, never additive — an explicit request must
    // not bypass the retry bound.
    const requested = sanitizePageList(body?.pages, pageCount);
    const selectable = requested ? eligible.filter((p) => requested.includes(p)) : eligible;

    // --- 3. Nothing left to try: report why, do NOT re-queue --------------
    if (selectable.length === 0) {
      const byCode = countByReasonCode(terminalPages);
      logger.info('Fix-partial short-circuited — no eligible pages', {
        documentId: id,
        unindexed: unindexedBefore.length,
        terminal: terminalPages.length,
        byCode,
      });
      return NextResponse.json({
        documentId: id,
        requeued: false,
        message: requested && eligible.length > 0
          ? 'None of the requested pages are eligible for repair'
          : `${terminalPages.length} of ${unindexedBefore.length} unindexed page(s) have been given up on after ${MAX_REPAIR_ATTEMPTS} attempts or an unrecoverable failure — re-indexing them again cannot help`,
        attempted: 0,
        attemptedPages: [],
        repaired: 0,
        repairedPages: [],
        stillFailing: [],
        stillFailingCount: 0,
        terminal: terminalPages,
        terminalCount: terminalPages.length,
        terminalByReasonCode: byCode,
        remainingEligible: eligible.length,
        unindexedBefore: unindexedBefore.length,
        unindexedAfter: unindexedBefore.length,
        emptyPages: report.summary.emptyPages ?? 0,
        stillPartial: partialBefore,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      });
    }

    // Exactly the pages sent to reindex-pages — NOT `eligible`. Feeding
    // `updateRepairTags` anything wider would increment the attempt count of
    // pages that were never tried and walk them to terminal untouched.
    const attemptedPages = selectable.slice(0, maxPages);

    if (dryRun) {
      return NextResponse.json({
        documentId: id,
        dryRun: true,
        requeued: false,
        attempted: 0,
        attemptedPages,
        repaired: 0,
        repairedPages: [],
        stillFailing: [],
        stillFailingCount: 0,
        terminal: terminalPages,
        terminalCount: terminalPages.length,
        terminalByReasonCode: countByReasonCode(terminalPages),
        /**
         * Every stored repair entry, terminal or not.
         *
         * `terminal` alone is not enough for the UI. A page classified
         * 'ocr-quality-rejected' is deliberately NON-terminal — it keeps its
         * retry budget so it indexes itself once OCR is fixed — so it never
         * appears in `terminal`, and the panel had no way to explain why the
         * page was missing. It rendered as an unexplained gap while the
         * stored reason said exactly what was wrong.
         */
        history: Object.entries(repair)
          .map(([page, entry]) => ({
            page: Number(page),
            attempts: entry.attempts,
            reasonCode: entry.reasonCode,
            reason: entry.reason,
            terminal: !!entry.terminal,
          }))
          .sort((a, b) => a.page - b.page),
        remainingEligible: selectable.length - attemptedPages.length,
        unindexedBefore: unindexedBefore.length,
        unindexedAfter: unindexedBefore.length,
        emptyPages: report.summary.emptyPages ?? 0,
        stillPartial: partialBefore,
        maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      });
    }

    // --- 4. Delegate the actual repair ------------------------------------
    logger.info('Delegating repair to reindex-pages', {
      documentId: id,
      pages: attemptedPages.length,
      eligible: selectable.length,
      terminal: terminalPages.length,
    });

    claimedStatus = true;
    let requestError: string | undefined;
    let emptyAfterOcr = new Set<number>();
    // Subset of emptyAfterOcr whose pages carry ink: image-only, not blank.
    let inkedNoText = new Set<number>();
    // OCR ran and the gate discarded its output: an OCR problem, not a page fact.
    let ocrRejected = new Set<number>();

    try {
      const res = await reindexPagesPOST(
        {
          json: async () => ({
            pages: attemptedPages,
            forceOcr,
            processingStatus: FIXING_STATUS,
            statusAfterSuccess: REPAIRABLE_STATUS,
            progress: { done: 0, total: attemptedPages.length },
          }),
        } as unknown as NextRequest,
        { params: Promise.resolve({ id }) },
      );
      const payload = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status < 200 || res.status >= 300) {
        requestError = typeof payload?.error === 'string' ? payload.error : `reindex-pages returned HTTP ${res.status}`;
      } else {
        if (Array.isArray(payload?.emptyPages)) {
          emptyAfterOcr = new Set((payload.emptyPages as unknown[]).map((n) => Number(n)));
        }
        if (Array.isArray(payload?.inkedNoTextPages)) {
          inkedNoText = new Set((payload.inkedNoTextPages as unknown[]).map((n) => Number(n)));
        }
        if (Array.isArray(payload?.ocrRejectedPages)) {
          ocrRejected = new Set((payload.ocrRejectedPages as unknown[]).map((n) => Number(n)));
        }
      }
    } catch (err) {
      requestError = err instanceof Error ? err.message : String(err);
    }
    if (requestError) {
      requestError = normalizeFailureMessage(requestError);
      logger.warn('Reindex delegation failed', { documentId: id, error: requestError });
    }

    // --- 5. Re-verify: this is what stops the infinite retry loop ---------
    let stillUnindexed: Set<number>;
    let unindexedAfterCount = unindexedBefore.length;
    let emptyAfterCount = report.summary.emptyPages ?? 0;

    if (requestError) {
      // The repair never ran; nothing can have changed. Re-reading the page
      // report would only risk a second failure on the same broken path.
      stillUnindexed = new Set(attemptedPages);
    } else {
      try {
        const after = await fetchPageReport(id);
        const afterUnindexed = new Set(unindexedPageNumbers(after));
        unindexedAfterCount = afterUnindexed.size;
        emptyAfterCount = after.summary.emptyPages ?? emptyAfterCount;
        // A page that now classifies as 'empty' is correctly NOT still
        // unindexed: reindex-pages verified it blank, so updateRepairTags
        // clearing its history is the right outcome, not a miss.
        stillUnindexed = new Set(attemptedPages.filter((p) => afterUnindexed.has(p)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('Post-repair verification failed', { documentId: id, error: message });
        // Unverifiable: do not record attempts we cannot substantiate.
        return NextResponse.json(
          {
            documentId: id,
            requeued: true,
            error: `Repair ran but verification failed — no attempt was recorded: ${message}`,
            attempted: attemptedPages.length,
            attemptedPages,
          },
          { status: 502 },
        );
      }
    }

    const result = updateRepairTags(
      repair,
      attemptedPages,
      stillUnindexed,
      (page) =>
        classifyRepairFailure({
          requestError,
          // reindex-pages' own `emptyPages` array is the authoritative
          // "every extraction path ran and produced nothing" signal.
          stillEmptyAfterOcr: emptyAfterOcr.has(page),
          // …and `inkedNoTextPages` is the subset of those that carry ink, so
          // the page is an image rather than a blank or a failure. Checked
          // first by the classifier, since it is the more specific fact.
          inkedNoText: inkedNoText.has(page),
          // Checked first by the classifier: it explains why there appears
          // to be no text at all.
          ocrRejected: ocrRejected.has(page),
        }),
    );

    // Re-read tags immediately before writing: the repair takes minutes and
    // other writers (draft-detection's tags.recordStatus) may have touched
    // the blob since. mergeRepairTags replaces only the `repair` key.
    const fresh = await prisma.document.findUnique({ where: { id }, select: { tags: true } });
    await prisma.document.update({
      where: { id },
      data: { tags: mergeRepairTags(fresh?.tags ?? doc.tags, result.tags) },
    });
    claimedStatus = false;

    const stillFailingPages: PageOutcome[] = [...result.retriable, ...result.newlyTerminal]
      .sort((a, b) => a - b)
      .map((page) => {
        const entry = result.tags[String(page)];
        return {
          page,
          attempts: entry?.attempts ?? 1,
          reasonCode: entry?.reasonCode ?? 'unknown',
          reason: entry?.reason,
        };
      });

    // Everything the operator has been given up on: pages already terminal
    // before this run, plus anything that crossed the bound just now.
    const allTerminal: PageOutcome[] = [
      ...terminalPages,
      ...stillFailingPages.filter((p) => result.tags[String(p.page)]?.terminal),
    ].sort((a, b) => a.page - b.page);

    const partialAfter = await isStillPartial(id, pageCount);
    const repairedPages = attemptedPages.filter((p) => !stillUnindexed.has(p));

    logger.info('Fix-partial complete', {
      documentId: id,
      attempted: attemptedPages.length,
      repaired: repairedPages.length,
      stillFailing: stillUnindexed.size,
      newlyTerminal: result.newlyTerminal.length,
    });

    return NextResponse.json({
      documentId: id,
      requeued: true,
      attempted: attemptedPages.length,
      attemptedPages,
      repaired: repairedPages.length,
      repairedPages,
      stillFailing: stillFailingPages,
      stillFailingCount: stillFailingPages.length,
      terminal: allTerminal,
      terminalCount: allTerminal.length,
      terminalByReasonCode: countByReasonCode(allTerminal),
      /** Pages still worth another attempt that did not fit under `maxPages`. POST again to continue. */
      remainingEligible: selectable.length - attemptedPages.length,
      unindexedBefore: unindexedBefore.length,
      unindexedAfter: unindexedAfterCount,
      emptyPages: emptyAfterCount,
      stillPartial: partialAfter,
      maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
      ...(requestError ? { reindexError: requestError } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fix partial document';
    logger.error('Fix-partial failed', error);

    // reindex-pages restores the previous status inside its own catch, but if
    // this route threw between claiming and releasing, the document could be
    // left wearing FIXING_PARTIAL with no orchestrator alive to clear it —
    // which would then lock out every future repair via the 409 above.
    if (claimedStatus) {
      try {
        const current = await prisma.document.findUnique({ where: { id }, select: { status: true, caseId: true } });
        if (current?.status === FIXING_STATUS) {
          await prisma.document.update({ where: { id }, data: { status: REPAIRABLE_STATUS } });
          const { publishDocumentEvent } = await import('@/lib/sse-events');
          await publishDocumentEvent({
            type: 'document_status_changed',
            caseId: current.caseId || '',
            documentId: id,
            status: REPAIRABLE_STATUS,
          });
        }
      } catch {
        /* best effort — the 409 guard is the only thing at stake */
      }
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
