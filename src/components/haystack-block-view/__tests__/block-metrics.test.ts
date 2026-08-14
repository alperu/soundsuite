import {
  BLOCK_TITLE_H,
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
    expect(centre).toBe(BLOCK_TITLE_H + (FILING_H - BLOCK_TITLE_H) / 2);
  });
});
