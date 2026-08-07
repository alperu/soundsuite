/**
 * computeReadiness — pure scoring over collected signals. No I/O, no
 * Prisma; drives the table-driven tests and keeps threshold tuning cheap.
 *
 * v2 model (READINESS_MODEL_VERSION = 2):
 *
 *   Q     = mean page quality over non-blank pages (PAGE_QUALITY ladder)
 *   score = clamp(0..100, round(Q − Σ integrity penalties))
 *   band  = bandForScore(score)          — thresholds unchanged (85/70/50)
 *
 * Organizing principle: content quality dilutes with document size (38
 * garbled pages in a 1400-page record is a repair list, not a condemnation);
 * retrieval integrity does NOT dilute (one invisible page is a correctness
 * hazard at full strength — an AI will confidently answer "that does not
 * appear in the record" when it does). Quality is averaged; integrity is
 * floored. Any critical warning caps the score below HIGH.
 *
 * v1's format-class baselines no longer drive arithmetic — the baseline is
 * emergent from the page mix (a text PDF averages ~95, a clean scan ~80).
 * This also fixes v1's double-priced scan penalty (baseline drop AND
 * OCR_REQUIRED for the same pages → a clean 93%-confidence scan scored 32).
 * `formatClass` is kept as a descriptive label.
 */

import { classifyBaseline } from './detectors';
import {
  bandForScore,
  PAGE_QUALITY,
  type PageQualityClass,
  type ReadinessResult,
  type ReadinessSignals,
  type ReadinessWarning,
} from './types';

const REPEATED_PENALTY = 8;
const BLOAT_PENALTY = 8;
const NO_HEADINGS_PENALTY = 6;
const LOW_CHUNKS_PENALTY = 10;

/** Missing-page integrity curve: floor 10 (any gap costs a band's worth of
 * confidence regardless of size), √ growth (the existence of a gap is most
 * of the signal), cap 40. 1/1403→−11 · 3/10→−35 · half missing→−40. */
const MISSING_FLOOR = 10;
const MISSING_SLOPE = 45;
const MISSING_CAP = 40;

/** Near-empty: fewer than ~40 chars per non-blank page on average. */
const NEAR_EMPTY_CHARS_PER_PAGE = 40;

/** Any critical warning caps the score below HIGH — "how good is the text"
 * must not override "is it safe to trust without checking". */
const CRITICAL_SCORE_CAP = 84;

export function computeReadiness(signals: ReadinessSignals): ReadinessResult {
  const warnings: ReadinessWarning[] = [];
  const { formatClass } = classifyBaseline(signals);
  const counts = signals.pageClassCounts;

  const blankCount = signals.blankPages?.length ?? 0;
  const effectivePages = (Object.keys(counts) as PageQualityClass[]).reduce(
    (sum, k) => sum + counts[k],
    0,
  );

  if (blankCount > 0) {
    warnings.push({
      code: 'BLANK_PAGES',
      severity: 'info',
      detail: `${blankCount} page(s) are blank (no content on the page image) — excluded from scoring.`,
      pages: signals.blankPages.slice(0, 50),
    });
  }

  // Degenerate: nothing to score. An all-blank/empty PDF is a bad input,
  // not a quality measurement.
  if (effectivePages === 0) {
    warnings.push({
      code: 'NEAR_EMPTY_OUTPUT',
      severity: 'critical',
      detail: 'Document has no scoreable pages.',
    });
    return {
      score: 0,
      band: bandForScore(0),
      pageQuality: 0,
      pageClassCounts: counts,
      formatClass,
      warnings,
    };
  }

  // ── Content quality: page-average ────────────────────────────────────
  const qualitySum = (Object.keys(counts) as PageQualityClass[]).reduce(
    (sum, k) => sum + counts[k] * PAGE_QUALITY[k],
    0,
  );
  const pageQuality = qualitySum / effectivePages;

  // Informational warnings whose cost is already priced into Q:
  const ocrPageCount = counts.ocrHigh + counts.ocrMid + counts.ocrLow;
  if (ocrPageCount > 0) {
    warnings.push({
      code: 'OCR_REQUIRED',
      severity: 'info',
      detail: `${ocrPageCount}/${effectivePages} page(s) rely on OCR text — priced into the page-quality average, not separately penalized.`,
    });
  }
  if (counts.glyph > 0) {
    const glyphFraction = counts.glyph / effectivePages;
    warnings.push({
      code: 'GLYPH_ARTIFACTS',
      severity: glyphFraction >= 0.1 ? 'critical' : 'warning',
      detail: `${counts.glyph} page(s) contain garbled font output (CID artifacts) — text may look plausible but be wrong; those pages score 0 in the quality average. Re-OCR them.`,
      pages: signals.glyphArtifactPages.slice(0, 50),
    });
  }
  const nearEmpty = signals.totalChars < NEAR_EMPTY_CHARS_PER_PAGE * effectivePages;
  if (nearEmpty) {
    warnings.push({
      code: 'NEAR_EMPTY_OUTPUT',
      severity: 'critical',
      detail: `Extraction produced almost no text (${signals.totalChars} chars over ${effectivePages} scoreable pages).`,
    });
  }

  // ── Integrity penalties: floored, never diluted ───────────────────────
  let penalties = 0;

  if (counts.missing > 0) {
    if (signals.estimatedGaps) {
      // Chunk-derived gap ≠ verified gap — the evidence cannot support a
      // score change; keep the warning, drop the penalty and the severity.
      warnings.push({
        code: 'MISSING_PAGE',
        severity: 'warning',
        detail: `${counts.missing} page(s) produced no indexed chunks (backfill estimate — unverified; not penalized).`,
        pages: signals.gapPages.slice(0, 50),
      });
    } else {
      const fraction = counts.missing / effectivePages;
      const penalty = Math.min(
        MISSING_CAP,
        MISSING_FLOOR + Math.round(MISSING_SLOPE * Math.sqrt(fraction)),
      );
      penalties += penalty;
      const errNote = signals.parseErrorCount > 0
        ? ` (${signals.parseErrorCount} of these failed during extraction/OCR)`
        : '';
      warnings.push({
        code: 'MISSING_PAGE',
        severity: 'critical',
        detail: `${counts.missing} page(s) have no extracted text and are invisible to search${errNote} (−${penalty}).`,
        pages: signals.gapPages.slice(0, 50),
      });
    }
  }

  if (signals.repeatedContent) {
    if (signals.isRecordCompilation) {
      warnings.push({
        code: 'REPEATED_CONTENT',
        severity: 'info',
        detail: 'Repeated content across pages — expected for a record compilation (same orders/forms filed multiple times); not penalized.',
      });
    } else {
      penalties += REPEATED_PENALTY;
      warnings.push({
        code: 'REPEATED_CONTENT',
        severity: 'warning',
        detail: `Pathological repetition detected across pages — possible stuck extractor or OCR loop (−${REPEATED_PENALTY}).`,
      });
    }
  }

  if (signals.tokenBloat) {
    penalties += BLOAT_PENALTY;
    warnings.push({
      code: 'TOKEN_BLOAT',
      severity: 'warning',
      detail: `Text is dominated by whitespace/fragmented tokens — per-character extraction artifacts (−${BLOAT_PENALTY}).`,
    });
  }

  if (effectivePages >= 2 && signals.pagesWithHeadings === 0 && signals.pagesWithText > 0) {
    penalties += NO_HEADINGS_PENALTY;
    warnings.push({
      code: 'NO_HEADINGS',
      severity: 'info',
      detail: `No section headings detected across ${effectivePages} pages — chunk provenance will be weaker (−${NO_HEADINGS_PENALTY}).`,
    });
  }

  if (signals.pagesWithText > 0 && signals.chunkCount < signals.pagesWithText / 2) {
    penalties += LOW_CHUNKS_PENALTY;
    warnings.push({
      code: 'LOW_CHUNK_COUNT',
      severity: 'warning',
      detail: `Only ${signals.chunkCount} chunk(s) indexed for ${signals.pagesWithText} text-bearing pages (−${LOW_CHUNKS_PENALTY}).`,
    });
  }

  let score = Math.max(0, Math.min(100, Math.round(pageQuality - penalties)));
  if (warnings.some((w) => w.severity === 'critical')) {
    score = Math.min(score, CRITICAL_SCORE_CAP);
  }

  return {
    score,
    band: bandForScore(score),
    pageQuality: Math.round(pageQuality * 100) / 100,
    pageClassCounts: counts,
    formatClass,
    warnings,
  };
}
