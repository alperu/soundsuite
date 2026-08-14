import { KIND_COL_GAP, ROW_GAP } from './scope-graph';
import type { ScopeGraph } from './scope-graph';

/**
 * Orthogonal routing for the case fan.
 *
 * #60 dropped the router because two visible edges had nothing to route
 * around. "Show all links" (#74) changed the premise: measured with the fan
 * drawn, ALL 88 containment edges cross at least one block, 184 crossings in
 * total, one edge crossing six. Neither of the cheap alternatives touches that
 * number — spreading the convergence point and dimming the fan make the same
 * crossings prettier and quieter, not fewer.
 *
 * The layout makes the honest fix cheap. Blocks sit on a fixed pitch, so the
 * ROW GAP between two rows is guaranteed empty across every column, and the
 * space between the case column and the first kind column is guaranteed empty
 * top to bottom. That is a bus: drop into your own row's gap, run left along
 * it, join the trunk, ride up to the case. No occupancy sweep, no search — the
 * geometry is known before anything is drawn, which is what made a general
 * router unattractive and makes this one three lines of arithmetic.
 *
 * Shared segments overlap exactly rather than nearly, so the fan reads as one
 * trunk with branches instead of 28 diagonals converging on a point.
 */

/** How far the line leaves the socket before it turns — enough to read as a stub. */
const STUB = 12;

/** Where the vertical trunk sits: just right of the case block's id tag. */
const TRUNK_OFFSET = 28;

export interface Point {
  x: number;
  y: number;
}

/**
 * The `d` string for one containment edge, or null when the geometry isn't
 * known (the caller then keeps rete's default curve).
 *
 * `sourceKey` is the FILING and `targetKey` the case: the edge was re-sourced
 * that way in #44, and the fan hangs off the filing's caseRef socket.
 */
export function fanPath(
  graph: ScopeGraph,
  sourceKey: string,
  targetKey: string,
  start: Point,
  end: Point,
): string | null {
  // Which end is the CASE is asked of the graph, not assumed from the edge's
  // direction: the unfiled pile's containment edge is sourced the other way
  // round, and assuming source-is-filing sent exactly those five edges down the
  // straight-line fallback.
  const caseKey = graph.caseById.has(sourceKey.replace(/^case:/, '')) ? sourceKey : targetKey;
  const blockKey = caseKey === sourceKey ? targetKey : sourceKey;
  const filing = graph.boxes.get(blockKey);
  const kase = graph.boxes.get(caseKey);
  if (!filing || !kase) return null;

  // Which supplied point is which end is NOT assumed: the watcher hands over
  // `[start, end]` in its own order, and reading them the wrong way round
  // silently produced a straight line (the router's own fallback) for every
  // edge. Match them to the boxes instead.
  const filingEnd = nearer(start, end, filing.x);
  const caseEnd = filingEnd === start ? end : start;

  // The gap BELOW the filing's row — empty by construction, because rows sit a
  // whole `rowH` apart and a block is `rowH - ROW_GAP` tall.
  const gapY = filing.y + filing.h + ROW_GAP / 2;
  const trunkX = kase.x + kase.w + TRUNK_OFFSET;
  // A filing left of the trunk (none today, but a future column could) would
  // double back on itself; going straight is honest there.
  if (filingEnd.x <= trunkX) return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;

  const stubX = filingEnd.x - STUB;
  const route: Point[] = [
    filingEnd,
    { x: stubX, y: filingEnd.y },
    { x: stubX, y: gapY },
    { x: trunkX, y: gapY },
    { x: trunkX, y: caseEnd.y },
    caseEnd,
  ];
  // Drawn in the order the plugin asked for, so the line still starts where it
  // said it starts.
  const ordered = filingEnd === start ? route : [...route].reverse();
  return ordered
    .map((p, index) => `${index === 0 ? 'M' : 'L'} ${p.x} ${p.y}`)
    .join(' ');
}

/** Whichever point sits closer to the filing's own left edge. */
function nearer(a: Point, b: Point, x: number): Point {
  return Math.abs(a.x - x) <= Math.abs(b.x - x) ? a : b;
}

/**
 * The same channels, for a ref.
 *
 * Refs are a different geometry from the fan — arbitrary pairs of filings
 * rather than everything-to-one-case — so this is not the trunk reused. What
 * carries over is the pair of guaranteed-empty channels the layout provides:
 * the gap between rows, and the 64px gutter between two kind columns. A ref
 * drops into its own row's gap, crosses to the gutter beside its target's
 * column, rides it to the target's row, and comes in level.
 *
 * Measured before designing, as the fan was: both ref edges in the corpus cross
 * blocks (6 crossings, one edge through 4), so "there is nothing to route
 * around" is no longer true for refs either — and the user asked for one visual
 * language besides.
 *
 * LANES: several refs can want the same gutter. The lane is derived from the
 * source's ROW rather than allocated from shared mutable state — two edges in
 * one gutter are almost always on different rows, and a derived lane keeps the
 * router a pure function of the layout, which is what makes both routers
 * reproducible and testable.
 */

/** How far apart parallel lines sit inside one gutter. */
const LANE_PITCH = 12;

/** Lanes that fit in a column gutter without touching either column. */
/** Keep a lane's width clear of both columns; 16 is that margin, not a pitch. */
const GUTTER_MARGIN = 16;
const LANES = Math.max(1, Math.floor((KIND_COL_GAP - GUTTER_MARGIN) / LANE_PITCH));

export function refPath(
  graph: ScopeGraph,
  sourceKey: string,
  targetKey: string,
  start: Point,
  end: Point,
): string | null {
  const source = graph.boxes.get(sourceKey);
  const target = graph.boxes.get(targetKey);
  if (!source || !target) return null;

  // Same row and adjacent: the straight line IS the clear route, and bending it
  // through a gutter would be theatre.
  if (Math.abs(source.y - target.y) < 1 && Math.abs(source.x - target.x) <= COLUMN_STEP) {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }

  const gapY = source.y + source.h + ROW_GAP / 2;
  // The gutter beside the target, on the side the edge arrives from.
  const gutterCentre =
    target.x > source.x
      ? target.x - KIND_COL_GAP / 2
      : target.x + target.w + KIND_COL_GAP / 2;
  const lane = laneOffset(graph, source.y);
  const gutterX = gutterCentre + lane;
  const stubX = start.x + (start.x < source.x + source.w / 2 ? -STUB : STUB);

  return [
    `M ${start.x} ${start.y}`,
    `L ${stubX} ${start.y}`,
    `L ${stubX} ${gapY}`,
    `L ${gutterX} ${gapY}`,
    `L ${gutterX} ${end.y}`,
    `L ${end.x} ${end.y}`,
  ].join(' ');
}

/** One column step, for the "already adjacent" test. */
const COLUMN_STEP = 320 + KIND_COL_GAP;

/**
 * Which lane inside a gutter this edge takes, spread around its centre.
 * Derived from the row so it is stable across rebuilds and needs no allocator.
 */
function laneOffset(graph: ScopeGraph, y: number): number {
  const row = Math.round(y / Math.max(graph.rowH, 1));
  return ((row % LANES) - (LANES - 1) / 2) * LANE_PITCH;
}
