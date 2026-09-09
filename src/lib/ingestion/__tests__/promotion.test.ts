/**
 * @jest-environment node
 */
import {
  planPromotion,
  applyPromotion,
  planRequeueErrored,
  applyRequeue,
} from '../promotion';

/** Minimal in-memory stand-in for the Prisma surface `promotion.ts` uses. */
function fakePrisma(docs: Array<{ id: string; caseId: string; status: string }>) {
  const calls = { updateMany: [] as any[] };
  const api = {
    document: {
      async groupBy({ where }: any) {
        const counts = new Map<string, number>();
        for (const d of docs) {
          if (d.status !== where.status) continue;
          counts.set(d.caseId, (counts.get(d.caseId) ?? 0) + 1);
        }
        // Deliberately unsorted — the planner must impose its own order.
        return [...counts.entries()]
          .reverse()
          .map(([caseId, n]) => ({ caseId, _count: { _all: n } }));
      },
      async findMany({ where, take }: any) {
        let out = docs.filter((d) => {
          if (where.caseId && d.caseId !== where.caseId) return false;
          if (typeof where.status === 'string' && d.status !== where.status) return false;
          if (where.status?.not && d.status === where.status.not) return false;
          if (where.id?.in && !where.id.in.includes(d.id)) return false;
          return true;
        });
        if (take) out = out.slice(0, take);
        return out.map((d) => ({ id: d.id }));
      },
      async count({ where }: any) {
        return docs.filter(
          (d) => d.status === where.status && (!where.caseId || d.caseId === where.caseId)
        ).length;
      },
      async updateMany({ where, data }: any) {
        calls.updateMany.push({ where, data });
        let n = 0;
        for (const d of docs) {
          if (!where.id.in.includes(d.id)) continue;
          if (where.status && d.status !== where.status) continue;
          d.status = data.status;
          n++;
        }
        return { count: n };
      },
    },
  };
  return { prisma: api as any, calls, docs };
}

const discovered = (caseId: string, n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${caseId}-${i + offset}`,
    caseId,
    status: 'DISCOVERED',
  }));

describe('planPromotion', () => {
  it('orders waves ascending by live DISCOVERED count, not by group-by order', async () => {
    const { prisma } = fakePrisma([
      ...discovered('big', 40),
      ...discovered('small', 3),
      ...discovered('mid', 10),
    ]);

    const plan = await planPromotion(prisma, { limit: 2 });

    expect(plan.waveOrder.map((w) => w.caseId)).toEqual(['small', 'mid', 'big']);
    // Smallest backlog first — a systemic failure surfaces on 3, not 40.
    expect(plan.caseId).toBe('small');
  });

  it('never returns more ids than the limit, and reports what is left behind', async () => {
    const { prisma } = fakePrisma(discovered('only', 25));

    const plan = await planPromotion(prisma, { limit: 10 });

    expect(plan.documentIds).toHaveLength(10);
    expect(plan.remainingInCase).toBe(15);
  });

  it('rejects a missing or non-positive limit rather than defaulting to the backlog', async () => {
    const { prisma } = fakePrisma(discovered('c', 5));

    await expect(planPromotion(prisma, { limit: 0 })).rejects.toThrow(/positive integer/);
    await expect(planPromotion(prisma, { limit: -1 })).rejects.toThrow(/positive integer/);
    await expect(planPromotion(prisma, { limit: 1.5 })).rejects.toThrow(/positive integer/);
  });

  it('honours an explicit case even when it is not the smallest', async () => {
    const { prisma } = fakePrisma([...discovered('small', 2), ...discovered('big', 9)]);

    const plan = await planPromotion(prisma, { limit: 3, caseId: 'big' });

    expect(plan.caseId).toBe('big');
    expect(plan.documentIds.every((id) => id.startsWith('big-'))).toBe(true);
  });

  it('returns an empty plan when nothing is DISCOVERED', async () => {
    const { prisma } = fakePrisma([{ id: 'a', caseId: 'c', status: 'INDEXED' }]);

    const plan = await planPromotion(prisma, { limit: 5 });

    expect(plan.caseId).toBeNull();
    expect(plan.documentIds).toEqual([]);
  });

  it('writes nothing — planning is the dry run', async () => {
    const { prisma, calls } = fakePrisma(discovered('c', 5));
    await planPromotion(prisma, { limit: 5 });
    expect(calls.updateMany).toHaveLength(0);
  });
});

describe('applyPromotion', () => {
  it('promotes DISCOVERED → QUEUED and touches no other field', async () => {
    const { prisma, calls, docs } = fakePrisma(discovered('c', 4));
    const plan = await planPromotion(prisma, { limit: 2 });

    const res = await applyPromotion(prisma, plan);

    expect(res.promoted).toBe(2);
    expect(docs.filter((d) => d.status === 'QUEUED')).toHaveLength(2);
    // Unfiled promotion: status only. Assigning a filingId here would opt the
    // document into worker-init's uncapped cross-restart requeue.
    expect(Object.keys(calls.updateMany[0].data)).toEqual(['status']);
  });

  it('leaves a document that changed state between plan and apply alone', async () => {
    const { prisma, docs } = fakePrisma(discovered('c', 3));
    const plan = await planPromotion(prisma, { limit: 3 });

    // Something else moved one of them in the meantime.
    docs[1].status = 'INDEXED';

    const res = await applyPromotion(prisma, plan);

    expect(res.promoted).toBe(2);
    expect(res.skipped).toEqual(['c-1']);
    expect(docs[1].status).toBe('INDEXED');
  });

  it('refuses a plan whose id list exceeds its own limit', async () => {
    const { prisma } = fakePrisma(discovered('c', 3));
    const plan = await planPromotion(prisma, { limit: 3 });
    const tampered = { ...plan, limit: 1 };

    await expect(applyPromotion(prisma, tampered)).rejects.toThrow(/limit is 1/);
  });
});

describe('planRequeueErrored / applyRequeue', () => {
  it('bounds the requeue and clears the stale cause', async () => {
    const { prisma, calls, docs } = fakePrisma([
      { id: 'e1', caseId: 'c', status: 'ERROR' },
      { id: 'e2', caseId: 'c', status: 'ERROR' },
      { id: 'e3', caseId: 'c', status: 'ERROR' },
    ]);

    const plan = await planRequeueErrored(prisma, { limit: 2 });
    expect(plan.erroredTotal).toBe(3);
    expect(plan.documentIds).toHaveLength(2);

    const res = await applyRequeue(prisma, plan);

    expect(res.promoted).toBe(2);
    expect(calls.updateMany[0].data).toEqual({ status: 'QUEUED', errorMessage: null });
    expect(docs.filter((d) => d.status === 'ERROR')).toHaveLength(1);
  });

  it('requires a positive limit', async () => {
    const { prisma } = fakePrisma([{ id: 'e1', caseId: 'c', status: 'ERROR' }]);
    await expect(planRequeueErrored(prisma, { limit: 0 })).rejects.toThrow(/positive integer/);
  });
});
