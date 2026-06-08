/**
 * Tests for graph-expand traversal. Prisma is mocked with a small in-memory
 * motion store whose findUnique/findMany interpret the exact `where` shapes the
 * module builds.
 */

type M = {
  id: string; title: string; caseId: string | null; filingId: string;
  revisionSeq: number | null; parentMotionId: string | null;
  amendsId: string | null; supersedesId: string | null;
  judgeId: string | null; movantId: string | null; respondentId: string | null;
};

const mk = (over: Partial<M> & { id: string }): M => ({
  title: `Motion ${over.id}`, caseId: 'case1', filingId: 'f1', revisionSeq: null,
  parentMotionId: null, amendsId: null, supersedesId: null,
  judgeId: null, movantId: null, respondentId: null, ...over,
});

let STORE: M[] = [];

jest.mock('../../db/prisma', () => ({
  prisma: {
    motion: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(STORE.find((m) => m.id === where.id) ?? null)),
      findMany: jest.fn(({ where }: any) => {
        if (where?.id?.in) return Promise.resolve(STORE.filter((m) => where.id.in.includes(m.id)));
        // Downward amendment edges: motions pointing at the frontier.
        if (Array.isArray(where?.OR) && where.OR.some((c: any) => 'parentMotionId' in c || 'amendsId' in c || 'supersedesId' in c)) {
          const ids: string[] = where.OR.flatMap((c: any) => (Object.values(c)[0] as any)?.in ?? []);
          return Promise.resolve(STORE.filter((m) =>
            ids.includes(m.parentMotionId!) || ids.includes(m.amendsId!) || ids.includes(m.supersedesId!)));
        }
        // motionsByPerson / relatedMotions: OR of role clauses (+ optional caseId / id not).
        if (Array.isArray(where?.OR)) {
          let rows = STORE.filter((m) => where.OR.some((c: any) =>
            (c.judgeId && m.judgeId === c.judgeId) ||
            (c.movantId && m.movantId === c.movantId) ||
            (c.respondentId && m.respondentId === c.respondentId)));
          if (where.caseId?.in) rows = rows.filter((m) => where.caseId.in.includes(m.caseId));
          if (where.caseId && typeof where.caseId === 'string') rows = rows.filter((m) => m.caseId === where.caseId);
          if (where.id?.not) rows = rows.filter((m) => m.id !== where.id.not);
          return Promise.resolve(rows);
        }
        return Promise.resolve([]);
      }),
    },
  },
}));

import { amendmentLineage, motionsByPerson, relatedMotions } from '../graph-expand';

beforeEach(() => { STORE = []; });

describe('amendmentLineage', () => {
  it('walks ancestors (parent) and descendants (children) of a seed', async () => {
    STORE = [
      mk({ id: 'p1', revisionSeq: 1 }),
      mk({ id: 's1', parentMotionId: 'p1', revisionSeq: 2 }),
      mk({ id: 'c1', parentMotionId: 's1', revisionSeq: 3 }),
    ];
    const lineage = await amendmentLineage('s1');
    const ids = lineage.map((n) => n.id).sort();
    expect(ids).toEqual(['c1', 'p1']); // seed excluded; both directions reached
  });

  it('follows amends/supersedes pointers', async () => {
    STORE = [
      mk({ id: 'orig' }),
      mk({ id: 's1', amendsId: 'orig' }),
      mk({ id: 'newer', supersedesId: 's1' }),
    ];
    const ids = (await amendmentLineage('s1')).map((n) => n.id).sort();
    expect(ids).toEqual(['newer', 'orig']);
  });

  it('respects caseScope', async () => {
    STORE = [
      mk({ id: 'p1', caseId: 'caseB' }),
      mk({ id: 's1', parentMotionId: 'p1', caseId: 'case1' }),
    ];
    expect(await amendmentLineage('s1', { caseScope: ['case1'] })).toHaveLength(0); // p1 out of scope
  });

  it('returns [] for an unknown motion', async () => {
    expect(await amendmentLineage('nope')).toEqual([]);
  });
});

describe('motionsByPerson', () => {
  it('finds motions where the person is judge/movant/respondent', async () => {
    STORE = [
      mk({ id: 'm1', judgeId: 'pX' }),
      mk({ id: 'm2', movantId: 'pX' }),
      mk({ id: 'm3', judgeId: 'other' }),
    ];
    const ids = (await motionsByPerson('pX')).map((n) => n.id).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('filters by role', async () => {
    STORE = [mk({ id: 'm1', judgeId: 'pX' }), mk({ id: 'm2', movantId: 'pX' })];
    const ids = (await motionsByPerson('pX', { role: 'judge' })).map((n) => n.id);
    expect(ids).toEqual(['m1']);
  });
});

describe('relatedMotions', () => {
  it('finds same-case motions sharing the seed judge', async () => {
    STORE = [
      mk({ id: 'seed', judgeId: 'jA', caseId: 'case1' }),
      mk({ id: 'sibling', judgeId: 'jA', caseId: 'case1' }),
      mk({ id: 'otherCase', judgeId: 'jA', caseId: 'case2' }),
      mk({ id: 'otherJudge', judgeId: 'jB', caseId: 'case1' }),
    ];
    const ids = (await relatedMotions('seed')).map((n) => n.id);
    expect(ids).toEqual(['sibling']);
  });

  it('returns [] when the seed has no judge or movant', async () => {
    STORE = [mk({ id: 'seed', caseId: 'case1' })];
    expect(await relatedMotions('seed')).toEqual([]);
  });
});
