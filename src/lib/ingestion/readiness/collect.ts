/**
 * collectSignals — folds the verification result, the in-memory page array,
 * and run tallies into ReadinessSignals for the pure scorer. The only
 * readiness module that touches pipeline data structures; still no I/O of
 * its own (verifyIndexing already loaded the PageCache rows).
 */

import type { VerificationResult } from '../indexing-verifier';
import {
  countPagesWithHeadings,
  detectGlyphArtifacts,
  detectRepeatedContent,
  detectTokenBloat,
} from './detectors';
import type { PageTextLike, ReadinessSignals } from './types';

export function collectSignals(opts: {
  verification: VerificationResult;
  chunkCount: number;
  /** Pages that failed to render during extraction (from the in-memory PageText array). */
  renderFailedCount: number;
  /** OCR/parse errors accumulated during the run (0 under current hard-fail semantics). */
  parseErrorCount?: number;
  /** Pipeline OCR trigger threshold (config.ocrThreshold). */
  ocrThreshold: number;
}): ReadinessSignals {
  const { verification, chunkCount, renderFailedCount, ocrThreshold } = opts;
  const pages: PageTextLike[] = verification.pages ?? [];

  const extractPages = pages.filter((p) => p.source === 'extract');
  const ocrPages = pages.filter((p) => p.source === 'ocr');

  // Image-only = OCR-sourced pages PLUS extract pages that stayed below the
  // OCR trigger (either never OCR'd or OCR output fell under the min-length
  // acceptance gate and was discarded).
  const imageOnlyPages =
    ocrPages.length + extractPages.filter((p) => p.textDensity < ocrThreshold).length;

  const totalChars = pages.reduce((sum, p) => sum + p.text.trim().length, 0);
  const meanExtractDensity =
    extractPages.length > 0
      ? extractPages.reduce((sum, p) => sum + p.textDensity, 0) / extractPages.length
      : 0;

  const ocrConfidences = ocrPages
    .map((p) => p.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
  // Confidence is stored 0–1 by some engines and 0–100 by others; normalize to 0–100.
  const normalizedConfidences = ocrConfidences.map((c) => (c <= 1 ? c * 100 : c));
  const meanOcrConfidence =
    normalizedConfidences.length > 0
      ? normalizedConfidences.reduce((s, c) => s + c, 0) / normalizedConfidences.length
      : null;

  const glyph = detectGlyphArtifacts(pages);
  const repetition = detectRepeatedContent(pages);

  return {
    pageCount: verification.totalPages,
    pagesWithText: verification.pagesWithText,
    gapPages: verification.gapPages,
    ocrPages: verification.ocrPages,
    imageOnlyPages,
    parseErrorCount: (opts.parseErrorCount ?? 0) + renderFailedCount,
    totalChars,
    meanExtractDensity,
    meanOcrConfidence,
    chunkCount,
    pagesWithHeadings: countPagesWithHeadings(pages),
    glyphArtifactPages: glyph.pages,
    repeatedContent: repetition.fired,
    tokenBloat: detectTokenBloat(pages),
  };
}
