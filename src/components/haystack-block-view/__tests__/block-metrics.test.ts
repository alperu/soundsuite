import {
  BLOCK_FOOTER_H,
  BLOCK_TITLE_H,
  titleHeightFor,
  SLOT_PITCH,
  SOCKET_D,
  anchorRatio,
  filingHeightFor,
} from '../block-metrics';
import { edgeStackFor } from '../link-rules';
import { FILING_H } from '../scope-graph';

/**
 * #65: on every filing the input hub and the first slot resolved to the same
 * pixel, and adjacent slots sat 12.6px apart with 14px circles. These tests pin
 * the invariant that failed — every handle on an edge, hub included, at least
 * one circle-plus-daylight from its neighbour, all of them clear of the title
 * bar and the bottom edge.
 */

/** Ratios are multiplied back out by the renderer, so compare in pixels — and
 *  round, because the round trip through a fraction is not exact. */
function centres(stack: string[], height: number): number[] {
  return stack.map(key => Math.round(anchorRatio(key, stack, height) * height * 100) / 100);
}

describe('edge stack geometry', () => {
  it('never lets the hub share a pixel with the first slot', () => {
    const stack = edgeStackFor({
      edge: 'right',
      slots: ['amends', 'supersedes', 'orderRef'],
      sideOf: () => 'right',
      hubSide: 'right',
    });
    expect(stack).toEqual(['in', 'amends', 'supersedes', 'orderRef']);
    const ys = centres(stack, FILING_H);
    expect(new Set(ys).size).toBe(ys.length);
    expect(ys[1] - ys[0]).toBe(SLOT_PITCH);
  });

  it('keeps every neighbour at least SLOT_PITCH apart, for any stack size', () => {
    for (let n = 1; n <= 6; n += 1) {
      const stack = Array.from({ length: n }, (_, i) => `s${i}`);
      const height = filingHeightFor(n);
      const ys = centres(stack, height);
      for (let i = 1; i < ys.length; i += 1) {
        expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(SLOT_PITCH);
      }
    }
  });

  it('keeps the whole stack inside the body, clear of title and bottom', () => {
    for (let n = 1; n <= 6; n += 1) {
      const stack = Array.from({ length: n }, (_, i) => `s${i}`);
      const height = filingHeightFor(n);
      const ys = centres(stack, height);
      expect(ys[0] - SOCKET_D / 2).toBeGreaterThanOrEqual(BLOCK_TITLE_H);
      expect(ys[ys.length - 1] + SOCKET_D / 2).toBeLessThanOrEqual(height);
    }
  });

  it('splits a stack by edge, and only the hub joins its own side', () => {
    const slots = ['caseRef', 'amends'] as const;
    const sideOf = (slot: string) => (slot === 'caseRef' ? 'left' : 'right') as 'left' | 'right';
    const left = edgeStackFor({ edge: 'left', slots: [...slots], sideOf, hubSide: 'left' });
    const right = edgeStackFor({ edge: 'right', slots: [...slots], sideOf, hubSide: 'left' });
    expect(left).toEqual(['in', 'caseRef']);
    expect(right).toEqual(['amends']);
    // The two left members are a full pitch apart — the left-edge complaint
    // that opened #65.
    const ys = centres(left, FILING_H);
    expect(ys[1] - ys[0]).toBe(SLOT_PITCH);
  });

  it('a socket that is not drawn on this edge answers with the body centre', () => {
    const stack = ['in', 'amends'];
    const centre = anchorRatio('motionRef', stack, FILING_H) * FILING_H;
    // The body is what is left between the title bar and the footer — both
    // bands are excluded, so the centre is not the block's own midpoint.
    expect(centre).toBeCloseTo(
      BLOCK_TITLE_H + (FILING_H - BLOCK_TITLE_H - BLOCK_FOOTER_H) / 2,
      6,
    );
  });

  it('keeps the stack clear of the footer as well as the title', () => {
    for (let n = 1; n <= 6; n += 1) {
      const stack = Array.from({ length: n }, (_, i) => `s${i}`);
      const height = filingHeightFor(n);
      const ys = centres(stack, height);
      expect(ys[ys.length - 1] + SOCKET_D / 2).toBeLessThanOrEqual(height - BLOCK_FOOTER_H + 0.01);
    }
  });
});

/**
 * #99: a filing's name wraps to two or three lines instead of being cut off,
 * which makes the title band per-block. These pin the estimator's shape — its
 * exact character width is a measurement that may be tuned, so nothing here
 * asserts a pixel count that would break when it is.
 */
describe('titleHeightFor', () => {
  const WIDTH = 246; // the block's title column, less padding and the label gutter

  it('gives a short name a single line', () => {
    expect(titleHeightFor('Motion to compel', WIDTH)).toBe(BLOCK_TITLE_H);
  });

  it('grows for a name that cannot fit on one line', () => {
    const long = 'Motion to compel arbitration and to abate all pending discovery deadlines';
    expect(titleHeightFor(long, WIDTH)).toBeGreaterThan(BLOCK_TITLE_H);
  });

  it('stops at three lines however long the name is', () => {
    const three = titleHeightFor('x'.repeat(200), WIDTH);
    const absurd = titleHeightFor('x'.repeat(5000), WIDTH);
    expect(absurd).toBe(three);
  });

  it('never returns less than the one-line bar, even for an empty name', () => {
    expect(titleHeightFor('', WIDTH)).toBe(BLOCK_TITLE_H);
    expect(titleHeightFor('', 0)).toBe(BLOCK_TITLE_H);
  });

  it('keeps the handles clear of a grown title', () => {
    // The band the anchors exclude must be the block's OWN title height, so a
    // three-line title still leaves its stack below the bar (#77's lesson).
    const tall = titleHeightFor('x'.repeat(200), WIDTH);
    const height = filingHeightFor(5, tall);
    const stack = ['in', 'a', 'b', 'c', 'd'];
    const first = anchorRatio(stack[0], stack, height, { titleH: tall }) * height;
    expect(first - SOCKET_D / 2).toBeGreaterThanOrEqual(tall);
  });
});
