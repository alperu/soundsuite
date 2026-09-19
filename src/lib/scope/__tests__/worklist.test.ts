/** @jest-environment node */

/**
 * The lifted judgment queue: defining-slot-empty, never any-ref-empty.
 * Synthetic cases only.
 */
import { buildWorklist, countDefiningSlotEmpty, definingSlotEmptyFilings } from '../worklist';
import { buildScopeGraph } from '@/components/haystack-block-view/scope-graph';
import type { ScopeCase, ScopeFiling } from '@/components/haystack-block-view/types';

function filing(id: string, primaryKind: string, label: string, extra: Partial<ScopeFiling> = {}): ScopeFiling {
  return {
    id,
    filingType: primaryKind,
    label,
    filingDate: null,
    docCount: 1,
    indexedCount: 1,
    refs: {},
    documents: [{ id: `${id}-doc`, status: 'INDEXED' }],
    entityKinds: [primaryKind],
    primaryKind,
    ...extra,
  };
}

function caseOf(id: string, filings: ScopeFiling[]): ScopeCase {
  return { id, name: `Case ${id}`, filings, unfiledDocCount: 0, unfiledIndexedCount: 0 };
}

describe('definingSlotEmptyFilings', () => {
  it('lists a response with no respondingTo even when it already has a motionRef', () => {
    const cases = [
      caseOf('A', [
        filing('m1', 'motion', 'Motion to Compel Discovery'),
        // Connected by the old any-ref definition, still missing its defining link.
        filing('r1', 'response', 'Response to Motion to Compel Discovery', { refs: { motionRef: 'm1' } }),
      ]),
    ];
    const rows = definingSlotEmptyFilings(buildScopeGraph(cases));
    expect(rows.map((r) => [r.filing.id, r.slot])).toEqual([['r1', 'respondingTo']]);
  });

  it('never lists a motion — it is the root every other kind points at', () => {
    const cases = [caseOf('A', [filing('m1', 'motion', 'Motion for Continuance')])];
    expect(definingSlotEmptyFilings(buildScopeGraph(cases))).toEqual([]);
  });

  it('drops a response once respondingTo is set', () => {
    const cases = [
      caseOf('A', [
        filing('m1', 'motion', 'Motion to Compel Discovery'),
        filing('r1', 'response', 'Response to Motion to Compel Discovery', { refs: { respondingTo: 'm1' } }),
      ]),
    ];
    expect(definingSlotEmptyFilings(buildScopeGraph(cases))).toEqual([]);
  });
});

describe('buildWorklist', () => {
  it('suggests the one legal motion and explains itself', () => {
    const cases = [
      caseOf('A', [
        filing('m1', 'motion', 'Motion to Compel Discovery', { filingDate: '2026-01-01T00:00:00.000Z' }),
        filing('r1', 'response', 'Response to Motion to Compel Discovery', { filingDate: '2026-01-10T00:00:00.000Z' }),
      ]),
    ];
    const { rows, summary } = buildWorklist(cases);
    expect(summary).toMatchObject({ total: 1, suggested: 1, noCandidate: 0, byKind: { response: 1 }, bySlot: { respondingTo: 1 } });
    const row = rows[0];
    expect(row.filingId).toBe('r1');
    expect(row.suggestion?.targetId).toBe('m1');
    expect(row.suggestion?.plan).toMatchObject({ type: 'ref', slot: 'respondingTo', kind: 'response', id: 'r1', targetId: 'm1' });
    expect(row.suggestion?.reasons).toEqual(expect.arrayContaining(['same case']));
  });

  it('says why when two motions tie and the row has no date', () => {
    const cases = [
      caseOf('A', [
        filing('m1', 'motion', 'Motion Alpha'),
        filing('m2', 'motion', 'Motion Beta'),
        filing('r1', 'response', 'Response'),
      ]),
    ];
    const { rows } = buildWorklist(cases);
    expect(rows[0].suggestion).toBeNull();
    expect(rows[0].legalCandidates).toBe(2);
    expect(rows[0].noCandidateReason).toMatch(/none clearly ahead/);
    expect(rows[0].noCandidateReason).toMatch(/no date/);
  });

  it('says so when no legal target exists at all', () => {
    const cases = [caseOf('A', [filing('r1', 'response', 'Response to nothing')])];
    const { rows } = buildWorklist(cases);
    expect(rows[0].noCandidateReason).toMatch(/no filing in this case is a legal target/);
  });

  it('never suggests across cases and filters by caseId', () => {
    const cases = [
      caseOf('A', [filing('m1', 'motion', 'Motion to Compel Discovery')]),
      caseOf('B', [filing('r1', 'response', 'Response to Motion to Compel Discovery')]),
    ];
    const all = buildWorklist(cases);
    expect(all.rows[0].suggestion).toBeNull();
    expect(buildWorklist(cases, { caseId: 'A' }).rows).toEqual([]);
    expect(buildWorklist(cases, { caseId: 'B' }).rows).toHaveLength(1);
  });

  it('reports entityMaterialised=false for a filing with no entity row', () => {
    const cases = [caseOf('A', [filing('r1', 'response', 'Response', { entityKinds: [] })])];
    expect(buildWorklist(cases).rows[0].entityMaterialised).toBe(false);
  });
});

describe('countDefiningSlotEmpty', () => {
  it('counts per case, including zero', () => {
    const cases = [
      caseOf('A', [filing('m1', 'motion', 'Motion'), filing('r1', 'response', 'Response')]),
      caseOf('B', [filing('m2', 'motion', 'Motion')]),
    ];
    const counts = countDefiningSlotEmpty(cases);
    expect(counts.get('A')).toBe(1);
    expect(counts.get('B')).toBe(0);
  });
});
