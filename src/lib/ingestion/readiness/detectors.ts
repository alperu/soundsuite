/**
 * Readiness detectors — pure, dependency-free, synchronous heuristics over
 * already-loaded page text. All thresholds are module constants so tuning is
 * a one-number edit backed by the detector tests.
 */

import { isSectionHeading } from '../legal-text-splitter';
import type { FormatClass, PageTextLike } from './types';

/* ── GLYPH_ARTIFACTS ─────────────────────────────────────────────────────
 * CID-font garbling in e-filed PDFs: U+FFFD runs, literal "(cid:NNN)"
 * tokens (no ToUnicode map), or plausible-looking-but-wrong letter soup.
 * Three signals with a 2-of-3 rule; the replacement/CID ratio alone is
 * high-precision enough to fire by itself. Skipped for OCR-sourced pages
 * (OCR noise is a different failure, priced by OCR_REQUIRED) and for short
 * pages (too noisy).
 */

const GLYPH_MIN_CHARS = 500;
const REPLACEMENT_RATIO_THRESHOLD = 0.02;
const DICT_RATIO_GARBLED = 0.25;
const BIGRAM_ENTROPY_GARBLED = 4.3;

/**
 * Compact English function words + court vocabulary. Healthy legal text
 * scores well above DICT_RATIO_GARBLED against this list; CID-scrambled
 * text collapses. Deliberately small — it only needs to separate prose
 * from letter soup, not spell-check.
 */
export const WORDLIST = new Set(
  (
    'the of and to in a is that for on with as by at from this be are was were or an it not which shall may have has ' +
    'had will would can could must should their there herein hereby its his her they them then than into upon under ' +
    'over between after before during without within against about above below any all each other such same no nor ' +
    'if but so do does did done being been who whom whose what when where why how also further more most less least ' +
    'court courts judge justice plaintiff plaintiffs defendant defendants petitioner respondent movant appellant ' +
    'appellee counsel attorney attorneys party parties case cause action motion order judgment decree exhibit ' +
    'exhibits affidavit declaration deposition transcript testimony witness evidence record filed filing pursuant ' +
    'section subsection paragraph pages page state states united county district appeal appeals trial hearing ' +
    'notice service certificate signature dated date law legal rule rules code statute claim claims relief damages ' +
    'contract agreement property herein aforementioned whereas therefore wherefore prays granted denied sustained ' +
    'overruled objection stipulation discovery subpoena summons complaint answer petition response reply brief ' +
    'memorandum support opposition true correct copy original certified sworn signed executed witness my hand seal ' +
    // Spanish function + court-notice vocabulary — Texas filings routinely
    // include Spanish-language notices (e.g. AVISO DE ORDEN); without these,
    // correct Spanish text scores like CID garble (observed 2026-08-05 on a
    // clerk-record page: "Se le notifica que se ha firmado e ingresado...").
    'aviso orden que se le ha una un el la los las del de por para con sin este esta esto ese esa eso su sus es son ' +
    'fue ser hay como cuando donde quien porque pero mas muy todo toda todos todas otro otra usted ustedes tribunal ' +
    'condado corte juez causa caso audiencia demanda demandado demandada peticionario notifica notificacion firmado ' +
    'firmada ingresado ingresada fecha derecho derechos abogado abogada peticion respuesta contra sobre entre debe ' +
    'puede tiene tienen sido estado documento documentos numero copia original certificado sentencia decreto'
  ).split(/\s+/),
);

/**
 * Minimum letter-tokens for the dictionary signal to be meaningful.
 * Citation indexes, exhibit pagination strips ("Index · 1 · 2 · [3] ..."),
 * and stamp-dominated pages are digit/symbol-heavy and yield too few word
 * tokens to judge — the dictionary ratio on them is noise, not signal.
 */
const DICT_MIN_TOKENS = 30;

export interface GlyphFinding {
  fired: boolean;
  pages: number[];
  /** Worst-page metrics, exposed for threshold-tuning tests. */
  maxReplacementRatio: number;
  minDictRatio: number;
  maxBigramEntropy: number;
}

function pageGlyphMetrics(text: string): {
  replacementRatio: number;
  dictRatio: number;
  bigramEntropy: number;
  letterTokens: number;
} {
  const totalChars = text.length;
  const replacementCount =
    (text.match(/�/g)?.length ?? 0) + (text.match(/\(cid:\d+\)/g)?.length ?? 0);
  const replacementRatio = totalChars > 0 ? replacementCount / totalChars : 0;

  const tokens = (text.match(/[A-Za-z']+/g) ?? []).filter((t) => t.length >= 3);
  const dictHits = tokens.filter((t) => WORDLIST.has(t.toLowerCase())).length;
  // No tokens at all on a long page is itself suspicious — treat as 0.
  const dictRatio = tokens.length > 0 ? dictHits / tokens.length : 0;
  const letterTokens = tokens.length;

  // Shannon entropy over adjacent lowercase-letter pairs. English prose sits
  // ~3.3–3.9 bits; scrambled output trends toward uniform (>4.3).
  const letters = text.toLowerCase().replace(/[^a-z]/g, '');
  const bigramCounts = new Map<string, number>();
  for (let i = 0; i < letters.length - 1; i++) {
    const bg = letters.slice(i, i + 2);
    bigramCounts.set(bg, (bigramCounts.get(bg) ?? 0) + 1);
  }
  const totalBigrams = Math.max(1, letters.length - 1);
  let bigramEntropy = 0;
  for (const count of bigramCounts.values()) {
    const p = count / totalBigrams;
    bigramEntropy -= p * Math.log2(p);
  }

  return { replacementRatio, dictRatio, bigramEntropy, letterTokens };
}

export function detectGlyphArtifacts(pages: PageTextLike[]): GlyphFinding {
  const finding: GlyphFinding = {
    fired: false,
    pages: [],
    maxReplacementRatio: 0,
    minDictRatio: 1,
    maxBigramEntropy: 0,
  };
  for (const page of pages) {
    if (page.source === 'ocr') continue;
    const text = page.text;
    if (text.length < GLYPH_MIN_CHARS) continue;
    const m = pageGlyphMetrics(text);
    finding.maxReplacementRatio = Math.max(finding.maxReplacementRatio, m.replacementRatio);
    finding.minDictRatio = Math.min(finding.minDictRatio, m.dictRatio);
    finding.maxBigramEntropy = Math.max(finding.maxBigramEntropy, m.bigramEntropy);

    // Replacement/CID ratio is precise enough to fire alone; the fuzzier
    // dictionary + entropy signals must BOTH agree, and only on pages with
    // enough word tokens for the dictionary ratio to mean anything (digit-
    // heavy citation/pagination pages are exempt — their ratio is noise).
    const fuzzyFire =
      m.letterTokens >= DICT_MIN_TOKENS &&
      m.dictRatio < DICT_RATIO_GARBLED &&
      m.bigramEntropy > BIGRAM_ENTROPY_GARBLED;
    if (m.replacementRatio > REPLACEMENT_RATIO_THRESHOLD || fuzzyFire) {
      finding.fired = true;
      finding.pages.push(page.pageNumber);
    }
  }
  return finding;
}

/* ── REPEATED_CONTENT ────────────────────────────────────────────────────
 * Court filings legitimately repeat headers/footers/captions/Bates stamps
 * on every page, so boilerplate (lines on >80% of pages, digits stripped)
 * is excluded before measuring duplication. Fires on the signature of a
 * stuck extractor or OCR loop: >30% duplicate lines after boilerplate
 * removal, or ≥3 pages with identical normalized text.
 */

const BOILERPLATE_PAGE_FRACTION = 0.8;
const DUPLICATE_LINE_FRACTION = 0.3;
const IDENTICAL_PAGE_COUNT = 3;

export interface RepetitionFinding {
  fired: boolean;
  /** Duplicate fraction after boilerplate exclusion (for tuning tests). */
  duplicateFraction: number;
  identicalPageGroups: number;
}

function normalizeLine(line: string): string {
  return line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function detectRepeatedContent(pages: PageTextLike[]): RepetitionFinding {
  const pageCount = pages.length;
  const finding: RepetitionFinding = { fired: false, duplicateFraction: 0, identicalPageGroups: 0 };
  if (pageCount < 2) return finding;

  // Identical whole pages (render loop).
  const pageTextCounts = new Map<string, number>();
  for (const page of pages) {
    const norm = normalizeLine(page.text.replace(/\n/g, ' '));
    if (!norm) continue;
    pageTextCounts.set(norm, (pageTextCounts.get(norm) ?? 0) + 1);
  }
  for (const count of pageTextCounts.values()) {
    if (count >= IDENTICAL_PAGE_COUNT) finding.identicalPageGroups++;
  }

  // Line-level duplication with boilerplate excluded.
  const linePageCounts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const raw of page.text.split('\n')) {
      const norm = normalizeLine(raw);
      if (norm.length < 4 || seen.has(norm)) continue;
      seen.add(norm);
      linePageCounts.set(norm, (linePageCounts.get(norm) ?? 0) + 1);
    }
  }
  const boilerplate = new Set<string>();
  for (const [line, count] of linePageCounts) {
    if (count > BOILERPLATE_PAGE_FRACTION * pageCount) boilerplate.add(line);
  }

  let totalLines = 0;
  let duplicateLines = 0;
  const globalCounts = new Map<string, number>();
  for (const page of pages) {
    for (const raw of page.text.split('\n')) {
      const norm = normalizeLine(raw);
      if (norm.length < 4 || boilerplate.has(norm)) continue;
      totalLines++;
      const prev = globalCounts.get(norm) ?? 0;
      if (prev > 0) duplicateLines++;
      globalCounts.set(norm, prev + 1);
    }
  }
  finding.duplicateFraction = totalLines > 0 ? duplicateLines / totalLines : 0;
  finding.fired =
    finding.identicalPageGroups > 0 || finding.duplicateFraction > DUPLICATE_LINE_FRACTION;
  return finding;
}

/* ── TOKEN_BLOAT ─────────────────────────────────────────────────────────
 * Signature of per-character text runs (positional extraction with a
 * misread transform matrix): whitespace/punctuation dwarfing alphanumerics,
 * or a mean token length below 2.
 */

const BLOAT_NOISE_RATIO = 1.5;
const BLOAT_MEAN_TOKEN_LEN = 2.0;

export function detectTokenBloat(pages: PageTextLike[]): boolean {
  const text = pages.map((p) => p.text).join('\n');
  if (text.length < 500) return false;
  const alnum = (text.match(/[A-Za-z0-9]/g) ?? []).length;
  if (alnum === 0) return false;
  const noise = text.length - alnum;
  if (noise / alnum > BLOAT_NOISE_RATIO) return true;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const meanLen = tokens.reduce((s, t) => s + t.length, 0) / tokens.length;
  return meanLen < BLOAT_MEAN_TOKEN_LEN;
}

/* ── Headings ──────────────────────────────────────────────────────────── */

export function countPagesWithHeadings(pages: PageTextLike[]): number {
  let count = 0;
  for (const page of pages) {
    const hasHeading = page.text
      .split('\n')
      .some((line) => line.trim().length > 0 && isSectionHeading(line));
    if (hasHeading) count++;
  }
  return count;
}

/* ── Format-class baseline ───────────────────────────────────────────────
 * Adapted to the actual court corpus (see TODO §B.6). The Reporter's
 * Record class is deliberately absent: the RR-aware extractor
 * (PDFParser.extractTextForRR) has no callers, so transcripts flow through
 * the generic path and score as text-pdf.
 */

const BASELINES: Record<FormatClass, number> = {
  'text-pdf': 90,
  mixed: 80,
  'scanned-clean': 72,
  'scanned-degraded': 62,
  'image-only': 45,
};

export function classifyBaseline(signals: {
  pageCount: number;
  ocrPages: number;
  imageOnlyPages: number;
  pagesWithText: number;
  meanOcrConfidence: number | null;
}): { baseline: number; formatClass: FormatClass } {
  const { pageCount, ocrPages, imageOnlyPages, pagesWithText, meanOcrConfidence } = signals;
  const imageFraction = pageCount > 0 ? imageOnlyPages / pageCount : 0;

  let formatClass: FormatClass;
  if (pagesWithText === 0) {
    formatClass = 'image-only';
  } else if (imageFraction > 0.6) {
    formatClass =
      ocrPages > 0 && (meanOcrConfidence === null || meanOcrConfidence >= 80)
        ? 'scanned-clean'
        : 'scanned-degraded';
  } else if (imageFraction >= 0.05) {
    formatClass = 'mixed';
  } else {
    formatClass = 'text-pdf';
  }
  return { baseline: BASELINES[formatClass], formatClass };
}
