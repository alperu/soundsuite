/**
 * Drive the Fix Partial repair across every partially-indexed document, and
 * verify the result independently of what the repair endpoint claims.
 *
 * Why this exists
 * ---------------
 * `POST /api/documents/[id]/fix-partial` deliberately does not loop: one
 * invocation attempts at most `maxPages` pages and tells the caller to POST
 * again ("3. It does not loop", that route's module header). Nothing did.
 * Repairing a corpus therefore meant clicking one document at a time and
 * reading a JSON blob per click.
 *
 * Why it does its own verification
 * --------------------------------
 * The repair endpoint reports `repairedPages` from its own post-check, so
 * asking it whether it worked is asking the same code that just ran. That is
 * not a check, and it has been wrong before in exactly this area: the repair
 * route logged
 *
 *   Chunking: 9 non-empty pages -> 0 page chunks
 *   Clearing old vectors for pages [11, 12, 15, ...]
 *   Reindex complete: 9 pages, 0 chunks
 *
 * i.e. reported success having written nothing (and deleted what was there).
 * So after each document this runner re-reads `/api/vectors/page-report`,
 * which counts actual rows in LanceDB, and trusts THAT. A page counts as
 * repaired only when its independently-observed status becomes `indexed`.
 * Where the two disagree, the disagreement is the finding and is reported as
 * `unverified` rather than smoothed over.
 *
 * Two populations, deliberately separated
 * ---------------------------------------
 * A document marked INDEXED with ZERO indexed pages is not a partial-index
 * gap — nothing about it was ever written — and per-page repair is the wrong
 * tool (it would issue 198 one-page repairs on the largest one before
 * learning that). Those are classified `needs-reingest` and skipped unless
 * `includeZeroIndexed` is set.
 */

export type RepairVerdict =
  | 'fixed'            // every missing page is now independently confirmed indexed
  | 'partial'          // some pages recovered, some did not
  | 'no-progress'      // ran, nothing recovered
  | 'needs-reingest'   // zero vectors to begin with: wrong tool
  | 'blank-by-design'  // the only gap is pages with no text; nothing to index
  | 'error';           // the repair call itself failed

export interface PageFailure {
  page: number;
  reasonCode: string;
  reason?: string;
  attempts?: number;
}

export interface DocumentRepairResult {
  documentId: string;
  verdict: RepairVerdict;
  pagesBefore: number;
  pagesAfter: number;
  repaired: number[];
  /** Pages the endpoint claimed it repaired that page-report does NOT confirm. */
  unverified: number[];
  failures: PageFailure[];
  rounds: number;
  elapsedMs: number;
  error?: string;
}

export interface RepairRunSummary {
  results: DocumentRepairResult[];
  totals: {
    documents: number;
    pagesMissingBefore: number;
    pagesMissingAfter: number;
    pagesRepaired: number;
    pagesUnverified: number;
    documentsFixed: number;
    documentsNeedingReingest: number;
  };
}

export interface PageReportPage {
  pageNumber: number;
  status: 'indexed' | 'unindexed' | 'empty';
  textDensity?: number;
  textPreview?: string;
  source?: string | null;
}

export interface RepairRunnerOptions {
  /** Absolute origin of the master, e.g. http://localhost:3000 */
  baseUrl: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Restrict the run to these document ids. Default: every partial document. */
  documentIds?: string[];
  /** Per-page repair rounds per document before giving up on progress. */
  maxRounds?: number;
  /** Include documents that have zero indexed pages. Default false — see header. */
  includeZeroIndexed?: boolean;
  /** Clear terminal ("given up") marks before attempting. */
  resetTerminal?: boolean;
  /** Called after each document so a UI can stream progress. */
  onProgress?: (result: DocumentRepairResult, index: number, total: number) => void;
  /** Return true to stop between documents. */
  shouldStop?: () => boolean;
}

const DEFAULT_MAX_ROUNDS = 6;

async function getJson<T>(f: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const res = await f(url, init);
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } | string })?.error;
    throw new Error(
      typeof msg === 'string' ? msg
        : msg?.message ?? `HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`,
    );
  }
  return body as T;
}

/** Read the authoritative per-page state: rows actually present in LanceDB. */
export async function readPageReport(
  opts: Pick<RepairRunnerOptions, 'baseUrl' | 'fetchImpl'>,
  documentId: string,
): Promise<{ pages: PageReportPage[]; totalPages: number }> {
  const f = opts.fetchImpl ?? fetch;
  const j = await getJson<{ pages?: PageReportPage[]; totalPages?: number }>(
    f, `${opts.baseUrl}/api/vectors/page-report?documentId=${encodeURIComponent(documentId)}`,
  );
  return { pages: j.pages ?? [], totalPages: j.totalPages ?? 0 };
}

function unindexed(pages: PageReportPage[]): number[] {
  return pages.filter((p) => p.status === 'unindexed').map((p) => p.pageNumber);
}

/**
 * Do NOT infer "this page has no text" from `textDensity === 0`.
 *
 * That reading was tried and it was wrong. Two pages of a 154-page document
 * reported `textDensity: 0, source: 'extract', textPreview: ''` and were
 * classified unfixable on that basis. Repairing them anyway took 5 seconds
 * and they came back `indexed` at density 938 and 524, from plain extraction
 * — no OCR needed. The zero was stale provenance, not absent text:
 * page-report reads density from PageCache, which is wiped after ingestion,
 * then falls back to a PageScore snapshot that can predate the page's
 * current state.
 *
 * Skipping on that signal would have abandoned 69 genuinely recoverable
 * pages across two documents. The authoritative "blank by design" signal is
 * `status === 'empty'` (PageCache/PageScore `source === 'empty'`), which
 * page-report already computes and which this runner never has to guess at;
 * and the authoritative "OCR found nothing" signal is reindex-pages'
 * own `emptyPages` array, which only exists after an attempt.
 *
 * So: attempt the page, and let the attempt decide.
 */
function isKnownBlank(p: PageReportPage): boolean {
  return p.status === 'empty';
}

/**
 * Repair one document, looping until it stops making progress, then verify
 * against page-report rather than against the repair endpoint's own claim.
 */
export async function repairDocument(
  opts: RepairRunnerOptions,
  documentId: string,
): Promise<DocumentRepairResult> {
  const f = opts.fetchImpl ?? fetch;
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const startedAt = Date.now();

  const base: DocumentRepairResult = {
    documentId, verdict: 'no-progress', pagesBefore: 0, pagesAfter: 0,
    repaired: [], unverified: [], failures: [], rounds: 0, elapsedMs: 0,
  };

  let before: { pages: PageReportPage[]; totalPages: number };
  try {
    before = await readPageReport(opts, documentId);
  } catch (e) {
    return { ...base, verdict: 'error', elapsedMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e) };
  }

  const missingBefore = unindexed(before.pages);
  base.pagesBefore = missingBefore.length;
  if (missingBefore.length === 0) {
    return { ...base, verdict: 'fixed', elapsedMs: Date.now() - startedAt };
  }

  // Zero indexed pages means ingestion never wrote anything for this
  // document. Per-page repair cannot be the right tool; say so.
  const indexedCount = before.pages.filter((p) => p.status === 'indexed').length;
  if (indexedCount === 0 && !opts.includeZeroIndexed) {
    return { ...base, verdict: 'needs-reingest', pagesAfter: missingBefore.length,
      elapsedMs: Date.now() - startedAt };
  }

  // `unindexed` already excludes `empty`, so this can only fire if page-report
  // and the unindexed filter ever disagree. Kept as a guard, deliberately NOT
  // widened to a density heuristic — see isKnownBlank.
  const byNumber = new Map(before.pages.map((p) => [p.pageNumber, p]));
  if (missingBefore.every((n) => { const p = byNumber.get(n); return p ? isKnownBlank(p) : false; })) {
    return { ...base, verdict: 'blank-by-design', pagesAfter: missingBefore.length,
      elapsedMs: Date.now() - startedAt };
  }

  const claimedRepaired = new Set<number>();
  let failures: PageFailure[] = [];
  let rounds = 0;
  let previousRemaining = missingBefore.length;

  for (let round = 0; round < maxRounds; round++) {
    if (opts.shouldStop?.()) break;
    rounds++;
    let body: {
      repairedPages?: number[];
      stillFailing?: PageFailure[];
      terminal?: PageFailure[];
      remainingEligible?: number;
      unindexedAfter?: number;
    };
    try {
      body = await getJson(f, `${opts.baseUrl}/api/documents/${encodeURIComponent(documentId)}/fix-partial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // resetTerminal only on the first round: re-arming every round would
        // loop forever on a page that is genuinely unfixable.
        body: JSON.stringify({ resetTerminal: round === 0 ? !!opts.resetTerminal : false }),
      });
    } catch (e) {
      failures = [];
      return {
        ...base, verdict: 'error', rounds,
        pagesAfter: unindexed((await readPageReport(opts, documentId).catch(() => before)).pages).length,
        repaired: [...claimedRepaired], failures,
        elapsedMs: Date.now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    for (const p of body.repairedPages ?? []) claimedRepaired.add(p);
    failures = [...(body.stillFailing ?? []), ...(body.terminal ?? [])];

    const remaining = body.remainingEligible ?? 0;
    const after = body.unindexedAfter ?? 0;
    if (after === 0 || remaining === 0) break;
    // No forward progress this round: stop rather than spin.
    if (after >= previousRemaining) break;
    previousRemaining = after;
  }

  // --- Independent verification: count rows, do not take the endpoint's word.
  let afterReport: { pages: PageReportPage[]; totalPages: number };
  try {
    afterReport = await readPageReport(opts, documentId);
  } catch (e) {
    return { ...base, verdict: 'error', rounds, repaired: [...claimedRepaired], failures,
      elapsedMs: Date.now() - startedAt, error: e instanceof Error ? e.message : String(e) };
  }

  const missingAfter = new Set(unindexed(afterReport.pages));
  const confirmed = missingBefore.filter((n) => !missingAfter.has(n));
  const unverified = [...claimedRepaired].filter((n) => missingAfter.has(n)).sort((a, b) => a - b);

  const verdict: RepairVerdict =
    missingAfter.size === 0 ? 'fixed'
      : confirmed.length > 0 ? 'partial'
        : 'no-progress';

  return {
    documentId, verdict,
    pagesBefore: missingBefore.length,
    pagesAfter: missingAfter.size,
    repaired: confirmed.sort((a, b) => a - b),
    unverified, failures, rounds,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Every document the badge would call partial, including mid-repair ones. */
export async function listPartialDocumentIds(
  opts: Pick<RepairRunnerOptions, 'baseUrl' | 'fetchImpl'>,
): Promise<string[]> {
  const f = opts.fetchImpl ?? fetch;
  const j = await getJson<{ partialDocumentIds?: string[] }>(
    f, `${opts.baseUrl}/api/documents/partial-status`,
  );
  return j.partialDocumentIds ?? [];
}

/** Repair every partial document sequentially. Sequential on purpose: the
 *  embedding role is a shared, finite resource and parallel repairs would
 *  queue against ingestion already using it. */
export async function repairAllPartials(opts: RepairRunnerOptions): Promise<RepairRunSummary> {
  const ids = opts.documentIds ?? await listPartialDocumentIds(opts);
  const results: DocumentRepairResult[] = [];

  for (let i = 0; i < ids.length; i++) {
    if (opts.shouldStop?.()) break;
    const result = await repairDocument(opts, ids[i]);
    results.push(result);
    opts.onProgress?.(result, i, ids.length);
  }

  return {
    results,
    totals: {
      documents: results.length,
      pagesMissingBefore: results.reduce((s, r) => s + r.pagesBefore, 0),
      pagesMissingAfter: results.reduce((s, r) => s + r.pagesAfter, 0),
      pagesRepaired: results.reduce((s, r) => s + r.repaired.length, 0),
      pagesUnverified: results.reduce((s, r) => s + r.unverified.length, 0),
      documentsFixed: results.filter((r) => r.verdict === 'fixed').length,
      documentsNeedingReingest: results.filter((r) => r.verdict === 'needs-reingest').length,
    },
  };
}
