/**
 * Blank-page classification — distinguishes "blank by design" (separator /
 * back pages, common in clerk's records) from "extraction failed".
 *
 * A page may be classified blank ONLY when all evidence agrees:
 *   1. no embedded text layer,
 *   2. the full-page render succeeded and is not a placeholder,
 *   3. OCR of the render returned empty,
 *   4. ink coverage on the render is below INK_RATIO_BLANK.
 *
 * When signals conflict, classify as missing — a false "missing" costs a
 * few points and is reviewable; a false "blank" silently deletes a real gap
 * from the report and nobody ever learns about it.
 */

import { createLogger } from '../../logger';

const logger = createLogger('BlankPage');

/** Below this fraction of dark pixels the page image is considered blank.
 * Empty pages with scanner speckle measure ~0.0001–0.0005; a single line of
 * text measures ~0.003–0.01. */
export const INK_RATIO_BLANK = 0.002;

/** Pixels darker than this (0-255 greyscale) count as ink. */
const INK_LUMA_THRESHOLD = 200;

/** Fraction of each edge cropped before counting — scanner edge bands,
 * punch holes, and skew borders are the dominant false-positive source. */
const MARGIN_CROP = 0.05;

export interface InkCheckResult {
  blank: boolean;
  inkRatio: number;
}

/**
 * Measure ink coverage on a rendered page image. Returns blank=false on any
 * processing error (safety default: conflict → not blank).
 */
export async function checkInkCoverage(renderBuffer: Buffer): Promise<InkCheckResult> {
  try {
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(renderBuffer)
      .greyscale()
      .resize(1000, null, { fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    if (!width || !height || width < 20 || height < 20) {
      // Tiny image (e.g. a 1x1 placeholder that slipped through) — no evidence.
      return { blank: false, inkRatio: 1 };
    }

    const x0 = Math.floor(width * MARGIN_CROP);
    const x1 = Math.ceil(width * (1 - MARGIN_CROP));
    const y0 = Math.floor(height * MARGIN_CROP);
    const y1 = Math.ceil(height * (1 - MARGIN_CROP));

    let dark = 0;
    let total = 0;
    for (let y = y0; y < y1; y++) {
      const rowBase = y * width;
      for (let x = x0; x < x1; x++) {
        total++;
        if (data[rowBase + x] < INK_LUMA_THRESHOLD) dark++;
      }
    }
    const inkRatio = total > 0 ? dark / total : 1;
    return { blank: inkRatio < INK_RATIO_BLANK, inkRatio };
  } catch (err) {
    logger.warn('Ink-coverage check failed — treating page as not blank', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { blank: false, inkRatio: 1 };
  }
}
