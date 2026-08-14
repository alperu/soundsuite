import { fanPath, refPath } from '../fan-route';
import { buildScopeGraph, caseKey, filingKey, ROW_GAP } from '../scope-graph';
import type { ScopeCase, ScopeFiling } from '../types';

/**
 * The fan router's contract, in the two places it can silently fail: putting a
 * segment where a block is, and mixing up which end is the case (which sent
 * every unfiled-pile edge down the straight-line fallback until it was
 * measured).
 */

function filing(id: string, primaryKind: string): ScopeFiling {
  return {
    id,
    filingType: primaryKind,
    label: `filing ${id}`,
    docCount: 0,
    indexedCount: 0,
    refs: {},
    documents: [],
    entityKinds: [primaryKind],
    primaryKind,
    filingDate: null,
  };
}

const graph = buildScopeGraph(
  [
    {
      id: 'c1',
      name: 'case one',
      unfiledDocCount: 4,
      unfiledIndexedCount: 0,
      filings: [filing('m1', 'motion'), filing('n1', 'notice'), filing('r1', 'response')],
    } as ScopeCase,
  ],
  { unlinkedLane: true },
);

const box = (key: string) => graph.boxes.get(key)!;

/** Every vertex in a `d` string, as numbers. */
function vertices(d: string): Array<{ x: number; y: number }> {
  return [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(m => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

describe('fanPath', () => {
  const filingBox = box(filingKey('r1'));
  const caseBox = box(caseKey('c1'));
  const start = { x: filingBox.x, y: filingBox.y + filingBox.h / 2 };
  const end = { x: caseBox.x + caseBox.w, y: caseBox.y + caseBox.h / 2 };

  it('keeps the endpoints exactly where the sockets are', () => {
    const points = vertices(fanPath(graph, filingKey('r1'), caseKey('c1'), start, end)!);
    expect(points[0]).toEqual(start);
    expect(points[points.length - 1]).toEqual(end);
  });

  it('runs its horizontal leg in the row gap, where no block can be', () => {
    const points = vertices(fanPath(graph, filingKey('r1'), caseKey('c1'), start, end)!);
    const gapY = filingBox.y + filingBox.h + ROW_GAP / 2;
    // The long leftward run happens at the gap, not at the block's own centre.
    expect(points.some(p => p.y === gapY)).toBe(true);
    // And it is genuinely between rows: below this block, above the next.
    expect(gapY).toBeGreaterThan(filingBox.y + filingBox.h);
    expect(gapY).toBeLessThan(filingBox.y + graph.rowH);
  });

  it('is orthogonal — every segment is horizontal or vertical', () => {
    const points = vertices(fanPath(graph, filingKey('r1'), caseKey('c1'), start, end)!);
    for (let i = 1; i < points.length; i++) {
      const dx = Math.abs(points[i].x - points[i - 1].x);
      const dy = Math.abs(points[i].y - points[i - 1].y);
      expect(dx === 0 || dy === 0).toBe(true);
    }
  });

  it('routes the same whichever end the edge claims as its source', () => {
    // The unfiled pile's containment edge is sourced case-first; it must not
    // fall back to a straight line because of that.
    const forwards = fanPath(graph, filingKey('r1'), caseKey('c1'), start, end)!;
    const backwards = fanPath(graph, caseKey('c1'), filingKey('r1'), start, end)!;
    expect(vertices(backwards)).toHaveLength(vertices(forwards).length);
    expect(vertices(backwards).length).toBeGreaterThan(2);
  });

  it('answers null when a block is not in the graph', () => {
    expect(fanPath(graph, filingKey('ghost'), caseKey('c1'), start, end)).toBeNull();
  });
});

describe('refPath', () => {
  const from = box(filingKey('r1'));
  const to = box(filingKey('m1'));
  const start = { x: from.x, y: from.y + from.h / 2 };
  const end = { x: to.x + to.w, y: to.y + to.h / 2 };

  it('shares the fan language: orthogonal, endpoints untouched', () => {
    const points = vertices(refPath(graph, filingKey('r1'), filingKey('m1'), start, end)!);
    expect(points[0]).toEqual(start);
    expect(points[points.length - 1]).toEqual(end);
    for (let i = 1; i < points.length; i++) {
      const dx = Math.abs(points[i].x - points[i - 1].x);
      const dy = Math.abs(points[i].y - points[i - 1].y);
      expect(dx === 0 || dy === 0).toBe(true);
    }
  });

  it('crosses in the row gap, not through the blocks', () => {
    const points = vertices(refPath(graph, filingKey('r1'), filingKey('m1'), start, end)!);
    const gapY = from.y + from.h + ROW_GAP / 2;
    expect(points.some(p => p.y === gapY)).toBe(true);
  });

  it('leaves a straight line straight when the pair is already adjacent', () => {
    // Same row, ONE column apart: bending that through a gutter is theatre.
    const near = box(filingKey('n1'));
    const nearStart = { x: near.x, y: near.y + near.h / 2 };
    const nearEnd = { x: to.x + to.w, y: to.y + to.h / 2 };
    const d = refPath(graph, filingKey('n1'), filingKey('m1'), nearStart, nearEnd)!;
    expect(vertices(d)).toHaveLength(2);
  });

  it('answers null for a block the graph does not have', () => {
    expect(refPath(graph, filingKey('ghost'), filingKey('m1'), start, end)).toBeNull();
  });
});
