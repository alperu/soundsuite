/**
 * AI Readiness Score — shared types.
 *
 * A 0–100 quality score computed at the end of ingestion, before PageCache
 * is cleared. Converts "garbage OCR silently reaches INDEXED" into a visible
 * banded signal (HIGH / OK / RISKY / POOR). Design rationale and penalty
 * table: docs/TODO-paddleocr-vl-and-readiness-score.md Part B.
 */

export type ReadinessBand = 'HIGH' | 'OK' | 'RISKY' | 'POOR';

/**
 * Scoring model version stamped on Document.readinessModelVersion.
 * v1: format-class baseline minus flat penalties.
 * v2: mean per-page quality minus integrity-only penalties (content quality
 *     dilutes with size; retrieval integrity does not).
 */
export const READINESS_MODEL_VERSION = 2;

/**
 * Per-page quality ladder (v2). Each non-blank page is one retrieval target
 * and contributes its class value to the document's quality mean.
 */
export const PAGE_QUALITY: Record<PageQualityClass, number> = {
  text: 95,       // native text layer, healthy density, glyph-clean
  textThin: 70,   // native text layer but sparse (density < 150)
  ocrHigh: 80,    // OCR, confidence ≥ 90 or unreported
  ocrMid: 70,     // OCR, 75 ≤ confidence < 90
  ocrLow: 50,     // OCR, confidence < 75
  glyph: 0,       // glyph detector fired — plausible-but-wrong text
  missing: 0,     // no text at all — invisible to search
};

export type PageQualityClass =
  | 'text'
  | 'textThin'
  | 'ocrHigh'
  | 'ocrMid'
  | 'ocrLow'
  | 'glyph'
  | 'missing';

/** Histogram of non-blank pages by quality class. */
export type PageClassCounts = Record<PageQualityClass, number>;

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
  | 'BACKFILL_ESTIMATE'
  /** Pages verified blank-by-design (separator/back pages) — excluded from
   * scoring, informational only. */
  | 'BLANK_PAGES';

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
  /** 'empty' = classified blank-by-design (render ok + OCR empty + ink below
   * threshold) — excluded from quality scoring rather than penalized. */
  source: 'extract' | 'ocr' | 'empty';
  confidence: number | null;
}

/** All scoring inputs — collected once, scored purely. */
export interface ReadinessSignals {
  pageCount: number;
  /** Pages present in PageCache with non-empty text. */
  pagesWithText: number;
  /** 1-indexed page numbers missing from PageCache / empty — genuine gaps,
   * NOT including pages classified blank-by-design. */
  gapPages: number[];
  /** 1-indexed pages verified blank-by-design (source='empty'). Excluded
   * from quality scoring and from fraction denominators. */
  blankPages: number[];
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
  /** v2: histogram of non-blank pages by quality class. */
  pageClassCounts: PageClassCounts;
  /**
   * True when gaps were derived from indexed-chunk reconstruction (backfill
   * estimate) — a chunk-derived gap is indistinguishable from a page that
   * simply produced no chunk, so the missing-page penalty is suppressed.
   */
  estimatedGaps?: boolean;
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
  /** v2: mean per-page quality Q over non-blank pages (before integrity penalties). */
  pageQuality: number;
  /** v2: page histogram behind Q. */
  pageClassCounts: PageClassCounts;
  /** Format class kept as a descriptive label only (no longer drives arithmetic). */
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
