import { suggestForSlot } from '../suggest-links';
import { buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * The suggester is allowed to be wrong; it is not allowed to be confident
 * without a reason. These tests pin the three properties that make it usable:
 * it never suggests something the rules would refuse, it stays silent when two
 * candidates are equally plausible, and a missing date is no signal rather than
 * a free point.
 */

function filing(
  id: string,
  primaryKind: string,
  label: string,
  filingDate: string | null = null,
  refs: Record<string, string> = {},
): ScopeFiling {
  return {
    id,
    filingType: primaryKind,
    label,
    docCount: 0,
    indexedCount: 0,
    refs,
    documents: [],
    entityKinds: [primaryKind],
    primaryKind,
    filingDate,
  };
}

const iso = (day: string) => `2026-01-${day}T00:00:00.000Z`;

describe('suggestForSlot', () => {
  it('picks the motion that shares distinctive words and came first', () => {
    const graph = buildScopeGraph([
      {
        id: 'c1',
        name: 'case c1',
        unfiledDocCount: 0,
        unfiledIndexedCount: 0,
        filings: [
          filing('m1', 'motion', 'Motion to compel arbitration', iso('01')),
          filing('m2', 'motion', 'Motion for continuance', iso('02')),
          filing('r1', 'response', 'Response to motion to compel arbitration', iso('10')),
        ],
      } as ScopeCase,
    ]);
    const suggestion = suggestForSlot(graph, filingKey('r1'), 'respondingTo');
    expect(suggestion?.targetKey).toBe(filingKey('m1'));
    expect(suggestion?.reasons).toContain('same case');
    expect(suggestion?.reasons.some(r => r.includes('arbitration'))).toBe(true);
  });

  it('says nothing when two candidates are equally plausible', () => {
    const graph = buildScopeGraph([
      {
        id: 'c1',
        name: 'case c1',
        unfiledDocCount: 0,
        unfiledIndexedCount: 0,
        filings: [
          filing('m1', 'motion', 'Motion to compel', iso('01')),
          filing('m2', 'motion', 'Motion to compel', iso('01')),
          filing('r1', 'response', 'Response to motion to compel', iso('05')),
        ],
      } as ScopeCase,
    ]);
    expect(suggestForSlot(graph, filingKey('r1'), 'respondingTo')).toBeNull();
  });

  it('never suggests a candidate the rules would refuse', () => {
    const graph = buildScopeGraph([
      {
        id: 'c1',
        name: 'case c1',
        unfiledDocCount: 0,
        unfiledIndexedCount: 0,
        filings: [
          // An order is not a respondingTo target, however well the words match.
          filing('o1', 'order', 'Order on motion to compel arbitration', iso('02')),
          filing('m1', 'motion', 'Motion to compel arbitration', iso('01')),
          filing('r1', 'response', 'Response re arbitration', iso('09')),
        ],
      } as ScopeCase,
    ]);
    const suggestion = suggestForSlot(graph, filingKey('r1'), 'respondingTo');
    expect(suggestion?.targetKey).toBe(filingKey('m1'));
  });

  it('will not answer a filing with something filed after it', () => {
    const graph = buildScopeGraph([
      {
        id: 'c1',
        name: 'case c1',
        unfiledDocCount: 0,
        unfiledIndexedCount: 0,
        filings: [
          filing('m1', 'motion', 'Motion to compel arbitration', iso('20')),
          filing('r1', 'response', 'Response to motion to compel arbitration', iso('05')),
        ],
      } as ScopeCase,
    ]);
    expect(suggestForSlot(graph, filingKey('r1'), 'respondingTo')).toBeNull();
  });

  it('treats a missing date as no signal, not as a match', () => {
    const graph = buildScopeGraph([
      {
        id: 'c1',
        name: 'case c1',
        unfiledDocCount: 0,
        unfiledIndexedCount: 0,
        filings: [
          filing('m1', 'motion', 'Motion to compel arbitration', null),
          filing('r1', 'response', 'Response to motion to compel arbitration', null),
        ],
      } as ScopeCase,
    ]);
    const suggestion = suggestForSlot(graph, filingKey('r1'), 'respondingTo');
    // Still suggested — the words carry it — but no date claim is made.
    expect(suggestion?.targetKey).toBe(filingKey('m1'));
    expect(suggestion?.reasons.some(r => r.includes('filed'))).toBe(false);
  });

  it('ignores filings in another case entirely', () => {
    const graph = buildScopeGraph([
      {
        id: 'c1',
        name: 'case c1',
        unfiledDocCount: 0,
        unfiledIndexedCount: 0,
        filings: [filing('r1', 'response', 'Response to motion to compel arbitration', iso('09'))],
      } as ScopeCase,
      {
        id: 'c2',
        name: 'case c2',
        unfiledDocCount: 0,
        unfiledIndexedCount: 0,
        filings: [filing('m9', 'motion', 'Motion to compel arbitration', iso('01'))],
      } as ScopeCase,
    ]);
    expect(suggestForSlot(graph, filingKey('r1'), 'respondingTo')).toBeNull();
  });
});
