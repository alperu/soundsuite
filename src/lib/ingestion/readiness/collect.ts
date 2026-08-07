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
import type { PageClassCounts, PageQualityClass, PageTextLike, ReadinessSignals } from './types';

/** Density below which a native-text page counts as thin (chars/page). */
const THIN_TEXT_DENSITY = 150;

/**
 * Classify one page into the v2 quality ladder ('blank' = excluded).
 * Shared by the document histogram and the per-page scorer (Phase 3) so a
 * page can never carry different classes on the two surfaces.
 */
export function classifyPageQuality(
  p: PageTextLike,
  glyphPages: Set<number>,
): PageQualityClass | 'blank' {
  if (p.source === 'empty') return 'blank';
  if (!p.text || p.text.trim().length === 0) return 'missing';
  if (glyphPages.has(p.pageNumber)) return 'glyph';
  if (p.source === 'ocr') {
    const conf = typeof p.confidence === 'number' && Number.isFinite(p.confidence)
      ? (p.confidence <= 1 ? p.confidence * 100 : p.confidence)
      : null;
    if (conf === null || conf >= 90) return 'ocrHigh';
    if (conf >= 75) return 'ocrMid';
    return 'ocrLow';
  }
  return p.textDensity < THIN_TEXT_DENSITY ? 'textThin' : 'text';
}

/**
 * Classify every non-blank page into the v2 quality ladder. Pages absent
 * from PageCache (never extracted) surface via gapPages as 'missing'.
 */
function buildPageClassCounts(
  pages: PageTextLike[],
  gapPages: number[],
  glyphPages: Set<number>,
): PageClassCounts {
  const counts: PageClassCounts = {
    text: 0, textThin: 0, ocrHigh: 0, ocrMid: 0, ocrLow: 0, glyph: 0, missing: 0,
  };
  const gapSet = new Set(gapPages);
  for (const p of pages) {
    const cls = classifyPageQuality(p, glyphPages);
    if (cls === 'blank') continue;               // excluded entirely
    if (gapSet.has(p.pageNumber)) continue;      // counted below from gapPages
    counts[cls]++;
  }
  counts.missing = gapPages.length;
  return counts;
}

export function collectSignals(opts: {
  verification: VerificationResult;
  chunkCount: number;
  /** Pages that failed to render during extraction (from the in-memory PageText array). */
  renderFailedCount: number;
  /** OCR/parse errors accumulated during the run (0 under current hard-fail semantics). */
  parseErrorCount?: number;
  /** Pipeline OCR trigger threshold (config.ocrThreshold). */
  ocrThreshold: number;
  /** Document.documentType — record compilations get repetition leniency. */
  documentType?: string | null;
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
  const pageClassCounts = buildPageClassCounts(
    pages,
    verification.gapPages,
    new Set(glyph.pages),
  );

  return {
    pageClassCounts,
    pageCount: verification.totalPages,
    pagesWithText: verification.pagesWithText,
    gapPages: verification.gapPages,
    blankPages: verification.blankPages ?? [],
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
    isRecordCompilation: /clerk.?s?\s+record|reporter.?s?\s+record|appendix/i.test(opts.documentType ?? ''),
  };
}
