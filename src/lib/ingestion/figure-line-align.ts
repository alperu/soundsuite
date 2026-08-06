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
  if (lines.length === 0 || bands.length < 2) return [];
  const [px0, py0, px1, py1] = crop.bboxPt;
  const sx = (px1 - px0) / crop.widthPx;
  const sy = (py1 - py0) / crop.heightPx;
  const toBbox = (b: TextBand): [number, number, number, number] => [
    px0 + b.x0 * sx,
    py0 + b.y0 * sy,
    px0 + b.x1 * sx,
    py0 + b.y1 * sy,
  ];

  // Exact mapping when OCR lines ≈ visual bands.
  if (Math.abs(lines.length - bands.length) <= Math.max(1, Math.floor(0.25 * Math.min(lines.length, bands.length)))) {
    const n = Math.min(lines.length, bands.length);
    return bands.slice(0, n).map((b, i) => ({ text: lines[i], bbox: toBbox(b) }));
  }

  // Reflow fallback (measured: PaddleOCR emits LOGICAL lines — wrapped text
  // merged — so exact counts disagree on exactly the document-screenshot
  // figures that matter). Flow the text word-by-word into the bands, each
  // taking roughly what fits its pixel width; alignment is approximate but
  // the text lands where text is, which beats a corner panel.
  const words = lines.join(' ').split(/\s+/).filter(w => w.length > 0);
  const out: DocparseBlockLine[] = [];
  let wi = 0;
  for (let i = 0; i < bands.length && wi < words.length; i++) {
    const b = bands[i];
    const charW = Math.max(3, (b.y1 - b.y0) * 0.5); // ≈ glyph advance from band height
    const capacity = Math.max(4, Math.round((b.x1 - b.x0) / charW));
    let text = '';
    while (wi < words.length) {
      const cand = text.length === 0 ? words[wi] : `${text} ${words[wi]}`;
      if (cand.length > capacity && text.length > 0) break;
      text = cand;
      wi++;
    }
    // Last band absorbs any remainder so no text is lost.
    if (i === bands.length - 1 && wi < words.length) {
      text = `${text} ${words.slice(wi).join(' ')}`;
      wi = words.length;
    }
    out.push({ text, bbox: toBbox(b) });
  }
  return out;
}
