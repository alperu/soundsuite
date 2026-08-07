/**
 * Per-page and per-chunk readiness scores (readiness v2 Phase 3). Pure —
 * no I/O; callers persist results (PageScore table, LanceDB chunk stamps).
 *
 * A page's score is its v2 quality-ladder value (PAGE_QUALITY), shared with
 * the document mean via classifyPageQuality, so the document score is
 * literally the mean of these page scores over non-blank pages. A chunk
 * inherits its page's score, then applies chunk-local modifiers that page
 * granularity cannot see (body-level garble, runt fragments).
 */

import { classifyPageQuality } from './collect';
import { pageGlyphMetrics } from './detectors';
import {
  bandForScore,
  PAGE_QUALITY,
  type PageQualityClass,
  type PageTextLike,
  type ReadinessBand,
  type WarningCode,
} from './types';

export type PageScoreClass = PageQualityClass | 'blank';

export interface PageScoreResult {
  pageNumber: number;
  /** Ladder value for scoreable classes; 0 for 'missing'/'glyph'; blank pages carry 0 with class 'blank' (render as “—”). */
  score: number;
  band: ReadinessBand;
  pageClass: PageScoreClass;
  flags: WarningCode[];
  textDensity: number;
  source: 'extract' | 'ocr' | 'empty';
  confidence: number | null;
  chunkCount: number;
}

/** A text-bearing page that produced zero chunks is invisible to retrieval
 * regardless of its text quality — clamp to this ceiling. */
const UNINDEXED_PAGE_CEILING = 40;

export function computePageScores(opts: {
  pages: PageTextLike[];
  totalPages: number;
  glyphPages: Set<number>;
  chunkCountByPage: Map<number, number>;
  /** Adds BACKFILL_ESTIMATE to every row (chunk-reconstructed provenance). */
  estimated?: boolean;
}): PageScoreResult[] {
  const byNumber = new Map(opts.pages.map((p) => [p.pageNumber, p]));
  const results: PageScoreResult[] = [];

  for (let pageNumber = 1; pageNumber <= opts.totalPages; pageNumber++) {
    const page = byNumber.get(pageNumber);
    const chunkCount = opts.chunkCountByPage.get(pageNumber) ?? 0;
    const flags: WarningCode[] = [];
    if (opts.estimated) flags.push('BACKFILL_ESTIMATE');

    let pageClass: PageScoreClass;
    let score: number;
    if (!page) {
      pageClass = 'missing';
      score = 0;
      flags.push('MISSING_PAGE');
    } else {
      pageClass = classifyPageQuality(page, opts.glyphPages);
      if (pageClass === 'blank') {
        score = 0;
        flags.push('BLANK_PAGES');
      } else {
        score = PAGE_QUALITY[pageClass];
        if (pageClass === 'missing') flags.push('MISSING_PAGE');
        if (pageClass === 'glyph') flags.push('GLYPH_ARTIFACTS');
        if (pageClass === 'textThin') flags.push('LOW_TEXT_DENSITY');
        if (pageClass === 'ocrMid' || pageClass === 'ocrLow') flags.push('OCR_REQUIRED');
        if (pageClass !== 'missing' && chunkCount === 0) {
          score = Math.min(score, UNINDEXED_PAGE_CEILING);
          flags.push('LOW_CHUNK_COUNT');
        }
      }
    }

    results.push({
      pageNumber,
      score,
      band: bandForScore(score),
      pageClass,
      flags,
      textDensity: page?.textDensity ?? 0,
      source: page?.source ?? 'extract',
      confidence: page?.confidence ?? null,
      chunkCount,
    });
  }
  return results;
}

/* ── Per-chunk score ─────────────────────────────────────────────────── */

/** Chunk body length above which the glyph metrics are meaningful. */
const CHUNK_GLYPH_MIN_CHARS = 400;
/** Ceiling for a chunk whose body itself measures as garbled. */
const CHUNK_GLYPH_CEILING = 40;
/** Bodies below this are page-number strips / stamp fragments. */
const RUNT_CHUNK_CHARS = 120;
const RUNT_PENALTY = 10;

/** Strip the injected context header and any heading prefix artifacts
 * before measuring — they inflate length and skew entropy. Same regex the
 * backfill uses on reconstruction. */
export function stripChunkArtifacts(text: string): string {
  return text.replace(/^\[Case:[^\]]*\]\s*/g, '').trim();
}

export function computeChunkScore(opts: {
  pageScore: number;
  text: string;
}): { score: number; flags: WarningCode[] } {
  const flags: WarningCode[] = [];
  const body = stripChunkArtifacts(opts.text);
  let score = opts.pageScore;

  if (body.length >= CHUNK_GLYPH_MIN_CHARS) {
    const m = pageGlyphMetrics(body);
    const garbled =
      m.replacementRatio > 0.02 ||
      (m.letterTokens >= 30 && m.dictRatio < 0.25 && m.bigramEntropy > 4.3);
    if (garbled) {
      score = Math.min(score, CHUNK_GLYPH_CEILING);
      flags.push('GLYPH_ARTIFACTS');
    }
  } else if (body.length < RUNT_CHUNK_CHARS) {
    score -= RUNT_PENALTY;
    flags.push('NEAR_EMPTY_OUTPUT');
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), flags };
}
