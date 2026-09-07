/**
 * @jest-environment node
 *
 * `pickMotionForPage` — the rule that maps a retrieved chunk's page to a
 * motion id (REPORT-discovery-tools §5). Motions nest and `endPage` is
 * nullable, so a page can sit inside several ranges at once; this task exists
 * to stop tools silently picking the wrong id, so the choice must be stated
 * and deterministic.
 *
 * Synthetic ranges only — no real pagination.
 */

import { pickMotionForPage, attachMotionIds } from '../../motion-resolution';
import { makeContext, fixedFindMany } from './discovery-harness';

const m = (id: string, startPage: number, endPage: number | null) => ({
  id,
  filingId: 'filing-1',
  startPage,
  endPage,
});

describe('pickMotionForPage', () => {
  it('returns nothing when no range contains the page', () => {
    expect(pickMotionForPage([m('a', 10, 20)], 3)).toBeUndefined();
    expect(pickMotionForPage([], 3)).toBeUndefined();
  });

  it('picks the only containing range, inclusive of both bounds', () => {
    expect(pickMotionForPage([m('a', 5, 9)], 5)?.id).toBe('a');
    expect(pickMotionForPage([m('a', 5, 9)], 9)?.id).toBe('a');
  });

  it('prefers the narrowest range — the innermost nested motion wins', () => {
    const parent = m('parent', 1, 100);
    const child = m('child', 40, 50);
    expect(pickMotionForPage([parent, child], 45)?.id).toBe('child');
    // Outside the child, the parent still answers.
    expect(pickMotionForPage([parent, child], 60)?.id).toBe('parent');
  });

  it('ranks an open-ended motion last — it never beats a bounded one', () => {
    const open = m('open', 1, null);
    const bounded = m('bounded', 1, 100);
    expect(pickMotionForPage([open, bounded], 50)?.id).toBe('bounded');
    // But it is still better than no answer at all.
    expect(pickMotionForPage([open], 5000)?.id).toBe('open');
  });

  it('breaks equal-span ties on id so the choice is stable across runs', () => {
    const a = m('aaa', 1, 10);
    const b = m('bbb', 1, 10);
    expect(pickMotionForPage([b, a], 5)?.id).toBe('aaa');
    expect(pickMotionForPage([a, b], 5)?.id).toBe('aaa');
  });
});

describe('attachMotionIds', () => {
  const results = () => [
    { documentId: 'doc-1', page: 3 }, // filing-1, inside motion-a
    { documentId: 'doc-2', page: 3 }, // filing-1 too (same filing, other doc)
    { documentId: 'doc-3', page: 42 }, // filing-2, inside motion-c
    { documentId: 'doc-3', page: 900 }, // filing-2, inside nothing
    { documentId: 'doc-4', page: 1 }, // no filing at all
  ];
  const docFilingIds = () =>
    new Map([
      ['doc-1', 'filing-1'],
      ['doc-2', 'filing-1'],
      ['doc-3', 'filing-2'],
    ]);

  it('issues exactly one query for the whole result set, never one per item', async () => {
    const findMany = fixedFindMany([]);
    const ctx = makeContext({ motion: { findMany } });

    await attachMotionIds(ctx, results(), docFilingIds());

    expect(findMany).toHaveBeenCalledTimes(1);
    // Bounded: the distinct filing ids of the returned hits, nothing wider.
    expect(findMany.mock.calls[0][0].where).toEqual({
      filingId: { in: ['filing-1', 'filing-2'] },
    });
  });

  it('stamps motionId on the rows that match and leaves the others absent', async () => {
    const ctx = makeContext({
      motion: {
        findMany: fixedFindMany([
          { id: 'motion-a', filingId: 'filing-1', startPage: 1, endPage: 10 },
          { id: 'motion-b', filingId: 'filing-1', startPage: 11, endPage: 20 },
          { id: 'motion-c', filingId: 'filing-2', startPage: 40, endPage: 50 },
        ]),
      },
    });
    const rows = results();

    await attachMotionIds(ctx, rows, docFilingIds());

    expect(rows.map((r: any) => r.motionId)).toEqual([
      'motion-a',
      'motion-a',
      'motion-c',
      undefined, // page outside every range
      undefined, // document maps to no filing
    ]);
  });

  it('skips the query entirely when no hit maps to a filing', async () => {
    const findMany = fixedFindMany([]);
    await attachMotionIds(makeContext({ motion: { findMany } }), results(), new Map());
    expect(findMany).not.toHaveBeenCalled();
  });

  it('ships results without motionId when the motion lookup fails', async () => {
    const ctx = makeContext({
      motion: { findMany: jest.fn().mockRejectedValue(new Error('no such table: Motion')) },
    });
    const rows = results();

    await expect(attachMotionIds(ctx, rows, docFilingIds())).resolves.toBeUndefined();

    expect(rows.every((r: any) => r.motionId === undefined)).toBe(true);
  });
});
