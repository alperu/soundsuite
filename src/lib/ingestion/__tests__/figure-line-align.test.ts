import { detectTextBands, alignOcrLines } from '../figure-line-align';

/** Build a synthetic grayscale raster (255 = white) with dark bands. */
function raster(width: number, height: number, bands: Array<{ y0: number; y1: number; x0: number; x1: number }>): Uint8Array {
  const g = new Uint8Array(width * height).fill(255);
  for (const b of bands) {
    for (let y = b.y0; y < b.y1; y++) {
      for (let x = b.x0; x < b.x1; x++) g[y * width + x] = 20;
    }
  }
  return g;
}

describe('detectTextBands', () => {
  it('finds separated text bands with their x extents', () => {
    const g = raster(100, 60, [
      { y0: 5, y1: 12, x0: 10, x1: 80 },
      { y0: 25, y1: 33, x0: 20, x1: 90 },
    ]);
    const bands = detectTextBands(g, 100, 60);
    expect(bands).toHaveLength(2);
    expect(bands[0].y0).toBe(5);
    expect(bands[0].x0).toBe(10);
    expect(bands[1].x1).toBe(90);
  });

  it('bridges small gaps within a line and drops speckle bands', () => {
    const g = raster(100, 40, [
      { y0: 5, y1: 9, x0: 10, x1: 50 },
      { y0: 10, y1: 14, x0: 10, x1: 50 }, // 1px gap → same band
      { y0: 30, y1: 32, x0: 40, x1: 45 }, // 2px tall → speckle, dropped
    ]);
    const bands = detectTextBands(g, 100, 40);
    expect(bands).toHaveLength(1);
    expect(bands[0].y1).toBe(14);
  });
});

describe('alignOcrLines', () => {
  const crop = { bboxPt: [100, 200, 300, 300] as [number, number, number, number], widthPx: 400, heightPx: 200 };

  it('maps OCR lines to bands and converts px to page points', () => {
    const bands = [
      { y0: 20, y1: 40, x0: 40, x1: 360 },
      { y0: 80, y1: 100, x0: 40, x1: 200 },
    ];
    const lines = alignOcrLines('First line of text\nSecond line', bands, crop);
    expect(lines).toHaveLength(2);
    // x: 100 + 40*(200/400) = 120; y: 200 + 20*(100/200) = 210
    expect(lines[0].bbox).toEqual([120, 210, 280, 220]);
    expect(lines[0].text).toBe('First line of text');
    expect(lines[1].bbox![2]).toBe(200);
  });

  it('returns [] when fewer than two bands exist (alignment pointless)', () => {
    const bands = [{ y0: 0, y1: 10, x0: 0, x1: 100 }];
    expect(alignOcrLines('a\nb\nc\nd\ne', bands, crop)).toEqual([]);
  });

  it('reflows words into bands when counts disagree (logical vs visual lines)', () => {
    // 2 logical OCR lines, 4 visual bands → reflow, not reject
    const bands = [
      { y0: 0, y1: 20, x0: 0, x1: 200 },
      { y0: 30, y1: 50, x0: 0, x1: 200 },
      { y0: 60, y1: 80, x0: 0, x1: 200 },
      { y0: 90, y1: 110, x0: 0, x1: 200 },
    ];
    const text = 'alpha beta gamma delta epsilon zeta\neta theta iota kappa lambda mu';
    const lines = alignOcrLines(text, bands, crop);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    // no text lost: all words present across bands in order
    expect(lines.map(l => l.text).join(' ').split(/\s+/)).toEqual(text.split(/[\s\n]+/));
    // each band has a bbox from its own geometry
    expect(lines[0].bbox![1]).toBeLessThan(lines[1].bbox![1]);
  });

  it('tolerates small count mismatches by truncating to the shorter list', () => {
    const bands = [
      { y0: 0, y1: 10, x0: 0, x1: 100 },
      { y0: 20, y1: 30, x0: 0, x1: 100 },
      { y0: 40, y1: 50, x0: 0, x1: 100 },
      { y0: 60, y1: 70, x0: 0, x1: 100 },
    ];
    const lines = alignOcrLines('one\ntwo\nthree', bands, crop);
    expect(lines).toHaveLength(3);
  });
});
