import { computeCropRect } from '../page-region-cropper';

const PAGE = { width: 612, height: 792 };
const RASTER = { width: 1224, height: 1584 }; // scale 2

describe('computeCropRect', () => {
  it('maps points to pixels with padding', () => {
    const rect = computeCropRect([100, 200, 400, 500], PAGE, RASTER, { padPct: 0.02, minPx: 200 })!;
    const padPt = 792 * 0.02; // 15.84pt → ~31.7px
    expect(rect.left).toBe(Math.floor((100 - padPt) * 2));
    expect(rect.top).toBe(Math.floor((200 - padPt) * 2));
    expect(rect.width).toBeGreaterThan((400 - 100) * 2); // padded both sides
  });

  it('clamps to raster bounds', () => {
    const rect = computeCropRect([0, 0, 612, 792], PAGE, RASTER, { padPct: 0.02, minPx: 200 })!;
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(RASTER.width);
    expect(rect.top + rect.height).toBeLessThanOrEqual(RASTER.height);
  });

  it('rejects sub-minimum regions', () => {
    expect(computeCropRect([100, 100, 140, 130], PAGE, RASTER, { padPct: 0, minPx: 200 })).toBeNull();
  });

  it('rejects fully out-of-bounds regions', () => {
    expect(computeCropRect([700, 900, 800, 1000], PAGE, RASTER, { padPct: 0.02, minPx: 200 })).toBeNull();
  });
});
