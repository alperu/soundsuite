/**
 * computeReadiness — pure scoring over collected signals. No I/O, no
 * Prisma; drives the table-driven tests and keeps threshold tuning cheap.
 *
 * Baseline by format class, then deterministic penalties, then suppression
 * rules, clamped to [0,100]. Penalty table documented in
 * docs/TODO-paddleocr-vl-and-readiness-score.md §B.
 */

import { classifyBaseline } from './detectors';
import {
  bandForScore,
  type ReadinessResult,
  type ReadinessSignals,
  type ReadinessWarning,
} from './types';

const PARSE_ERROR_PENALTY = 12;
const PARSE_ERROR_CAP = 30;
const MISSING_PAGE_PENALTY = 4;
const MISSING_PAGE_CAP = 38;
const MISSING_PAGE_IMAGE_HEAVY_EXTRA = 8;
const OCR_REQUIRED_MAX = 40;
const NEAR_EMPTY_PENALTY = 25;
const GLYPH_PENALTY = 25;
const LOW_DENSITY_PENALTY = 20;
const REPEATED_PENALTY = 8;
const BLOAT_PENALTY = 8;
const NO_HEADINGS_PENALTY = 6;
const LOW_CHUNKS_PENALTY = 10;

/** Near-empty: fewer than ~40 chars per page on average. */
const NEAR_EMPTY_CHARS_PER_PAGE = 40;
/** Low density: extract-sourced pages averaging under this many chars. */
const LOW_DENSITY_MEAN = 150;

export function computeReadiness(signals: ReadinessSignals): ReadinessResult {
  const warnings: ReadinessWarning[] = [];
  const { baseline, formatClass } = classifyBaseline(signals);
  let score = baseline;

  const pageCount = Math.max(1, signals.pageCount);
  const imageFraction = signals.imageOnlyPages / pageCount;
  const ocrRequired = signals.imageOnlyPages > 0;

  // OCR_REQUIRED — scaled by image-only fraction.
  if (ocrRequired) {
    const penalty = Math.round(OCR_REQUIRED_MAX * imageFraction);
    score -= penalty;
    warnings.push({
      code: 'OCR_REQUIRED',
      severity: imageFraction > 0.5 ? 'warning' : 'info',
      detail: `${signals.imageOnlyPages}/${signals.pageCount} pages are image-only (−${penalty}). OCR text is less reliable than a native text layer.`,
    });
  }

  // PARSE_ERRORS
  if (signals.parseErrorCount > 0) {
    const penalty = Math.min(PARSE_ERROR_CAP, signals.parseErrorCount * PARSE_ERROR_PENALTY);
    score -= penalty;
    warnings.push({
      code: 'PARSE_ERRORS',
      severity: 'warning',
      detail: `${signals.parseErrorCount} page(s) failed extraction/OCR (−${penalty}).`,
    });
  }

  // MISSING_PAGE
  if (signals.gapPages.length > 0) {
    let penalty = Math.min(MISSING_PAGE_CAP, signals.gapPages.length * MISSING_PAGE_PENALTY);
    if (imageFraction >= 0.5) penalty = Math.min(MISSING_PAGE_CAP, penalty + MISSING_PAGE_IMAGE_HEAVY_EXTRA);
    score -= penalty;
    warnings.push({
      code: 'MISSING_PAGE',
      severity: 'critical',
      detail: `${signals.gapPages.length} page(s) have no extracted text and are invisible to search (−${penalty}).`,
      pages: signals.gapPages.slice(0, 50),
    });
  }

  // NEAR_EMPTY_OUTPUT — suppressed when OCR_REQUIRED already explains it.
  const nearEmpty = signals.totalChars < NEAR_EMPTY_CHARS_PER_PAGE * signals.pageCount;
  if (nearEmpty && !ocrRequired) {
    score -= NEAR_EMPTY_PENALTY;
    warnings.push({
      code: 'NEAR_EMPTY_OUTPUT',
      severity: 'critical',
      detail: `Extraction produced almost no text (${signals.totalChars} chars over ${signals.pageCount} pages, −${NEAR_EMPTY_PENALTY}).`,
    });
  }

  // GLYPH_ARTIFACTS
  if (signals.glyphArtifactPages.length > 0) {
    score -= GLYPH_PENALTY;
    warnings.push({
      code: 'GLYPH_ARTIFACTS',
      severity: 'critical',
      detail: `${signals.glyphArtifactPages.length} page(s) contain garbled font output (CID artifacts) — text may look plausible but be wrong (−${GLYPH_PENALTY}). Re-OCR these pages.`,
      pages: signals.glyphArtifactPages.slice(0, 50),
    });
  }

  // LOW_TEXT_DENSITY — suppressed when OCR_REQUIRED already explains it.
  const lowDensity =
    signals.meanExtractDensity > 0 && signals.meanExtractDensity < LOW_DENSITY_MEAN;
  if (lowDensity && !ocrRequired) {
    score -= LOW_DENSITY_PENALTY;
    warnings.push({
      code: 'LOW_TEXT_DENSITY',
      severity: 'warning',
      detail: `Mean text density is ${Math.round(signals.meanExtractDensity)} chars/page — extraction may be incomplete (−${LOW_DENSITY_PENALTY}).`,
    });
  }

  // REPEATED_CONTENT
  if (signals.repeatedContent) {
    score -= REPEATED_PENALTY;
    warnings.push({
      code: 'REPEATED_CONTENT',
      severity: 'warning',
      detail: `Pathological repetition detected across pages — possible stuck extractor or OCR loop (−${REPEATED_PENALTY}).`,
    });
  }

  // TOKEN_BLOAT
  if (signals.tokenBloat) {
    score -= BLOAT_PENALTY;
    warnings.push({
      code: 'TOKEN_BLOAT',
      severity: 'warning',
      detail: `Text is dominated by whitespace/fragmented tokens — per-character extraction artifacts (−${BLOAT_PENALTY}).`,
    });
  }

  // NO_HEADINGS on multipage documents.
  if (signals.pageCount >= 2 && signals.pagesWithHeadings === 0 && signals.pagesWithText > 0) {
    score -= NO_HEADINGS_PENALTY;
    warnings.push({
      code: 'NO_HEADINGS',
      severity: 'info',
      detail: `No section headings detected across ${signals.pageCount} pages — chunk provenance will be weaker (−${NO_HEADINGS_PENALTY}).`,
    });
  }

  // LOW_CHUNK_COUNT — fewer chunks than half the text-bearing pages.
  if (signals.pagesWithText > 0 && signals.chunkCount < signals.pagesWithText / 2) {
    score -= LOW_CHUNKS_PENALTY;
    warnings.push({
      code: 'LOW_CHUNK_COUNT',
      severity: 'warning',
      detail: `Only ${signals.chunkCount} chunk(s) indexed for ${signals.pagesWithText} text-bearing pages (−${LOW_CHUNKS_PENALTY}).`,
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, band: bandForScore(score), baseline, formatClass, warnings };
}
