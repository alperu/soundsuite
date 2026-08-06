/**
 * figure-line-align — position figure OCR text where it sits in the image
 * (task #11 follow-up: superimposed text must ALIGN with the pictured text).
 *
 * PaddleOCR-VL's OCR task returns plain text with no coordinates, so the
 * geometry comes from the image itself: a horizontal ink-density profile of
 * the grayscale crop yields text-line bands (runs of rows containing dark
 * pixels); the OCR text's lines are mapped onto the bands in order. When
 * the counts disagree beyond tolerance the caller falls back to the
 * unaligned text panel — a wrong alignment is worse than none.
 */

import type { DocparseBlockLine } from './docparse-types';
import type { RegionCrop } from './page-region-cropper';

export interface TextBand {
  y0: number; // px, inclusive
  y1: number; // px, exclusive
  x0: number;
  x1: number;
}

/**
 * Detect horizontal text bands in a grayscale raster (1 byte/px).
 * A row is "inky" when enough of its pixels are darker than `inkThreshold`.
 * Adjacent inky rows (with gaps ≤ `gapTolerance`) merge into one band; per
 * band the x-extent is the min/max inky column. Bands shorter than
 * `minBandPx` are noise (rules, speckles) and dropped.
 */
export function detectTextBands(
  gray: Uint8Array,
  width: number,
  height: number,
  opts: { inkThreshold?: number; minInkPx?: number; gapTolerance?: number; minBandPx?: number } = {},
): TextBand[] {
  const inkThreshold = opts.inkThreshold ?? 160;
  const minInkPx = opts.minInkPx ?? 2;
  const gapTolerance = opts.gapTolerance ?? 2;
  const minBandPx = opts.minBandPx ?? 4;

  const rowInk: number[] = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    let n = 0;
    const off = y * width;
    for (let x = 0; x < width; x++) {
      if (gray[off + x] < inkThreshold) n++;
    }
    rowInk[y] = n;
  }

  const bands: TextBand[] = [];
  let start = -1;
  let gap = 0;
  for (let y = 0; y <= height; y++) {
    const inky = y < height && rowInk[y] >= minInkPx;
    if (inky) {
      if (start === -1) start = y;
      gap = 0;
    } else if (start !== -1) {
      gap++;
      if (gap > gapTolerance || y === height) {
        const end = y - gap + 1;
        if (end - start >= minBandPx) {
          let x0 = width, x1 = 0;
          for (let yy = start; yy < end; yy++) {
            const off = yy * width;
            for (let x = 0; x < width; x++) {
              if (gray[off + x] < inkThreshold) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
              }
            }
          }
          bands.push({ y0: start, y1: end, x0, x1: x1 + 1 });
        }
        start = -1;
        gap = 0;
      }
    }
  }
  return bands;
}

/**
 * Map OCR text lines onto detected bands, converting band pixels to
 * page-point bboxes via the crop geometry. Returns [] when the counts
 * disagree by more than 30% — the caller then keeps the unaligned panel.
 */
export function alignOcrLines(
  ocrText: string,
  bands: TextBand[],
  crop: Pick<RegionCrop, 'bboxPt' | 'widthPx' | 'heightPx'>,
): DocparseBlockLine[] {
  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0 || bands.length === 0) return [];
  const n = Math.min(lines.length, bands.length);
  if (Math.abs(lines.length - bands.length) > Math.ceil(0.3 * Math.max(lines.length, bands.length))) {
    return [];
  }
  const [px0, py0, px1, py1] = crop.bboxPt;
  const sx = (px1 - px0) / crop.widthPx;
  const sy = (py1 - py0) / crop.heightPx;
  const out: DocparseBlockLine[] = [];
  for (let i = 0; i < n; i++) {
    const b = bands[i];
    out.push({
      text: lines[i],
      bbox: [
        px0 + b.x0 * sx,
        py0 + b.y0 * sy,
        px0 + b.x1 * sx,
        py0 + b.y1 * sy,
      ],
    });
  }
  return out;
}
