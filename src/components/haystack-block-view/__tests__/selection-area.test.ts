import { blocksInMarquee } from '../use-selection-area';

/**
 * The marquee's whole semantic is this function: which blocks a box in editor
 * coordinates catches, under the CAD direction convention. It is pure
 * arithmetic on the layout, so it can be checked without a DOM or a canvas.
 */

const boxes = new Map([
  // fully inside the test box
  ['filing:inside', { x: 100, y: 100, w: 50, h: 40 }],
  // overlaps the left border only
  ['filing:straddling', { x: 180, y: 100, w: 50, h: 40 }],
  // nowhere near
  ['filing:outside', { x: 500, y: 500, w: 50, h: 40 }],
  ['case:band', { x: 0, y: 100, w: 60, h: 40 }],
]);

describe('blocksInMarquee', () => {
  const a = { x: 50, y: 50 };
  const b = { x: 200, y: 200 };

  it('containment takes only blocks fully enclosed', () => {
    expect(blocksInMarquee(boxes, a, b, true)).toEqual(['filing:inside']);
  });

  it('intersection also takes blocks the box merely touches', () => {
    expect(blocksInMarquee(boxes, a, b, false).sort()).toEqual([
      // The case band overlaps this box too — geometry makes no exception for
      // case blocks; the store is what drops them.
      'case:band',
      'filing:inside',
      'filing:straddling',
    ]);
  });

  it('reads the same box however it was dragged', () => {
    // A right-to-left drag hands the corners over in the other order; the hit
    // test must normalise rather than come back empty.
    expect(blocksInMarquee(boxes, b, a, true)).toEqual(['filing:inside']);
  });

  it('takes nothing when the box catches nothing', () => {
    expect(blocksInMarquee(boxes, { x: 300, y: 0 }, { x: 400, y: 50 }, false)).toEqual([]);
  });

  it('catches a case block like any other box', () => {
    // Whether a case key is HONOURED is the store's call (it drops them), but
    // the geometry itself makes no exception.
    expect(blocksInMarquee(boxes, { x: 0, y: 90 }, { x: 70, y: 150 }, true)).toEqual(['case:band']);
  });

  it('a zero-area box encloses nothing, but still touches what it lands on', () => {
    // Which is exactly why `setupMarquee` refuses to act on a drag shorter than
    // MIN_DRAG_PX: geometrically a click IS an intersection with whatever is
    // under it, and a stray click would otherwise select that block.
    const point = { x: 120, y: 120 };
    expect(blocksInMarquee(boxes, point, point, true)).toEqual([]);
    expect(blocksInMarquee(boxes, point, point, false)).toEqual(['filing:inside']);
  });
});
