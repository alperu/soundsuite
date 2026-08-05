/**
 * OCR quality gate — per-output garbage rejection, applied by OllamaOCREngine
 * before any OCR text can reach chunking/embedding.
 *
 * Vision models fed degraded/blank scans produce several distinct garbage
 * shapes (all observed 2026-08-05 on a scanned clerk's record):
 *   - repetition loops       "The quick brown fox…" ×200, "en/en/en/…"
 *   - templated repetition   "Page 1 of 2 Page 3 of 4 Page 5 of 6 …"
 *   - unexpected script      "欽定四庫全書" (CJK on an English court record)
 *   - LaTeX hallucination    "\( \sin(\theta) = \frac{3}{5} \)…"
 *   - letter soup            "STANDING BONBERT HORANILAYPAVLCASRS…"
 *
 * Each check is high-precision by construction (legal text: repeated table
 * cells, ALL-CAPS captions, §/№ symbols, and dense citations must all pass).
 * Known non-goals, handled elsewhere or accepted:
 *   - fluent-but-fabricated English filler is indistinguishable heuristically
 *     (Phase 1 readiness scoring / A-B review territory);
 *   - very short garbage (< ~40 chars, e.g. "Aunt Lunch") is low-harm and
 *     not reliably separable from legit stamps/captions;
 *   - run-together ligature text from the PDF *extract* path is not OCR
 *     output — that is a pdftext spacing defect, flagged by the readiness
 *     glyph detector.
 *
 * NOTE: the script check assumes a Latin-script corpus (US court records).
 * If genuinely non-Latin exhibits are ever expected, lift EXPECTED_SCRIPT
 * into config instead of deleting the check.
 */

import { WORDLIST } from './readiness/detectors';

export interface OcrQualityAssessment {
  ok: boolean;
  /** Machine-readable failure reasons (empty when ok). */
  reasons: string[];
}

// Repetition
const REPETITION_MIN_CHARS = 240;
const SHINGLE_STRIDE = 24;
const SHINGLE_MIN_COUNT = 8;
const SHINGLE_UNIQUE_RATIO = 0.25;
const LINE_MIN_COUNT = 8;
const LINE_UNIQUE_RATIO = 0.2;
// Script
const CJK_RE = /[⺀-⻿　-〿぀-ヿ㄰-㆏㇀-鿿ꥠ-꥿가-퟿豈-﫿]/g;
// LaTeX
const LATEX_RE = /\\(?:frac|sin|cos|tan|theta|sqrt|sum|int|alpha|beta|gamma|pi|cdot|times|left|right)\b|\\\(|\\\[/g;
// Letter soup
const SOUP_MIN_CHARS = 60;
const SOUP_MIN_TOKENS = 8;
const SOUP_DICT_RATIO = 0.08;
const SOUP_WORDLIKE_RATIO = 0.5;
const RUN_TOGETHER_TOKEN_LEN = 30;

/** Pronounceable-looking token: has a vowel, no 5+ consonant run. Separates
 * domain nouns absent from the wordlist ("Mortgage", "payment") from OCR
 * letter soup ("ZQBLK", "MRVBLKT"). */
function isWordlike(token: string): boolean {
  return /[aeiouy]/i.test(token) && !/[bcdfghjklmnpqrstvwxz]{5,}/i.test(token);
}

function shingleRatioLow(text: string): boolean {
  const shingles = new Set<string>();
  let count = 0;
  for (let i = 0; i + SHINGLE_STRIDE <= text.length; i += SHINGLE_STRIDE) {
    shingles.add(text.slice(i, i + SHINGLE_STRIDE));
    count++;
  }
  return count >= SHINGLE_MIN_COUNT && shingles.size / count < SHINGLE_UNIQUE_RATIO;
}

function isRepetitionLoop(text: string): boolean {
  if (text.length < REPETITION_MIN_CHARS) return false;
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length >= LINE_MIN_COUNT) {
    const unique = new Set(lines);
    if (unique.size / lines.length < LINE_UNIQUE_RATIO) return true;
  }
  if (shingleRatioLow(text)) return true;
  // Templated repetition: identical structure with varying numbers
  // ("Page 1 of 2 Page 3 of 4 …") — normalize digit runs and re-check.
  // Guarded hard against false positives on legitimate tabular content,
  // which repeats row structure by design: skip anything with table or
  // currency markers, and require a tiny word vocabulary (the garbage
  // shape is a 2–4 word template around numbers).
  if (/[|$\t]/.test(text)) return false;
  const vocab = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  if (vocab.size > 4) return false;
  return shingleRatioLow(text.replace(/\d+/g, '#'));
}

export function assessOcrOutput(text: string): OcrQualityAssessment {
  const t = text.trim();
  const reasons: string[] = [];
  if (!t) return { ok: true, reasons }; // empty is handled as "no text" upstream

  if (isRepetitionLoop(t)) reasons.push('repetition-loop');

  // Unexpected script: CJK glyphs at parity with (or exceeding) Latin letters.
  // A stray stamp glyph on an English page is dominated by Latin and passes.
  const cjkCount = (t.match(CJK_RE) || []).length;
  if (cjkCount >= 2) {
    const latinCount = (t.match(/[A-Za-z]/g) || []).length;
    if (cjkCount >= latinCount) reasons.push('unexpected-script');
  }

  // LaTeX markup: court records never contain raw LaTeX; 2+ commands ⇒
  // the model is reciting math training data, not reading the page.
  if ((t.match(LATEX_RE) || []).length >= 2) reasons.push('latex-hallucination');

  // Letter soup: enough tokens to judge, near-zero legal/function-word hits.
  if (t.length >= SOUP_MIN_CHARS) {
    const tokens = t.split(/\s+/).filter(Boolean);
    if (tokens.some(tok => tok.length >= RUN_TOGETHER_TOKEN_LEN && /[a-z]/i.test(tok))) {
      reasons.push('run-together-text');
    }
    if (tokens.length >= SOUP_MIN_TOKENS) {
      const alphaTokens = tokens.filter(tok => /^[a-z]+$/i.test(tok));
      if (alphaTokens.length >= SOUP_MIN_TOKENS) {
        const hits = alphaTokens.filter(tok => WORDLIST.has(tok.toLowerCase())).length;
        const wordlike = alphaTokens.filter(isWordlike).length;
        if (
          hits / alphaTokens.length < SOUP_DICT_RATIO &&
          wordlike / alphaTokens.length < SOUP_WORDLIKE_RATIO
        ) {
          reasons.push('letter-soup');
        }
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}
