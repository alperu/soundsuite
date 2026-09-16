/**
 * @jest-environment node
 *
 * The runner's whole reason to exist is that it does NOT believe the repair
 * endpoint. These tests pin that: a repair that claims success while LanceDB
 * still has no rows for the page must be reported, not smoothed over.
 *
 * The shapes below are the ones actually observed on 2026-09-16:
 *  · a repair that reported `repairedPages: [11,12,15,...]` after logging
 *    "Chunking: 9 non-empty pages -> 0 page chunks" — success, nothing written
 *  · six documents marked INDEXED with zero indexed pages
 *  · pages with textDensity 0 and no preview, which the panel nonetheless
 *    described as "have extracted text but produced no chunks"
 */

import {
  repairDocument,
  repairAllPartials,
  type PageReportPage,
} from '../partial-repair-runner';

const BASE = 'http://master.test';

function page(pageNumber: number, status: PageReportPage['status'], extra: Partial<PageReportPage> = {}): PageReportPage {
  return { pageNumber, status, textDensity: status === 'unindexed' ? 500 : 900, textPreview: 'text', ...extra };
}

/**
 * Scripted fetch. `reports` is consumed one page-report at a time so a test
 * can describe "before" and "after" states independently.
 */
function makeFetch(opts: {
  reports: Array<PageReportPage[]>;
  fixPartial?: Array<Record<string, unknown>>;
  onFixPartial?: (body: unknown) => void;
}) {
  let reportIdx = 0;
  let fixIdx = 0;
  const calls = { report: 0, fix: 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/vectors/page-report')) {
      calls.report++;
      const pages = opts.reports[Math.min(reportIdx++, opts.reports.length - 1)];
      return new Response(JSON.stringify({ pages, totalPages: pages.length }), { status: 200 });
    }
    if (String(url).includes('/fix-partial')) {
      calls.fix++;
      opts.onFixPartial?.(init?.body ? JSON.parse(String(init.body)) : {});
      const body = opts.fixPartial?.[Math.min(fixIdx++, opts.fixPartial.length - 1)] ?? {};
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (String(url).includes('/api/documents/partial-status')) {
      return new Response(JSON.stringify({ partialDocumentIds: ['doc-a', 'doc-b'] }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('the runner verifies against LanceDB, not against the repair endpoint', () => {
  it('reports pages the endpoint claimed but page-report does not confirm', async () => {
    // This is the observed defect: success reported, nothing written.
    const { fetchImpl } = makeFetch({
      reports: [
        [page(1, 'indexed'), page(11, 'unindexed'), page(12, 'unindexed')],
        // after: unchanged — the vectors were never written
        [page(1, 'indexed'), page(11, 'unindexed'), page(12, 'unindexed')],
      ],
      fixPartial: [{ repairedPages: [11, 12], unindexedAfter: 0, remainingEligible: 0 }],
    });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-1');

    expect(r.verdict).toBe('no-progress');
    expect(r.repaired).toEqual([]);            // nothing CONFIRMED
    expect(r.unverified).toEqual([11, 12]);    // claimed but absent
    expect(r.pagesAfter).toBe(2);
  });

  it('confirms a genuine repair', async () => {
    const { fetchImpl } = makeFetch({
      reports: [
        [page(1, 'indexed'), page(8, 'unindexed')],
        [page(1, 'indexed'), page(8, 'indexed')],
      ],
      fixPartial: [{ repairedPages: [8], unindexedAfter: 0, remainingEligible: 0 }],
    });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-1');

    expect(r.verdict).toBe('fixed');
    expect(r.repaired).toEqual([8]);
    expect(r.unverified).toEqual([]);
  });

  it('calls a partial repair partial, not fixed', async () => {
    const { fetchImpl } = makeFetch({
      reports: [
        [page(9, 'indexed'), page(1, 'unindexed'), page(2, 'unindexed')],
        [page(9, 'indexed'), page(1, 'indexed'), page(2, 'unindexed')],
      ],
      fixPartial: [{ repairedPages: [1], unindexedAfter: 1, remainingEligible: 0 }],
    });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-1');
    expect(r.verdict).toBe('partial');
    expect(r.repaired).toEqual([1]);
    expect(r.pagesAfter).toBe(1);
  });
});

describe('populations that per-page repair cannot fix', () => {
  it('flags a document with zero indexed pages as needing re-ingest, without attempting repair', async () => {
    const pages = Array.from({ length: 198 }, (_, i) => page(i + 1, 'unindexed'));
    const { fetchImpl, calls } = makeFetch({ reports: [pages] });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-zero');

    expect(r.verdict).toBe('needs-reingest');
    // The point: it did NOT fire 198 one-page repairs to learn this.
    expect(calls.fix).toBe(0);
    expect(r.pagesAfter).toBe(198);
  });

  it('still repairs a zero-indexed document when explicitly asked', async () => {
    const { fetchImpl, calls } = makeFetch({
      reports: [[page(1, 'unindexed')], [page(1, 'indexed')]],
      fixPartial: [{ repairedPages: [1], unindexedAfter: 0, remainingEligible: 0 }],
    });
    const r = await repairDocument({ baseUrl: BASE, fetchImpl, includeZeroIndexed: true }, 'doc-zero');
    expect(calls.fix).toBe(1);
    expect(r.verdict).toBe('fixed');
  });

  // Regression: textDensity 0 is NOT evidence that a page has no text.
  //
  // Two pages of a real 154-page document reported exactly this shape and
  // were skipped as unfixable. Repairing them anyway took 5s and both came
  // back indexed at density 938 and 524 from plain extraction. The zero was
  // stale PageScore provenance, not an empty page. Trusting it would have
  // abandoned 69 recoverable pages across two documents.
  it('attempts a density-0 page instead of writing it off', async () => {
    const { fetchImpl, calls } = makeFetch({
      reports: [
        [page(1, 'indexed'), page(40, 'unindexed', { textDensity: 0, textPreview: '', source: 'extract' })],
        [page(1, 'indexed'), page(40, 'indexed', { textDensity: 938 })],
      ],
      fixPartial: [{ repairedPages: [40], unindexedAfter: 0, remainingEligible: 0 }],
    });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-stale-density');

    expect(calls.fix).toBe(1);          // it tried
    expect(r.verdict).toBe('fixed');
    expect(r.repaired).toEqual([40]);
  });

  it('skips only pages the index itself calls blank by design', async () => {
    // status 'empty' comes from PageCache/PageScore source === 'empty' — the
    // one signal that actually means "no text on this page".
    const { fetchImpl, calls } = makeFetch({
      reports: [[page(1, 'indexed'), page(40, 'empty')]],
    });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-blank');

    // An 'empty' page is not 'unindexed', so there is no gap to repair at all.
    expect(r.verdict).toBe('fixed');
    expect(calls.fix).toBe(0);
  });
});

describe('looping', () => {
  it('POSTs again while progress continues, since one call repairs at most maxPages', async () => {
    const { fetchImpl, calls } = makeFetch({
      reports: [
        [page(9, 'indexed'), page(1, 'unindexed'), page(2, 'unindexed'), page(3, 'unindexed')],
        [page(9, 'indexed'), page(1, 'indexed'), page(2, 'indexed'), page(3, 'indexed')],
      ],
      fixPartial: [
        { repairedPages: [1], unindexedAfter: 2, remainingEligible: 2 },
        { repairedPages: [2], unindexedAfter: 1, remainingEligible: 1 },
        { repairedPages: [3], unindexedAfter: 0, remainingEligible: 0 },
      ],
    });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-loop');
    expect(calls.fix).toBe(3);
    expect(r.rounds).toBe(3);
    expect(r.verdict).toBe('fixed');
  });

  it('stops instead of spinning when a round makes no progress', async () => {
    const { fetchImpl, calls } = makeFetch({
      reports: [
        [page(9, 'indexed'), page(1, 'unindexed'), page(2, 'unindexed')],
        [page(9, 'indexed'), page(1, 'unindexed'), page(2, 'unindexed')],
      ],
      fixPartial: [{ repairedPages: [], unindexedAfter: 2, remainingEligible: 2 }],
    });

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-stuck');
    expect(calls.fix).toBe(1);
    expect(r.verdict).toBe('no-progress');
  });

  it('re-arms terminal pages only on the first round', async () => {
    const bodies: Array<{ resetTerminal?: boolean }> = [];
    const { fetchImpl } = makeFetch({
      reports: [
        [page(9, 'indexed'), page(1, 'unindexed'), page(2, 'unindexed')],
        [page(9, 'indexed'), page(1, 'indexed'), page(2, 'indexed')],
      ],
      fixPartial: [
        { repairedPages: [1], unindexedAfter: 1, remainingEligible: 1 },
        { repairedPages: [2], unindexedAfter: 0, remainingEligible: 0 },
      ],
      onFixPartial: (b) => bodies.push(b as { resetTerminal?: boolean }),
    });

    await repairDocument({ baseUrl: BASE, fetchImpl, resetTerminal: true }, 'doc-reset');

    // Re-arming every round would loop forever on a genuinely dead page.
    expect(bodies.map((b) => b.resetTerminal)).toEqual([true, false]);
  });
});

describe('the corpus run', () => {
  it('totals confirmed repairs and honours a stop request between documents', async () => {
    const { fetchImpl } = makeFetch({
      reports: [
        [page(1, 'indexed'), page(2, 'unindexed')],
        [page(1, 'indexed'), page(2, 'indexed')],
      ],
      fixPartial: [{ repairedPages: [2], unindexedAfter: 0, remainingEligible: 0 }],
    });

    let seen = 0;
    const summary = await repairAllPartials({
      baseUrl: BASE, fetchImpl,
      onProgress: () => { seen++; },
      shouldStop: () => seen >= 1,   // stop after the first document
    });

    expect(summary.results).toHaveLength(1);
    expect(summary.totals.documentsFixed).toBe(1);
    expect(summary.totals.pagesRepaired).toBe(1);
  });

  it('surfaces a failed repair call as an error verdict rather than throwing', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/api/vectors/page-report')) {
        return new Response(JSON.stringify({
          pages: [page(1, 'indexed'), page(2, 'unindexed')], totalPages: 2,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'embedding provider unreachable' } }), { status: 500 });
    }) as unknown as typeof fetch;

    const r = await repairDocument({ baseUrl: BASE, fetchImpl }, 'doc-err');
    expect(r.verdict).toBe('error');
    expect(r.error).toMatch(/embedding provider unreachable/);
  });
});
