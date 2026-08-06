/**
 * page-region-cropper — crop a bbox region from a rendered PDF page.
 * PLAN-ss-docparse §0.1 step 2b.
 *
 * Single source of page pixels is renderPage() (pdftoppm-first, LRU-cached:
 * N crops on one page cost ONE render). Region crops feed ss-ocr's
 * `Table Recognition:` task. Design rules baked in:
 *  - bbox is PDF points, TOP-left origin (DocparseBlock convention)
 *  - pad ~2% of page height on all sides — heuristic table bboxes clip
 *    header rows, and a clipped header is the largest structure loss
 *  - reject sub-minPx crops (hallucination bait, not content)
 *  - clamp to raster bounds — sharp.extract throws out-of-bounds, and a
 *    throw here must never fail a page
 *  - renders go through withSemaphore() so ingestion cannot starve the
 *    page-image viewer
 *  - NO preprocessImage(): CLAHE/sharpen erase the hairline rules the
 *    table recognizer uses on clean vector renders; grayscale PNG only
 */

import { renderPage, getPageDimensions } from '../pdf-page-renderer';
import { withSemaphore } from '../render-semaphore';
import { createLogger } from '../logger';

const logger = createLogger('PageRegionCropper');

export interface RegionCrop {
  buffer: Buffer;
  /** The padded, clamped bbox actually cropped (PDF points, top-left origin). */
  bboxPt: [number, number, number, number];
  widthPx: number;
  heightPx: number;
}

export interface CropOptions {
  scale?: number;   // default 2.0 → 144 dpi
  padPct?: number;  // default 0.02 of page height, all sides
  minPx?: number;   // default 200 px in BOTH dimensions after clamping
}

/** Pure rect math — exported for tests. Returns null when the region is
 * too small to OCR meaningfully. All units px in the rendered raster. */
export function computeCropRect(
  bboxPt: [number, number, number, number],
  pagePt: { width: number; height: number },
  rasterPx: { width: number; height: number },
  opts: Required<Pick<CropOptions, 'padPct' | 'minPx'>>,
): { left: number; top: number; width: number; height: number } | null {
  const sx = rasterPx.width / pagePt.width;
  const sy = rasterPx.height / pagePt.height;
  const padPt = pagePt.height * opts.padPct;

  const x0 = (bboxPt[0] - padPt) * sx;
  const y0 = (bboxPt[1] - padPt) * sy;
  const x1 = (bboxPt[2] + padPt) * sx;
  const y1 = (bboxPt[3] + padPt) * sy;

  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(rasterPx.width, Math.ceil(x1));
  const bottom = Math.min(rasterPx.height, Math.ceil(y1));

  const width = right - left;
  const height = bottom - top;
  if (width < opts.minPx || height < opts.minPx) return null;
  return { left, top, width, height };
}

/**
 * Crop a region from a page. Returns null (never throws) when the region is
 * too small, out of bounds, or rendering fails — callers keep the block's
 * plain text and move on.
 */
export async function cropRegion(
  filePath: string,
  pageNum: number,
  bboxPt: [number, number, number, number],
  opts: CropOptions = {},
): Promise<RegionCrop | null> {
  const scale = opts.scale ?? 2.0;
  const padPct = opts.padPct ?? 0.02;
  const minPx = opts.minPx ?? 200;
  try {
    const pagePt = await getPageDimensions(filePath, pageNum);
    const rendered = await withSemaphore(() => renderPage(filePath, pageNum, scale));
    const rect = computeCropRect(bboxPt, pagePt, { width: rendered.width, height: rendered.height }, { padPct, minPx });
    if (!rect) {
      logger.info('Region below minimum crop size — skipping', { pageNum, bboxPt, minPx });
      return null;
    }
    const sharp = (await import('sharp')).default;
    const buffer = await sharp(rendered.buffer)
      .extract(rect)
      .grayscale()
      .png()
      .toBuffer();
    return {
      buffer,
      bboxPt: [
        Math.max(0, bboxPt[0] - pagePt.height * padPct),
        Math.max(0, bboxPt[1] - pagePt.height * padPct),
        Math.min(pagePt.width, bboxPt[2] + pagePt.height * padPct),
        Math.min(pagePt.height, bboxPt[3] + pagePt.height * padPct),
      ],
      widthPx: rect.width,
      heightPx: rect.height,
    };
  } catch (err) {
    logger.warn('Region crop failed — block keeps plain text', {
      pageNum,
      bboxPt,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
