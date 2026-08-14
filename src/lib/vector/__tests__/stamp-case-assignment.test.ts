/**
 * @jest-environment node
 *
 * Node for the same reason as vector-store.test.ts: importing the vector store
 * pulls in apache-arrow, which needs TextDecoder at import time (task #53).
 */

/**
 * Unit tests for `VectorStore.stampCaseAssignment` — the vector half of a
 * filing move (task #50). The LanceDB table is a stub: these assert the
 * method's own contract (batching, escaping, failure signalling), not
 * LanceDB's behaviour.
 */

import { VectorStore } from '../vector-store';

interface UpdateCall {
  where: string;
  values: Record<string, unknown>;
}

/** A VectorStore wired to a stub table, bypassing initialize(). */
function storeWithStubTable(onUpdate?: () => void): {
  store: VectorStore;
  calls: UpdateCall[];
} {
  const calls: UpdateCall[] = [];
  const store = new VectorStore({ dbPath: '/tmp/unused', tableName: 'chunks' });
  const table = {
    update: jest.fn(async (args: UpdateCall) => {
      calls.push(args);
      onUpdate?.();
    }),
  };
  // The db/table handles are private; a stub is injected rather than mocking
  // the whole lancedb module so these tests exercise the real method body.
  (store as unknown as { db: unknown }).db = {};
  (store as unknown as { table: unknown }).table = table;
  return { store, calls };
}

describe('VectorStore.stampCaseAssignment', () => {
  it('writes both case fields for a small batch in one update', async () => {
    const { store, calls } = storeWithStubTable();

    const stamped = await store.stampCaseAssignment(['doc-a', 'doc-b'], 'case-1', 'NO-1');

    expect(stamped).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual({ case_id: 'case-1', case_number: 'NO-1' });
    expect(calls[0].where).toBe(`document_id IN ('doc-a', 'doc-b')`);
  });

  it('splits into 500-id batches and covers every id exactly once', async () => {
    const { store, calls } = storeWithStubTable();
    const ids = Array.from({ length: 1200 }, (_, i) => `doc-${i}`);

    const stamped = await store.stampCaseAssignment(ids, 'case-1', 'NO-1');

    expect(stamped).toBe(1200);
    expect(calls).toHaveLength(3);
    // 500 / 500 / 200 — an unbounded IN-list is the thing being avoided.
    const perCall = calls.map(c => (c.where.match(/'/g)?.length ?? 0) / 2);
    expect(perCall).toEqual([500, 500, 200]);
    const seen = calls.flatMap(c => c.where.match(/'([^']*)'/g) ?? []);
    expect(new Set(seen).size).toBe(1200);
  });

  it("escapes single quotes so an id can't break out of the predicate", async () => {
    const { store, calls } = storeWithStubTable();

    await store.stampCaseAssignment([`doc-o'brien`], 'case-1', 'NO-1');

    // Doubled, per SQL string-literal escaping — not stripped, or the id would
    // no longer match the row it names.
    expect(calls[0].where).toBe(`document_id IN ('doc-o''brien')`);
  });

  it('does nothing and reports 0 when there are no documents', async () => {
    const { store, calls } = storeWithStubTable();

    await expect(store.stampCaseAssignment([], 'case-1', 'NO-1')).resolves.toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('rethrows when the table update fails, so a committed SQL move learns of the divergence', async () => {
    const { store } = storeWithStubTable(() => {
      throw new Error('lance unavailable');
    });

    await expect(store.stampCaseAssignment(['doc-a'], 'case-1', 'NO-1')).rejects.toThrow(
      'lance unavailable',
    );
  });

  it('throws rather than reporting success when the store was never initialized', async () => {
    // The bug this guards: folding this case into the empty-list early return
    // made an unavailable store look like a successful no-op stamp, leaving
    // chunks on the old case while the caller reported ok.
    const store = new VectorStore({ dbPath: '/tmp/unused', tableName: 'chunks' });

    await expect(store.stampCaseAssignment(['doc-a'], 'case-1', 'NO-1')).rejects.toThrow(
      /not initialized/i,
    );
  });
});
