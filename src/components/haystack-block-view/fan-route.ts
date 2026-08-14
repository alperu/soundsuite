import { ROW_GAP } from './scope-graph';
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
