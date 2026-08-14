import {
  FILING_H,
  ROW_H,
  buildScopeGraph,
  columnForKind,
  columnX,
  filingKey,
  UNFILED_COLUMN,
} from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * `buildScopeGraph` is the one piece of canvas logic that is pure — same
 * payload in, same coordinates out — so it is the piece worth testing directly
 * rather than through the browser. Fixtures are synthetic throughout.
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
  };
}

function testCase(id: string, filings: ScopeFiling[], unfiled = 0): ScopeCase {
  return {
    id,
    name: `case ${id}`,
    filings,
    unfiledDocCount: unfiled,
    unfiledIndexedCount: 0,
  };
}

describe('buildScopeGraph column layout', () => {
  it('puts each kind in its own column', () => {
    const graph = buildScopeGraph([
      testCase('c1', [
        filing('m1', 'motion'),
        filing('n1', 'notice'),
        filing('r1', 'response'),
        filing('y1', 'reply'),
        filing('o1', 'order'),
        filing('rec1', 'reportersRecord'),
        filing('x1', 'affidavit'),
      ]),
    ]);

    const xOf = (id: string) => graph.filingById.get(id)?.x;
    expect(xOf('m1')).toBe(columnX(0));
    expect(xOf('n1')).toBe(columnX(1));
    expect(xOf('r1')).toBe(columnX(2));
    expect(xOf('y1')).toBe(columnX(3));
    expect(xOf('o1')).toBe(columnX(4));
    expect(xOf('rec1')).toBe(columnX(5));
    expect(xOf('x1')).toBe(columnX(6));
  });

  it('maps order-shaped and record kinds to their shared columns', () => {
    expect(columnForKind('proposedOrder')).toBe(columnForKind('order'));
    expect(columnForKind('judgment')).toBe(columnForKind('decree'));
    expect(columnForKind('clerksRecord')).toBe(columnForKind('reportersRecord'));
    // Anything unrecognised, including an empty kind, belongs in Other.
    expect(columnForKind('somethingNew')).toBe(6);
    expect(columnForKind('')).toBe(6);
  });

  it('lines a family up on one row across columns', () => {
    const graph = buildScopeGraph([
      testCase('c1', [
        filing('m1', 'motion'),
        filing('m2', 'motion'),
        // Answers the SECOND motion, so it should share m2's row, not sit at
        // the top of its own column.
        filing('r1', 'response', { respondingTo: 'm2' }),
        filing('o1', 'order', { resolves: 'm2' }),
      ]),
    ]);

    const y = (id: string) => graph.filingById.get(id)?.y;
    expect(y('m2')).toBe(y('r1'));
    expect(y('m2')).toBe(y('o1'));
    expect(y('m1')).not.toBe(y('m2'));
  });

  it('gives a second filing in one column its own row', () => {
    const graph = buildScopeGraph([
      testCase('c1', [
        filing('m1', 'motion'),
        filing('r1', 'response', { respondingTo: 'm1' }),
        filing('r2', 'response', { respondingTo: 'm1' }),
      ]),
    ]);

    const r1 = graph.filingById.get('r1');
    const r2 = graph.filingById.get('r2');
    expect(r1?.x).toBe(r2?.x);
    expect(r1?.y).not.toBe(r2?.y);
  });

  it('sizes a band by its fullest column, not its filing count', () => {
    // Seven filings, but spread one per column: the band stays one row tall.
    const spread = buildScopeGraph([
      testCase('c1', [
        filing('m1', 'motion'),
        filing('n1', 'notice'),
        filing('r1', 'response'),
        filing('y1', 'reply'),
        filing('o1', 'order'),
        filing('rec1', 'reportersRecord'),
        filing('x1', 'affidavit'),
      ]),
      testCase('c2', [filing('m2', 'motion')]),
    ]);
    // Seven filings, one per column, make a band ONE ROW tall: height follows
    // the fullest COLUMN, never the filing count. Asserted inside this graph
    // rather than against a second one — block height is derived from the
    // handles a kind carries, so two graphs with different kinds in them are
    // legitimately different heights and would compare unequal for a reason
    // that has nothing to do with what this test is about.
    expect(spread.bands[0].height).toBe(Math.max(96, spread.rowH));

    // Three filings stacked in ONE column make a taller band than seven spread.
    const stacked = buildScopeGraph([
      testCase('c1', [
        filing('m1', 'motion'),
        filing('m2', 'motion'),
        filing('m3', 'motion'),
      ]),
      testCase('c2', [filing('m4', 'motion')]),
    ]);
    expect(stacked.caseById.get('c2')?.y).toBeGreaterThan(spread.caseById.get('c2')?.y ?? 0);
  });

  it('parks the unfiled pile past the last kind column', () => {
    const graph = buildScopeGraph([testCase('c1', [filing('m1', 'motion')], 12)], {
      unlinkedLane: true,
    });
    expect(graph.unfiled).toHaveLength(1);
    expect(graph.unfiled[0].x).toBe(columnX(UNFILED_COLUMN));
  });

  it('draws the case edge from the filing, and every block has a box', () => {
    const graph = buildScopeGraph([testCase('c1', [filing('m1', 'motion')])]);
    const edge = graph.edges.find(e => e.kind === 'contains');
    expect(edge?.source).toBe(filingKey('m1'));
    expect(edge?.slot).toBe('caseRef');
    const box = graph.boxes.get(filingKey('m1'));
    // Height comes from the GRAPH, not the module constant: a block is as tall
    // as its own handles and its own title need (#87/#89/#99), and FILING_H is
    // only the one-line floor those derivations start from.
    expect(box).toEqual({
      x: columnX(0),
      y: 0,
      w: 320,
      h: graph.filingById.get('m1')?.height,
    });
    expect(box?.h).toBeGreaterThanOrEqual(FILING_H);
  });

  it('keeps rows a whole ROW_H apart', () => {
    const graph = buildScopeGraph([
      testCase('c1', [filing('m1', 'motion'), filing('m2', 'motion')]),
    ]);
    const gap = (graph.filingById.get('m2')?.y ?? 0) - (graph.filingById.get('m1')?.y ?? 0);
    // One pitch for every row — that is what family alignment across columns
    // rests on — but the pitch itself is derived per graph, so the assertion
    // reads it from there rather than from the baseline constant.
    expect(gap).toBe(graph.rowH);
    expect(graph.rowH).toBeGreaterThanOrEqual(ROW_H);
  });
});
