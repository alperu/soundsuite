'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Fix Partial — triage panel.
 *
 * "PARTIAL" is a derived display state over an INDEXED document, not a stored
 * status: some of its pages have no chunks in the vector index.
 *
 * Two things this panel exists to prevent:
 *
 * 1. Offering a repair that cannot work. /api/vectors/page-report is the
 *    authoritative per-page classification (`empty` | `indexed` | `unindexed`),
 *    and it is the same classification /api/documents/[id]/fix-partial uses to
 *    pick pages. A page that is blank *by design* comes back as `empty`, never
 *    `unindexed`, so a document whose only gaps are blank pages shows "nothing
 *    to repair" and the confirm button stays disabled — re-embedding could
 *    never close that gap. Separately, a page whose extraction produced NO text
 *    (`textDensity === 0`) has nothing to embed; a plain re-embed is guaranteed
 *    to be a no-op and would burn its three repair attempts for nothing. Those
 *    are split out and only sent when the operator opts into forcing OCR.
 *
 * 2. Silently doing nothing. Pages already given up on are shown *before* the
 *    run (via the route's `dryRun`), and the route's own `terminal` /
 *    `stillFailing` arrays — each `{page, attempts, reasonCode, reason}` — are
 *    rendered per page afterwards, never swallowed.
 *
 * Deliberately a grid-level overlay rather than card-local state: a successful
 * POST flips the document to FIXING_PARTIAL, which moves the card to another
 * column and remounts it (as does the grid's 2s poll), discarding anything held
 * inside it.
 */

export interface PageReportPage {
  pageNumber: number;
  textDensity: number;
  source: string | null;
  chunkCount: number;
  status: 'empty' | 'indexed' | 'unindexed' | string;
  band: string | null;
  pageClass: string | null;
}

export interface PageReport {
  documentId: string;
  fileName: string;
  totalPages: number;
  pages: PageReportPage[];
  summary: {
    indexedPages: number;
    unindexedPages: number;
    emptyPages?: number;
    totalChunks: number;
  };
}

/** Per-page outcome as the repair route reports it. */
interface PageOutcome {
  page: number;
  attempts?: number;
  reasonCode?: string;
  reason?: string;
}

interface FixPartialResult {
  attempted: number;
  repaired: number;
  stillFailing: number;
  terminal: number;
  terminalPages: PageOutcome[];
  failingPages: PageOutcome[];
  remainingEligible: number;
  unindexedAfter: number;
  message?: string;
  maxRepairAttempts?: number;
  /**
   * The route's own post-repair verdict, from computePartialDocumentIds — the
   * same blank-aware rule that produced the PARTIAL badge in the first place.
   *
   * Deliberately `undefined` rather than `false` on every failure path: the
   * grid uses it to override a server-rendered badge that nothing else
   * refreshes, and a failed request is not evidence the document got fixed.
   */
  stillPartial?: boolean;
  /** Set when the route is unreachable or returned an error payload. */
  error?: string;
}

/**
 * `attempted` / `repaired` arrive as numbers and `stillFailing` / `terminal` as
 * arrays, but the contract was described both ways while this was being built,
 * so accept either rather than render NaN.
 */
function toCount(value: unknown, fallback?: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (fallback !== undefined) return toCount(fallback);
  return 0;
}

function toPages(value: unknown): PageOutcome[] {
  if (!Array.isArray(value)) return [];
  const out: PageOutcome[] = [];
  for (const entry of value) {
    if (typeof entry === 'number') {
      out.push({ page: entry });
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      const page = Number(e.page ?? e.pageNumber);
      if (Number.isFinite(page)) {
        out.push({
          page,
          attempts: typeof e.attempts === 'number' ? e.attempts : undefined,
          reasonCode: typeof e.reasonCode === 'string' ? e.reasonCode : undefined,
          reason: typeof e.reason === 'string' ? e.reason : undefined,
        });
      }
    }
  }
  return out;
}

/** The route answers errors as `{ error: '…' }`; other routes use `{error:{message}}`. */
function errorText(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const e = (data as Record<string, unknown>).error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).message === 'string') {
      return (e as Record<string, string>).message;
    }
  }
  return `Request failed (HTTP ${status})`;
}

/** [1,2,3,7,9,10] -> "1–3, 7, 9–10" — page gaps run to the hundreds. */
export function formatPageRanges(pages: number[], max = 12): string {
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b);
  const runs: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  if (runs.length > max) return `${runs.slice(0, max).join(', ')} and ${runs.length - max} more`;
  return runs.join(', ');
}

function PageOutcomeList({ pages }: { pages: PageOutcome[] }) {
  return (
    <ul className="space-y-1 max-h-40 overflow-y-auto">
      {pages.map((p) => (
        <li key={p.page} className="text-[11px] text-gray-700">
          <span className="font-medium">Page {p.page}</span>
          {p.attempts != null && (
            <span className="text-gray-500"> · {p.attempts} attempt{p.attempts === 1 ? '' : 's'}</span>
          )}
          {p.reason ? (
            <span className="text-gray-600"> — {p.reason}</span>
          ) : p.reasonCode ? (
            <span className="text-gray-600"> — {p.reasonCode}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function FixPartialPanel({
  documentId,
  fileName,
  onClose,
  onStarted,
}: {
  documentId: string;
  fileName: string;
  onClose: () => void;
  /** Fired after a repair so the grid can summarise it on the card. */
  onStarted?: (result: FixPartialResult) => void;
}) {
  const [report, setReport] = useState<PageReport | null>(null);
  const [givenUp, setGivenUp] = useState<PageOutcome[]>([]);
  const [preflightNote, setPreflightNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [includeOcr, setIncludeOcr] = useState(false);
  const [result, setResult] = useState<FixPartialResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setPreflightNote(null);

    // Two independent reads, in parallel:
    //  - page-report gives the per-page density needed to tell "has text but was
    //    never chunked" (repairable) from "no text at all" (needs OCR).
    //  - the repair route's dryRun gives the repair HISTORY — which pages have
    //    already been given up on and why. page-report cannot know that; it
    //    lives in Document.tags.repair. dryRun returns before the route claims
    //    the document's status, so it starts nothing.
    const [reportRes, dryRes] = await Promise.allSettled([
      fetch(`/api/vectors/page-report?documentId=${encodeURIComponent(documentId)}`).then(
        async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) }),
      ),
      fetch(`/api/documents/${encodeURIComponent(documentId)}/fix-partial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json().catch(() => null) })),
    ]);

    if (reportRes.status === 'fulfilled' && reportRes.value.ok) {
      setReport(reportRes.value.data as PageReport);
    } else {
      setLoadError(
        reportRes.status === 'fulfilled'
          ? errorText(reportRes.value.data, reportRes.value.status)
          : 'Could not reach the page report',
      );
    }

    // The preflight is best-effort — the triage below still works without it.
    if (dryRes.status === 'fulfilled' && dryRes.value.ok) {
      setGivenUp(toPages(dryRes.value.data?.terminal));
    } else if (dryRes.status === 'fulfilled') {
      setPreflightNote(
        dryRes.value.status === 404
          ? 'The repair endpoint is not available on this build — the repair cannot be started.'
          : errorText(dryRes.value.data, dryRes.value.status),
      );
    }

    setLoading(false);
  }, [documentId]);

  useEffect(() => { load(); }, [load]);

  const unindexed = (report?.pages ?? []).filter((p) => p.status === 'unindexed');
  const givenUpPages = new Set(givenUp.map((p) => p.page));
  // Extraction produced no text at all — there is nothing to embed, so a plain
  // re-embed is a guaranteed no-op that would spend one of three attempts.
  const needsOcr = unindexed.filter((p) => !(p.textDensity > 0) && !givenUpPages.has(p.pageNumber));
  const fixable = unindexed.filter((p) => p.textDensity > 0 && !givenUpPages.has(p.pageNumber));
  const emptyPages = report?.summary.emptyPages ?? 0;

  const selected = includeOcr ? [...fixable, ...needsOcr] : fixable;
  const nothingToFix = !!report && unindexed.length === 0;
  const allGivenUp = !!report && unindexed.length > 0 && fixable.length === 0 && needsOcr.length === 0;
  const onlyNeedsOcr = fixable.length === 0 && needsOcr.length > 0;
  const canRun = !!report && selected.length > 0 && !running && !preflightNote;

  /**
   * `resetTerminal` re-arms pages the repair loop has given up on.
   *
   * A terminal verdict is permanent by design — three failed attempts, or an
   * immediately-terminal failure like a dimension mismatch, and the page is
   * never retried. That is right while the underlying cause is unfixed, and
   * wrong the moment it IS fixed: without this there was no way back, and the
   * Repair button stays disabled (`canRun` is false when every gap is
   * given up on) so the panel became a dead end.
   *
   * The route clears history for ALL currently-unindexed pages regardless of
   * `pages`, then uses `pages` to decide what to attempt — so a reset must send
   * the given-up page numbers explicitly or it would clear the history and then
   * attempt nothing.
   */
  const runFix = async (opts?: { resetTerminal?: boolean }) => {
    const resetTerminal = opts?.resetTerminal === true;
    // Note the two shapes: PageReportPage carries `pageNumber`, PageOutcome
    // (what `givenUp` holds) carries `page`. Mixing them up silently sends
    // `undefined` page numbers, which the route sanitizes away — a reset that
    // clears history and then attempts nothing.
    const pages = resetTerminal
      ? [...new Set([
          ...selected.map((p) => p.pageNumber),
          ...givenUp.map((p) => p.page),
        ])].sort((a, b) => a - b)
      : selected.map((p) => p.pageNumber);
    setRunning(true);
    try {
      // Chunk the request.
      //
      // The route accepts up to 50 pages per call and this panel used to send
      // every selected page at once. On a document needing OCR that does not
      // survive one HTTP request: 41 pages at the ~9s/page OCR actually costs
      // (measured: 26 pages in 234s) is ~370s, and it died with a bare
      // `TypeError: fetch failed`. Worse, the server kept going — the request
      // was orphaned, not cancelled, so the document sat in FIXING_PARTIAL
      // holding its repair lock for 13+ minutes with nothing watching. That
      // is precisely the "it says fixing but nothing is happening" report.
      //
      // Small chunks keep each request near 75s. The loop carries the rest.
      const PAGES_PER_REQUEST = 8;
      const chunks: number[][] = [];
      for (let i = 0; i < pages.length; i += PAGES_PER_REQUEST) {
        chunks.push(pages.slice(i, i + PAGES_PER_REQUEST));
      }
      if (chunks.length === 0) chunks.push([]);

      let acc: FixPartialResult | null = null;
      let res!: Response;
      let data: Record<string, unknown> | null = null;

      for (let c = 0; c < chunks.length; c++) {
        res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/fix-partial`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pages: chunks[c],
            maxPages: PAGES_PER_REQUEST,
            forceOcr: includeOcr,
            // Only the first chunk re-arms: re-arming each chunk could revive
            // a page another chunk just legitimately gave up on.
            ...(resetTerminal && c === 0 ? { resetTerminal: true } : {}),
          }),
        });
        data = await res.json().catch(() => null);
        if (!res.ok) break;

        const partial: FixPartialResult = {
          attempted: toCount(data?.attempted, data?.attemptedPages),
          repaired: toCount(data?.repaired, data?.repairedPages),
          stillFailing: toCount(data?.stillFailing, data?.stillFailingCount),
          terminal: toCount(data?.terminal, data?.terminalCount),
          terminalPages: toPages(data?.terminal),
          failingPages: toPages(data?.stillFailing),
          remainingEligible: toCount(data?.remainingEligible),
          unindexedAfter: toCount(data?.unindexedAfter),
          message: typeof data?.message === 'string' ? data.message : undefined,
          maxRepairAttempts: typeof data?.maxRepairAttempts === 'number' ? data.maxRepairAttempts : undefined,
          stillPartial: typeof data?.stillPartial === 'boolean' ? data.stillPartial : undefined,
        };

        acc = acc === null ? partial : {
          ...partial,
          attempted: acc.attempted + partial.attempted,
          repaired: acc.repaired + partial.repaired,
          // The later reading wins for state-of-the-world counts; the
          // per-page lists accumulate so nothing gets dropped from view.
          terminalPages: [...acc.terminalPages, ...partial.terminalPages],
          failingPages: [...acc.failingPages, ...partial.failingPages],
        };
        acc.stillFailing = acc.failingPages.length || partial.stillFailing;
        acc.terminal = acc.terminalPages.length || partial.terminal;
        // Surface progress between chunks rather than after the last one.
        setResult({ ...acc });
      }

      if (!res.ok) {
        const failed: FixPartialResult = {
          attempted: 0, repaired: 0, stillFailing: 0, terminal: 0,
          terminalPages: [], failingPages: [], remainingEligible: 0, unindexedAfter: unindexed.length,
          error: res.status === 404
            ? 'The repair endpoint (/api/documents/[id]/fix-partial) is not available on this build.'
            : errorText(data, res.status),
        };
        setResult(failed);
        onStarted?.(failed);
        return;
      }

      const normalized: FixPartialResult = acc ?? {
        attempted: 0, repaired: 0, stillFailing: 0, terminal: 0,
        terminalPages: [], failingPages: [], remainingEligible: 0,
        unindexedAfter: unindexed.length,
      };
      setResult(normalized);
      onStarted?.(normalized);
      load(); // re-triage so the remaining gaps reflect the run
    } catch (err) {
      const failed: FixPartialResult = {
        attempted: 0, repaired: 0, stillFailing: 0, terminal: 0,
        terminalPages: [], failingPages: [], remainingEligible: 0, unindexedAfter: unindexed.length,
        error: err instanceof Error ? err.message : 'Repair request failed',
      };
      setResult(failed);
      onStarted?.(failed);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-none px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">Fix partial index</h2>
            <p className="text-xs text-gray-500 truncate" title={fileName}>{fileName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 flex-none" aria-label="Close">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && <p className="text-sm text-gray-500">Checking which pages are missing from the index…</p>}

          {loadError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
              <p className="font-medium">Could not read the page report</p>
              <p className="mt-1 text-xs">{loadError}</p>
              <button onClick={load} className="mt-2 text-xs px-2 py-1 bg-red-100 hover:bg-red-200 rounded">
                Try again
              </button>
            </div>
          )}

          {preflightNote && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-3">
              {preflightNote}
            </div>
          )}

          {report && !loading && (
            <>
              {/* Coverage summary */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="bg-gray-50 rounded p-2">
                  <div className="text-lg font-semibold text-gray-900">{report.totalPages}</div>
                  <div className="text-[11px] text-gray-500">pages</div>
                </div>
                <div className="bg-green-50 rounded p-2">
                  <div className="text-lg font-semibold text-green-700">{report.summary.indexedPages}</div>
                  <div className="text-[11px] text-green-600">indexed</div>
                </div>
                <div className="bg-slate-50 rounded p-2">
                  <div className="text-lg font-semibold text-slate-600">{emptyPages}</div>
                  <div className="text-[11px] text-slate-500">blank by design</div>
                </div>
                <div className="bg-amber-50 rounded p-2">
                  <div className="text-lg font-semibold text-amber-700">{unindexed.length}</div>
                  <div className="text-[11px] text-amber-600">missing</div>
                </div>
              </div>

              {/* Nothing to fix */}
              {nothingToFix && (
                <div className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded p-3">
                  <p className="font-medium">Nothing to repair.</p>
                  <p className="mt-1 text-xs">
                    {emptyPages > 0
                      ? `Every page is accounted for. The ${emptyPages} page${emptyPages === 1 ? '' : 's'} not in the index ${emptyPages === 1 ? 'is' : 'are'} blank by design — ${emptyPages === 1 ? 'it has' : 'they have'} no text to embed, so re-indexing can never change this and the document is not really partial.`
                      : 'Every page of this document is present in the vector index.'}
                  </p>
                </div>
              )}

              {/* Repairable */}
              {fixable.length > 0 && (
                <div className="border border-amber-200 rounded">
                  <div className="px-3 py-2 bg-amber-50 border-b border-amber-200">
                    <p className="text-sm font-medium text-amber-800">
                      {fixable.length} page{fixable.length === 1 ? '' : 's'} can be re-indexed
                    </p>
                    <p className="text-[11px] text-amber-700 mt-0.5">
                      These have extracted text but produced no chunks — re-embedding is likely to fix them.
                    </p>
                  </div>
                  <div className="px-3 py-2 text-xs text-gray-600 font-mono break-words">
                    {formatPageRanges(fixable.map((p) => p.pageNumber))}
                  </div>
                </div>
              )}

              {/* No extractable text — opt-in OCR */}
              {needsOcr.length > 0 && (
                <div className="border border-red-200 rounded">
                  <div className="px-3 py-2 bg-red-50 border-b border-red-200">
                    <p className="text-sm font-medium text-red-800">
                      {needsOcr.length} page{needsOcr.length === 1 ? ' has' : 's have'} no extracted text
                    </p>
                    <p className="text-[11px] text-red-700 mt-0.5">
                      Extraction produced nothing for these, so there is nothing to embed — a plain
                      re-index cannot fix them and would spend one of their repair attempts for nothing.
                      They are excluded unless you force OCR.
                    </p>
                  </div>
                  <div className="px-3 py-2 space-y-2">
                    <div className="text-xs text-gray-600 font-mono break-words">
                      {formatPageRanges(needsOcr.map((p) => p.pageNumber))}
                    </div>
                    <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeOcr}
                        onChange={(e) => setIncludeOcr(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        Force OCR on {needsOcr.length === 1 ? 'this page' : `these ${needsOcr.length} pages`} as well
                        <span className="block text-[11px] text-gray-500">
                          Slower, and it still fails if the page has no readable content — but it is the
                          only thing that can recover a page with no extracted text.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {/* Already given up on */}
              {givenUp.length > 0 && (
                <div className="border border-gray-200 rounded">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                    <p className="text-sm font-medium text-gray-800">
                      {givenUp.length} page{givenUp.length === 1 ? '' : 's'} already given up on
                    </p>
                    <p className="text-[11px] text-gray-600 mt-0.5">
                      Previous repairs exhausted their attempts or hit an unrecoverable failure. They are
                      not retried, so a repair now will not touch them.
                    </p>
                  </div>
                  <div className="px-3 py-2">
                    <PageOutcomeList pages={givenUp} />
                  </div>
                  {/*
                    The way back out. Without this the panel is a dead end: the
                    Repair button is disabled once every gap is given up on, and
                    the text below tells the operator to "reset the repair
                    history" with nothing to click.
                  */}
                  <div className="px-3 py-2 border-t border-gray-200 bg-gray-50 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-gray-600">
                      Fixed the underlying cause? Clear these pages&apos; attempt history and try again.
                    </p>
                    <button
                      onClick={() => runFix({ resetTerminal: true })}
                      disabled={running}
                      title={`Clear the repair history for ${givenUp.length} page${givenUp.length === 1 ? '' : 's'} and retry ${includeOcr ? 'with forced OCR' : 'immediately'}`}
                      className="flex-none text-xs px-2.5 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white rounded-md transition-colors"
                    >
                      {running ? 'Retrying…' : `Reset history & retry ${givenUp.length}`}
                    </button>
                  </div>
                </div>
              )}

              {allGivenUp && (
                <p className="text-xs text-gray-500">
                  Every remaining gap has been given up on, so the normal repair is not offered. Fix the
                  underlying cause (OCR quality, embedding model width), then use
                  <strong> Reset history &amp; retry</strong> above to re-arm them.
                </p>
              )}
              {onlyNeedsOcr && !allGivenUp && !includeOcr && (
                <p className="text-xs text-gray-500">
                  Nothing here is repairable by re-embedding alone — tick “force OCR” above to attempt these.
                </p>
              )}

              {/* Outcome */}
              {result && (
                <div className="border border-gray-200 rounded">
                  <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                    <p className="text-sm font-medium text-gray-800">Repair result</p>
                  </div>
                  <div className="px-3 py-3 space-y-2">
                    {result.error ? (
                      <p className="text-xs text-red-700">{result.error}</p>
                    ) : (
                      <>
                        {result.message && <p className="text-xs text-gray-700">{result.message}</p>}
                        <p className="text-xs text-gray-700">
                          Attempted {result.attempted} · repaired {result.repaired} ·
                          still failing {result.stillFailing} · given up on {result.terminal}
                        </p>
                        {result.attempted > 0 && result.repaired === 0 && (
                          <p className="text-xs text-amber-700">No page was recovered on this run.</p>
                        )}
                        {result.remainingEligible > 0 && (
                          <p className="text-xs text-blue-700">
                            {result.remainingEligible} more page{result.remainingEligible === 1 ? '' : 's'} still
                            eligible — this run was capped. Run the repair again to continue.
                          </p>
                        )}
                        {result.terminalPages.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-red-700 mb-1">
                              Given up on (no further attempts will be made):
                            </p>
                            <PageOutcomeList pages={result.terminalPages} />
                          </div>
                        )}
                        {result.terminalPages.length === 0 && result.terminal > 0 && (
                          <p className="text-[11px] text-red-700">
                            {result.terminal} page{result.terminal === 1 ? '' : 's'} were given up on after
                            repeated failures.
                          </p>
                        )}
                        {result.failingPages.length > 0 && (
                          <div>
                            <p className="text-xs font-medium text-amber-700 mb-1">
                              Still failing (will be retried
                              {result.maxRepairAttempts ? `, up to ${result.maxRepairAttempts} attempts` : ''}):
                            </p>
                            <PageOutcomeList pages={result.failingPages} />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex-none px-5 py-3 border-t border-gray-200 flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-500">
            {selected.length > 0
              ? 'Only the pages listed above are attempted.'
              : 'No repair will be sent.'}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-sm px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded-md transition-colors"
            >
              Close
            </button>
            <button
              onClick={() => runFix()}
              disabled={!canRun}
              title={
                nothingToFix ? 'Nothing to repair — no page is missing from the index'
                  : allGivenUp ? 'Every remaining gap has already been given up on'
                  : onlyNeedsOcr && !includeOcr ? 'These pages have no extracted text; tick “force OCR” to attempt them'
                  : undefined
              }
              className="text-sm px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {running
                ? 'Repairing…'
                : selected.length > 0
                  ? `Repair ${selected.length} page${selected.length === 1 ? '' : 's'}`
                  : 'Repair'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { FixPartialResult };
