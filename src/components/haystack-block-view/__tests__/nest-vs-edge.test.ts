import { EDGE_SLOTS, NEST_SLOTS, buildScopeGraph, filingKey } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * #103: one list was answering two questions — what a filing NESTS under, and
 * what draws a line. `orderRef` needs the second without the first: a notice
 * about an order still belongs to its motion and its case band (#89's "a
 * reference, NOT a move"), but it must still draw an edge, because an edge is
 * the only thing the canvas can unlink (#102).
 *
 * No live filing holds `orderRef` today, so the proof is synthetic throughout.
 */

function filing(id: string, primaryKind: string, refs: Record<string, string> = {}): ScopeFiling {
  return {
    id,
    filingType: primaryKind,
    label: `filing ${id}`,
    docCount: 0,
    indexedCount: 0,
    refs,
    documents: [],
    entityKinds: [primaryKind],
    primaryKind,
    filingDate: null,
  };
}

/** A notice filed under a motion, that also concerns an order. */
const graph = buildScopeGraph([
  {
    id: 'c1',
    name: 'case one',
    unfiledDocCount: 0,
    unfiledIndexedCount: 0,
    filings: [
      filing('m1', 'motion'),
      filing('m2', 'motion'),
      // The order belongs to a DIFFERENT motion's family, so it sits on another
      // row. That separation is what makes the re-parenting test decisive: if
      // `orderRef` nested, the notice would move to this row.
      filing('o1', 'order', { resolves: 'm2' }),
      filing('n1', 'notice', { motionRef: 'm1', orderRef: 'o1' }),
    ],
  } as ScopeCase,
]);

const edgesFrom = (id: string) =>
  graph.edges.filter(e => e.kind === 'ref' && e.source === filingKey(id));

describe('the two lists say different things', () => {
  it('every nesting slot also draws an edge', () => {
    for (const slot of NEST_SLOTS) expect(EDGE_SLOTS).toContain(slot);
  });

  it('orderRef draws an edge WITHOUT joining the nesting list', () => {
    expect(EDGE_SLOTS).toContain('orderRef');
    expect(NEST_SLOTS).not.toContain('orderRef');
  });
});

describe('an order-shaped ref on a notice', () => {
  it('renders an edge — which is what makes it unlinkable at all', () => {
    const edge = edgesFrom('n1').find(e => e.slot === 'orderRef');
    expect(edge).toBeDefined();
    expect(edge?.target).toBe(filingKey('o1'));
    // handleUnlink resolves edge ids out of graph.edges, so the id has to be
    // there for the canvas right-click delete to find anything.
    expect(edge?.id).toBe('orderRef:n1:o1');
  });

  it('still draws its motionRef edge as well — both, not either', () => {
    expect(edgesFrom('n1').map(e => e.slot).sort()).toEqual(['motionRef', 'orderRef']);
  });

  it('does NOT re-parent the notice onto the order', () => {
    const notice = graph.filingById.get('n1');
    const motion = graph.filingById.get('m1');
    const order = graph.filingById.get('o1');
    // The order is on its own row, so these two cannot both be true by
    // accident: the notice keeps its MOTION's row and is not pulled to the
    // order's. #89's "a reference, not a move", asserted rather than asserted-ish.
    expect(order?.y).not.toBe(motion?.y);
    expect(notice?.y).toBe(motion?.y);
    expect(notice?.y).not.toBe(order?.y);
  });

  it('leaves the notice in its own case band, under its own case', () => {
    expect(graph.caseOfFiling.get(filingKey('n1'))).toBe(graph.caseOfFiling.get(filingKey('m1')));
  });

  it('makes the order a neighbour for hover and selection reveal', () => {
    expect(graph.refNeighbors.get(filingKey('n1'))).toContain(filingKey('o1'));
    expect(graph.refNeighbors.get(filingKey('o1'))).toContain(filingKey('n1'));
  });
});
