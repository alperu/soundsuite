/**
 * @jest-environment node
 *
 * `POST /api/documents/[id]/fix-partial` is almost entirely wiring: the two
 * modules it orchestrates (`partial-detection`, `repair-tracking`) are pure
 * and tested on their own. What can only break *here* is the wiring itself —
 * which pages get selected, which pages get sent, and what gets written back
 * — so that is what this covers:
 *
 *   - 'empty' pages are never selected (blank-by-design is not a gap)
 *   - terminal pages short-circuit instead of re-queueing
 *   - only the capped slice that was actually sent is recorded as attempted
 *   - a failed delegation does not re-read the page report, and its error is
 *     normalized so a width rejection goes terminal on attempt #1
 *   - an index that reads as empty refuses rather than burning OCR
 *
 * Everything with I/O is mocked in-suite — this repo has no global mocks
 * (jest.polyfills.js supplies TextEncoder/TextDecoder and nothing else) and
 * no test here touches the network, LanceDB or Prisma for real.
 */

const mockRequireAdminApiAccess = jest.fn();
const mockDocFindUnique = jest.fn();
const mockDocUpdate = jest.fn();
const mockPageCacheFindMany = jest.fn();
const mockPageScoreFindMany = jest.fn();
const mockPageReportGET = jest.fn();
const mockReindexPOST = jest.fn();
const mockLanceRows = jest.fn();
const mockTableNames = jest.fn();
const mockIndexRowCount = jest.fn();

jest.mock('@/lib/api/route-guard', () => ({
  requireAdminApiAccess: (...args: unknown[]) => mockRequireAdminApiAccess(...args),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    document: {
      findUnique: (...args: unknown[]) => mockDocFindUnique(...args),
      update: (...args: unknown[]) => mockDocUpdate(...args),
    },
    pageCache: { findMany: (...args: unknown[]) => mockPageCacheFindMany(...args) },
    pageScore: { findMany: (...args: unknown[]) => mockPageScoreFindMany(...args) },
  },
}));

jest.mock('@lancedb/lancedb', () => ({
  connect: async () => ({
    tableNames: () => mockTableNames(),
    openTable: async () => ({
      // `countRows()` backs the route's index-liveness probe. It asks the
      // INDEX whether it is readable, rather than inferring that from one
      // document's chunk count — see probeIndexHealth. Default: a live index.
      countRows: async () => mockIndexRowCount(),
      query: () => ({
        select: () => ({
          where: () => ({ toArray: async () => mockLanceRows() }),
        }),
      }),
    }),
  }),
}));

jest.mock('@/app/api/vectors/page-report/route', () => ({
  GET: (...args: unknown[]) => mockPageReportGET(...args),
}));

jest.mock('@/app/api/documents/[id]/reindex-pages/route', () => ({
  POST: (...args: unknown[]) => mockReindexPOST(...args),
}));

jest.mock('@/lib/sse-events', () => ({ publishDocumentEvent: jest.fn() }));

import { POST } from '../route';
import { MAX_REPAIR_ATTEMPTS, type RepairTags } from '@/lib/ingestion/repair-tracking';

const DOC_ID = 'doc-under-test';
const PAGE_COUNT = 10;

type PageStatus = 'indexed' | 'unindexed' | 'empty';

/** Build a page-report body: every page 'indexed' except the ones named. */
function report(overrides: Record<number, PageStatus>, totalChunks = 42) {
  const pages: Array<{ pageNumber: number; status: PageStatus; chunkCount: number }> = [];
  let unindexed = 0;
  let empty = 0;
  for (let n = 1; n <= PAGE_COUNT; n++) {
    const status = overrides[n] ?? 'indexed';
    if (status === 'unindexed') unindexed++;
    if (status === 'empty') empty++;
    pages.push({ pageNumber: n, status, chunkCount: status === 'indexed' ? 3 : 0 });
  }
  return {
    status: 200,
    json: async () => ({
      totalPages: PAGE_COUNT,
      pages,
      summary: { indexedPages: PAGE_COUNT - unindexed - empty, unindexedPages: unindexed, emptyPages: empty, totalChunks },
    }),
  };
}

function reindexOk(emptyPages: number[] = []) {
  return { status: 200, json: async () => ({ success: true, pagesProcessed: 1, chunksCreated: 1, emptyPages }) };
}

function request(body: Record<string, unknown> = {}): any {
  return { json: async () => body, headers: new Headers(), nextUrl: { pathname: `/api/documents/${DOC_ID}/fix-partial` } };
}

function ctx() {
  return { params: Promise.resolve({ id: DOC_ID }) };
}

function setDoc(opts: { status?: string; tags?: unknown; pageCount?: number | null; updatedAt?: Date } = {}) {
  const doc = {
    id: DOC_ID,
    caseId: 'case-1',
    pageCount: opts.pageCount === undefined ? PAGE_COUNT : opts.pageCount,
    status: opts.status ?? 'INDEXED',
    tags: opts.tags ?? {},
    // The stale-lock check reads this; default to 'just now' so a
    // FIXING_PARTIAL fixture reads as a live lock unless a test says otherwise.
    updatedAt: opts.updatedAt ?? new Date(),
  };
  // First call selects the full row; the pre-write re-read selects only tags.
  mockDocFindUnique.mockImplementation(async (args: any) =>
    args?.select?.tags && !args?.select?.status ? { tags: doc.tags } : doc,
  );
  return doc;
}

/** The repair map the route wrote back on its single document.update call. */
function writtenRepair(): RepairTags {
  const call = mockDocUpdate.mock.calls.at(-1)?.[0];
  return (call?.data?.tags as Record<string, RepairTags>)?.repair ?? {};
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdminApiAccess.mockResolvedValue(null);
  mockDocUpdate.mockResolvedValue({});
  mockPageCacheFindMany.mockResolvedValue([]);
  mockPageScoreFindMany.mockResolvedValue([]);
  mockTableNames.mockResolvedValue(['chunks']);
  // A live index by default: 30,961 rows is the real corpus count.
  mockIndexRowCount.mockResolvedValue(30961);
  // Pages 1-8 have vectors; 9 and 10 do not — so the doc reads as partial.
  mockLanceRows.mockReturnValue(
    Array.from({ length: 8 }, (_, i) => ({ document_id: DOC_ID, page_number: i + 1 })),
  );
});

describe('POST /api/documents/[id]/fix-partial — access + preconditions', () => {
  it('passes the admin guard refusal straight through without touching the document', async () => {
    const refusal = { status: 401 } as any;
    mockRequireAdminApiAccess.mockResolvedValue(refusal);

    const res = await POST(request(), ctx());

    expect(res).toBe(refusal);
    expect(mockDocFindUnique).not.toHaveBeenCalled();
  });

  it('409s when a repair is already in flight, so two runs cannot clobber the repair map', async () => {
    setDoc({ status: 'FIXING_PARTIAL' });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(409);
    expect(mockReindexPOST).not.toHaveBeenCalled();
  });

  it('refuses a document that has no page count', async () => {
    setDoc({ pageCount: null });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(400);
    expect(mockReindexPOST).not.toHaveBeenCalled();
  });

  // The liveness question is asked of the INDEX, not inferred from one
  // document's chunk count. These four pin that distinction.

  it('refuses when the chunks table is absent', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 1: 'unindexed' }));
    mockTableNames.mockResolvedValue([]);

    const res = await POST(request(), ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/no "chunks" table/i) });
    expect(mockReindexPOST).not.toHaveBeenCalled();
    expect(mockDocUpdate).not.toHaveBeenCalled();
  });

  it('refuses when the index holds no rows for anything', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 1: 'unindexed' }));
    mockIndexRowCount.mockResolvedValue(0);

    const res = await POST(request(), ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/index is empty/i) });
    expect(mockReindexPOST).not.toHaveBeenCalled();
  });

  it('refuses when counting rows throws', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 1: 'unindexed' }));
    mockIndexRowCount.mockRejectedValue(new Error('LanceDB socket closed'));

    const res = await POST(request(), ctx());

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/socket closed/i) });
  });

  it('REPAIRS a document with zero chunks when the index itself is healthy', async () => {
    // Regression. This asserted 503 on the premise that "an INDEXED document
    // with pages and zero chunks cannot occur legitimately". It can: six
    // documents in the live corpus had exactly that shape against an index
    // holding 30,961 rows with no orphaned ids — ingestion had marked them
    // INDEXED without ever writing a vector. The old guard fired on the
    // documents that most needed repair and blamed the index, which was fine.
    setDoc();
    mockPageReportGET
      .mockResolvedValueOnce(report({ 1: 'unindexed', 2: 'unindexed' }, /* totalChunks */ 0))
      .mockResolvedValueOnce(report({}, /* totalChunks */ 6));
    mockReindexPOST.mockResolvedValue(reindexOk());

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(mockReindexPOST).toHaveBeenCalled();
    const body = await res.json();
    expect(body.attemptedPages).toEqual([1, 2]);
  });

  it('refuses when the partial re-check cannot reach LanceDB', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 9: 'unindexed' }));
    mockTableNames.mockRejectedValue(new Error('LanceDB unavailable'));

    const res = await POST(request(), ctx());

    expect(res.status).toBe(503);
    expect(mockReindexPOST).not.toHaveBeenCalled();
  });
});

describe('POST /api/documents/[id]/fix-partial — page selection', () => {
  it('never selects blank-by-design pages', async () => {
    setDoc();
    // Page 9 is blank by design, page 10 is a real gap.
    mockPageReportGET
      .mockResolvedValueOnce(report({ 9: 'empty', 10: 'unindexed' }))
      .mockResolvedValueOnce(report({ 9: 'empty' }));
    mockReindexPOST.mockResolvedValue(reindexOk());

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(body.attemptedPages).toEqual([10]);
    const sent = await mockReindexPOST.mock.calls[0][0].json();
    expect(sent.pages).toEqual([10]);
  });

  it('short-circuits with a reason-code breakdown when every gap is terminal', async () => {
    setDoc({
      tags: {
        recordStatus: 'final',
        repair: {
          '9': { attempts: 3, lastAttemptAt: '2026-01-01T00:00:00.000Z', reasonCode: 'ocr-empty', reason: 'OCR produced no text', terminal: true },
          '10': { attempts: 1, lastAttemptAt: '2026-01-01T00:00:00.000Z', reasonCode: 'dimension-mismatch', reason: 'width mismatch', terminal: true },
        },
      },
    });
    mockPageReportGET.mockResolvedValue(report({ 9: 'unindexed', 10: 'unindexed' }));

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.requeued).toBe(false);
    expect(body.attempted).toBe(0);
    expect(mockReindexPOST).not.toHaveBeenCalled();
    expect(mockDocUpdate).not.toHaveBeenCalled();
    expect(body.terminalByReasonCode).toEqual({ 'ocr-empty': 1, 'dimension-mismatch': 1 });
    expect(body.terminal.map((t: any) => t.page)).toEqual([9, 10]);
    expect(body.terminal[0].reason).toContain('OCR produced no text');
  });

  it('records only the capped slice it actually sent, not every eligible page', async () => {
    setDoc();
    const gaps = { 5: 'unindexed', 6: 'unindexed', 7: 'unindexed', 8: 'unindexed' } as Record<number, PageStatus>;
    mockPageReportGET.mockResolvedValueOnce(report(gaps)).mockResolvedValueOnce(report(gaps));
    mockReindexPOST.mockResolvedValue(reindexOk());

    const res = await POST(request({ maxPages: 2 }), ctx());
    const body = await res.json();

    expect(body.attemptedPages).toEqual([5, 6]);
    expect(body.remainingEligible).toBe(2);
    // Pages 7 and 8 were never tried, so they must carry no attempt history.
    expect(Object.keys(writtenRepair()).sort()).toEqual(['5', '6']);
  });

  it('intersects an explicit page list with the eligible set instead of bypassing the bound', async () => {
    setDoc({
      tags: {
        repair: { '9': { attempts: 3, lastAttemptAt: '2026-01-01T00:00:00.000Z', reasonCode: 'ocr-empty', terminal: true } },
      },
    });
    mockPageReportGET
      .mockResolvedValueOnce(report({ 9: 'unindexed', 10: 'unindexed' }))
      .mockResolvedValueOnce(report({ 9: 'unindexed' }));
    mockReindexPOST.mockResolvedValue(reindexOk());

    // The caller asks for both — 9 is terminal and must be dropped.
    const res = await POST(request({ pages: [9, 10] }), ctx());
    const body = await res.json();

    expect(body.attemptedPages).toEqual([10]);
  });
});

describe('POST /api/documents/[id]/fix-partial — re-verify and bookkeeping', () => {
  it('clears repair history for a page that came back indexed', async () => {
    setDoc({
      tags: {
        recordStatus: 'final',
        repair: { '10': { attempts: 2, lastAttemptAt: '2026-01-01T00:00:00.000Z', reasonCode: 'unknown', terminal: false } },
      },
    });
    mockPageReportGET
      .mockResolvedValueOnce(report({ 10: 'unindexed' }))
      .mockResolvedValueOnce(report({})); // repaired
    mockReindexPOST.mockResolvedValue(reindexOk());

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(body.repaired).toBe(1);
    expect(body.repairedPages).toEqual([10]);
    expect(body.stillFailing).toEqual([]);
    expect(writtenRepair()['10']).toBeUndefined();
    // Unrelated tag keys survive the write.
    expect(mockDocUpdate.mock.calls[0][0].data.tags.recordStatus).toBe('final');
  });

  it("records 'ocr-empty' for a page reindex-pages reported empty, and stops at the attempt bound", async () => {
    setDoc({
      tags: {
        repair: { '10': { attempts: MAX_REPAIR_ATTEMPTS - 1, lastAttemptAt: '2026-01-01T00:00:00.000Z', reasonCode: 'ocr-empty', terminal: false } },
      },
    });
    mockPageReportGET
      .mockResolvedValueOnce(report({ 10: 'unindexed' }))
      .mockResolvedValueOnce(report({ 10: 'unindexed' })); // still broken
    mockReindexPOST.mockResolvedValue(reindexOk([10]));

    const res = await POST(request(), ctx());
    const body = await res.json();

    const entry = writtenRepair()['10'];
    expect(entry.attempts).toBe(MAX_REPAIR_ATTEMPTS);
    expect(entry.reasonCode).toBe('ocr-empty');
    expect(entry.terminal).toBe(true);
    expect(body.stillFailing).toHaveLength(1);
    expect(body.stillFailing[0]).toMatchObject({ page: 10, reasonCode: 'ocr-empty', attempts: MAX_REPAIR_ATTEMPTS });
    expect(body.terminalByReasonCode).toEqual({ 'ocr-empty': 1 });
  });

  it('does not re-read the page report when the delegated repair failed', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 10: 'unindexed' }));
    mockReindexPOST.mockResolvedValue({ status: 500, json: async () => ({ error: 'PDF render crashed' }) });

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(mockPageReportGET).toHaveBeenCalledTimes(1);
    expect(body.reindexError).toContain('PDF render crashed');
    const entry = writtenRepair()['10'];
    expect(entry.reasonCode).toBe('reindex-request-failed');
    // The reason IS recorded, so the operator can see why nothing happened —
    // but a failed reindex REQUEST says nothing about the page, so it must
    // not spend the page's retry budget. This asserted 1 until a real page
    // was permanently given up after three attempts against an embedding
    // model that did not exist on an OpenRouter-only install; fixing the
    // routing could not revive it. See isInfrastructureFailure.
    expect(entry.attempts).toBe(0);
    expect(entry.terminal).toBe(false);
  });

  it('goes terminal on the first attempt when the insert was rejected on vector width', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 10: 'unindexed' }));
    mockReindexPOST.mockResolvedValue({
      status: 500,
      json: async () => ({
        // The real insert path rethrows the raw LanceDB message, which never
        // contains the word "dimension" — the route normalizes it so the
        // systemic failure is not retried three times.
        error: 'Failed to insert chunks: Invalid argument error: column vector expects FixedSizeList(Float32, 1024)',
      }),
    });

    const res = await POST(request(), ctx());
    const body = await res.json();

    const entry = writtenRepair()['10'];
    expect(entry.reasonCode).toBe('dimension-mismatch');
    expect(entry.attempts).toBe(1);
    expect(entry.terminal).toBe(true);
    expect(body.terminalByReasonCode).toEqual({ 'dimension-mismatch': 1 });
  });

  it('delegates with FIXING_PARTIAL but always hands back INDEXED, so no run can strand the document', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValueOnce(report({ 10: 'unindexed' })).mockResolvedValueOnce(report({}));
    mockReindexPOST.mockResolvedValue(reindexOk());

    await POST(request(), ctx());

    const sent = await mockReindexPOST.mock.calls[0][0].json();
    expect(sent.processingStatus).toBe('FIXING_PARTIAL');
    expect(sent.statusAfterSuccess).toBe('INDEXED');
    expect(sent.progress).toEqual({ done: 0, total: 1 });
    expect((await mockReindexPOST.mock.calls[0][1].params).id).toBe(DOC_ID);
  });

  it('reports nothing to do when every page is indexed or blank', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 9: 'empty', 10: 'empty' }));

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(body.attempted).toBe(0);
    expect(body.requeued).toBe(false);
    expect(body.emptyPages).toBe(2);
    expect(mockReindexPOST).not.toHaveBeenCalled();
    expect(mockDocUpdate).not.toHaveBeenCalled();
  });

  it('previews without touching anything when dryRun is set', async () => {
    setDoc();
    mockPageReportGET.mockResolvedValue(report({ 10: 'unindexed' }));

    const res = await POST(request({ dryRun: true }), ctx());
    const body = await res.json();

    expect(body.dryRun).toBe(true);
    expect(body.attemptedPages).toEqual([10]);
    expect(mockReindexPOST).not.toHaveBeenCalled();
    expect(mockDocUpdate).not.toHaveBeenCalled();
  });

  it('re-arms terminal pages when the operator asks for a reset', async () => {
    setDoc({
      tags: {
        repair: { '10': { attempts: 1, lastAttemptAt: '2026-01-01T00:00:00.000Z', reasonCode: 'dimension-mismatch', terminal: true } },
      },
    });
    mockPageReportGET.mockResolvedValueOnce(report({ 10: 'unindexed' })).mockResolvedValueOnce(report({}));
    mockReindexPOST.mockResolvedValue(reindexOk());

    const res = await POST(request({ resetTerminal: true }), ctx());
    const body = await res.json();

    expect(body.attemptedPages).toEqual([10]);
    expect(body.repaired).toBe(1);
  });
});

describe('the FIXING_PARTIAL lock is honoured only while someone holds it', () => {
  // reindex-pages restores the previous status on success AND on throw, but
  // neither runs if the process holding the lock disappears. That happened
  // twice: a batch driver was killed, and a client body timeout
  // (UND_ERR_BODY_TIMEOUT) aborted an SSE run mid-document. The document then
  // sat in FIXING_PARTIAL and every later repair was refused with 409
  // forever — the "it says fixing and nothing happens" report itself.

  it('refuses while the lock is fresh, so two runs cannot clobber the repair map', async () => {
    setDoc({ status: 'FIXING_PARTIAL', updatedAt: new Date(Date.now() - 30_000) });

    const res = await POST(request(), ctx());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already running/i);
    expect(mockReindexPOST).not.toHaveBeenCalled();
  });

  it('reclaims a lock nothing has touched for longer than the stale window', async () => {
    // A live repair touches updatedAt every round (8 pages; the slowest single
    // page measured 107s), so this quiet means abandoned.
    setDoc({ status: 'FIXING_PARTIAL', updatedAt: new Date(Date.now() - 45 * 60_000) });
    mockPageReportGET
      .mockResolvedValueOnce(report({ 9: 'unindexed' }))
      .mockResolvedValueOnce(report({}));
    mockReindexPOST.mockResolvedValue(reindexOk());

    const res = await POST(request(), ctx());

    expect(res.status).toBe(200);
    expect(mockReindexPOST).toHaveBeenCalled();
  });

  it('refuses rather than reclaiming when updatedAt is unusable', async () => {
    // Fail closed: an unparseable timestamp is not evidence the lock is dead.
    setDoc({ status: 'FIXING_PARTIAL', updatedAt: new Date('not a date') });

    const res = await POST(request(), ctx());

    expect(res.status).toBe(409);
    expect(mockReindexPOST).not.toHaveBeenCalled();
  });
});
