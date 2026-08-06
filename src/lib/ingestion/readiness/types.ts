/**
 * AI Readiness Score — shared types.
 *
 * A 0–100 quality score computed at the end of ingestion, before PageCache
 * is cleared. Converts "garbage OCR silently reaches INDEXED" into a visible
 * banded signal (HIGH / OK / RISKY / POOR). Design rationale and penalty
 * table: docs/TODO-paddleocr-vl-and-readiness-score.md Part B.
 */

export type ReadinessBand = 'HIGH' | 'OK' | 'RISKY' | 'POOR';

export type WarningCode =
  | 'OCR_REQUIRED'
  | 'MISSING_PAGE'
  | 'NEAR_EMPTY_OUTPUT'
  | 'GLYPH_ARTIFACTS'
  | 'LOW_TEXT_DENSITY'
  | 'REPEATED_CONTENT'
  | 'TOKEN_BLOAT'
  | 'NO_HEADINGS'
  | 'PARSE_ERRORS'
  | 'LOW_CHUNK_COUNT'
  /** Score computed by the backfill endpoint from indexed chunks — PageCache
   * was already cleared, so OCR provenance and pre-chunk text were
   * unavailable and the score is an estimate. */
  | 'BACKFILL_ESTIMATE';

export interface ReadinessWarning {
  code: WarningCode;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
  /** 1-indexed page numbers the warning applies to, when page-scoped. */
  pages?: number[];
}

/** Document format classes with distinct quality baselines. */
export type FormatClass =
  | 'text-pdf'          // native text layer throughout (e-filed)
  | 'mixed'             // text layer + scanned exhibit pages
  | 'scanned-clean'     // mostly scanned, OCR confident
  | 'scanned-degraded'  // mostly scanned, OCR low-confidence
  | 'image-only';       // image pages that produced no usable OCR text

/** Minimal per-page shape the detectors need. */
export interface PageTextLike {
  pageNumber: number;
  text: string;
  textDensity: number;
  source: 'extract' | 'ocr';
  confidence: number | null;
}

/** All scoring inputs — collected once, scored purely. */
export interface ReadinessSignals {
  pageCount: number;
  /** Pages present in PageCache with non-empty text. */
  pagesWithText: number;
  /** 1-indexed page numbers missing from PageCache / empty. */
  gapPages: number[];
  /** Pages whose text came from OCR. */
  ocrPages: number;
  /**
   * Pages that are effectively image-only: OCR-sourced pages PLUS pages
   * that stayed 'extract' with near-zero text because OCR fell under the
   * min-length acceptance gate.
   */
  imageOnlyPages: number;
  /** Parse/render/OCR errors accumulated during the run. */
  parseErrorCount: number;
  /** Total trimmed characters across all cached pages. */
  totalChars: number;
  /** Mean pre-OCR text density of extract-sourced pages. */
  meanExtractDensity: number;
  /** Mean OCR confidence (0–100) across OCR pages, null if none reported. */
  meanOcrConfidence: number | null;
  /** Chunks inserted into the vector store. */
  chunkCount: number;
  /** Pages containing at least one section heading. */
  pagesWithHeadings: number;
  /** Detector findings. */
  glyphArtifactPages: number[];
  repeatedContent: boolean;
  tokenBloat: boolean;
  /**
   * True for record compilations (clerk's record, reporter's record,
   * appendix): the same orders/forms legitimately appear multiple times, so
   * REPEATED_CONTENT is reported as info instead of penalized.
   */
  isRecordCompilation: boolean;
}

export interface ReadinessResult {
  score: number;
  band: ReadinessBand;
  baseline: number;
  formatClass: FormatClass;
  warnings: ReadinessWarning[];
}

/** Band thresholds: HIGH ≥85, OK ≥70, RISKY ≥50, else POOR. */
export function bandForScore(score: number): ReadinessBand {
  if (score >= 85) return 'HIGH';
  if (score >= 70) return 'OK';
  if (score >= 50) return 'RISKY';
  return 'POOR';
}
