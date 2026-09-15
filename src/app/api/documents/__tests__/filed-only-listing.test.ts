/** @jest-environment node */
/**
 * The case document list shows documents a filing references, and nothing else.
 *
 * This is the regression guard for a divergence that made one real case render
 * 24 documents and then jump to 488: `src/app/page.tsx` filtered
 * `filingId: { not: null }` server-side, this route did not, and
 * `document-grid.tsx` re-fetches from here on mount and every 2 s — so the
 * correct server render was immediately overwritten by the whole table.
 *
 * The second test is the one that matters most. Bulk promotion is deliberately
 * *unfiled* (`PROMOTION_MODE_RATIONALE`): it moves documents
 * DISCOVERED → QUEUED → INDEXED while leaving `filingId` NULL. So filtering on
 * `status === 'DISCOVERED'` — the obvious reading of "hide the discovered
 * PDFs" — would have hidden nothing at all in the case that prompted this fix,
 * where every unwanted row was QUEUED or INDEXED and not one was DISCOVERED.
 */

const findMany = jest.fn();
const count = jest.fn();

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    document: {
      findMany: (...args: unknown[]) => findMany(...args),
      count: (...args: unknown[]) => count(...args),
    },
  },
}));
jest.mock('@/lib/redis', () => ({
  getRedis: () => ({ pipeline: () => ({ hgetall: jest.fn(), exec: jest.fn() }) }),
  isRedisAvailable: async () => false,
}));

import { GET } from '../route';

function req(url: string) {
  return { nextUrl: new URL(url) } as unknown as Parameters<typeof GET>[0];
}

const CASE = 'case-synthetic-0001';

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  count.mockReset().mockResolvedValue(0);
});

describe('GET /api/documents — filed-only by default', () => {
  it('filters on filingId, so unfiled rows never reach the grid', async () => {
    await GET(req(`http://localhost/api/documents?caseId=${CASE}`));

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({
      caseId: CASE,
      filingId: { not: null },
    });
  });

  it('does NOT filter on status — promotion leaves unfiled docs QUEUED/INDEXED', async () => {
    // A status predicate is the tempting fix and it is the wrong one: the case
    // that prompted this held 455 QUEUED + 5 INDEXED + 4 PROCESSING unfiled
    // rows and zero DISCOVERED ones.
    await GET(req(`http://localhost/api/documents?caseId=${CASE}`));

    const where = findMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('status');
    expect(JSON.stringify(where)).not.toContain('DISCOVERED');
  });

  it('reports how many were hidden, so the omission is never silent', async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(464);

    const res = await GET(req(`http://localhost/api/documents?caseId=${CASE}`));
    const body = await res.json();

    expect(count).toHaveBeenCalledWith({ where: { caseId: CASE, filingId: null } });
    expect(body.unfiledHidden).toBe(464);
  });
});

describe('GET /api/documents — includeUnfiled escape hatch', () => {
  it('drops the filing predicate when asked', async () => {
    await GET(req(`http://localhost/api/documents?caseId=${CASE}&includeUnfiled=1`));

    expect(findMany.mock.calls[0][0].where).toEqual({ caseId: CASE });
  });

  it('skips the count query entirely when nothing is hidden', async () => {
    const res = await GET(req(`http://localhost/api/documents?caseId=${CASE}&includeUnfiled=1`));

    expect(count).not.toHaveBeenCalled();
    expect((await res.json()).unfiledHidden).toBe(0);
  });

  it('only the exact opt-in value counts — anything else stays filtered', async () => {
    // A caller that passes includeUnfiled=0/true/'' must not silently get the
    // 488-row listing back.
    for (const v of ['0', 'true', '', 'yes']) {
      findMany.mockClear();
      await GET(req(`http://localhost/api/documents?caseId=${CASE}&includeUnfiled=${v}`));
      expect(findMany.mock.calls[0][0].where).toEqual({
        caseId: CASE,
        filingId: { not: null },
      });
    }
  });
});
