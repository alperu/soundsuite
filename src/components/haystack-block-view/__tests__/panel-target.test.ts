import { panelTargetFor } from '../panel-target';
import { buildScopeGraph, caseKey, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * The chain behind "I clicked a block and the tag panel didn't open". Every
 * branch that can end without a panel is pinned here, because the ones that
 * SHOULD end without one (a document, an unfiled pile) look identical to a
 * bug from the outside — the difference is whether the user was told why.
 */

function filing(id: string, primaryKind: string, entityKinds: string[] = [primaryKind]): ScopeFiling {
  return {
    id,
    filingType: primaryKind,
    label: `filing ${id}`,
    docCount: 0,
    indexedCount: 0,
    refs: {},
    documents: [],
    entityKinds,
    primaryKind,
    filingDate: null,
  };
}

const graph = buildScopeGraph(
  [
    {
      id: 'c1',
      name: 'case one',
      unfiledDocCount: 3,
      unfiledIndexedCount: 1,
      filings: [filing('m1', 'motion'), filing('rec1', 'reportersRecord', [])],
    } as ScopeCase,
  ],
  { unlinkedLane: true },
);

const context = {
  graph,
  entryKeys: new Set(['m1']),
  caseNameById: new Map([['c1', 'case one']]),
};

describe('panelTargetFor', () => {
  it('hands a worklist-listed filing to the list, which knows its entity table', () => {
    expect(panelTargetFor(filingKey('m1'), context)).toEqual({ kind: 'entry', entryKey: 'm1' });
  });

  it('opens a canvas-only filing from the graph', () => {
    expect(panelTargetFor(filingKey('rec1'), context)).toEqual({
      kind: 'graph',
      entityKind: 'reportersRecord',
      id: 'rec1',
      label: 'filing rec1',
    });
  });

  it('opens a filing that has no entity row yet — an unmapped block is editable', () => {
    // rec1 carries no entityKinds; the panel still has a kind to edit against.
    const target = panelTargetFor(filingKey('rec1'), context);
    expect(target.kind).toBe('graph');
    if (target.kind === 'graph') expect(target.entityKind).toBe('reportersRecord');
  });

  it('opens a case block on its own name', () => {
    expect(panelTargetFor(caseKey('c1'), context)).toEqual({
      kind: 'graph',
      entityKind: 'case',
      id: 'c1',
      label: 'case one',
    });
  });

  it('refuses documents and unfiled piles WITH a reason, never silently', () => {
    const doc = panelTargetFor('document:abc', context);
    const pile = panelTargetFor('unfiled:c1', context);
    expect(doc.kind).toBe('refuse');
    expect(pile.kind).toBe('refuse');
    if (doc.kind === 'refuse') expect(doc.reason).toMatch(/drag it onto a filing/);
    if (pile.kind === 'refuse') expect(pile.reason).toMatch(/file them onto a filing/);
  });

  it('says nothing for a key this graph does not know', () => {
    expect(panelTargetFor(filingKey('ghost'), context)).toEqual({ kind: 'none' });
  });
});
