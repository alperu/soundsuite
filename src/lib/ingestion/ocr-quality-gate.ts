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
  /**
   * The good prefix of an output whose ONLY defect is a repetition loop.
   *
   * Set when the model read the page correctly and then degenerated. On a
   * real corpus that is by far the most common rejection — 856 of 1,578
   * discards were pure 'repetition-loop' — and throwing the whole output
   * away lost pages that were largely correct: one measured 32,467
   * characters beginning "Schedule E (Form 1040) 2022" with accurate
   * attachment numbers and figures before it started repeating.
   *
   * Only ever present when the prefix passes every gate check on its own,
   * so salvage can never be looser than the gate. Absent when any other
   * reason is also present: an output that is ALSO CJK soup or LaTeX
   * recitation is untrustworthy from the start, and there is no reason to
   * believe a prefix of it is real text.
   */
  salvagedText?: string;
  /**
   * Why salvage declined, when repetition was the only defect.
   *
   * Shipped without this once, and the result was unfalsifiable: a real page
   * kept being discarded and the log could not say whether the salvage had
   * run and declined or whether the code was not live at all. A feature that
   * can silently do nothing needs to say so.
   */
  salvageDeclined?: string;
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
/** Fraction of characters living inside run-together tokens above which the
 * output is rejected. One URL/email/concatenated table cell in a page of
 * normal prose must pass; a page where a third of the characters sit in
 * unspaced runs is the defect this check exists for. Measured 2026-08-07:
 * the previous any-single-token rule discarded 192 valid pages/regions
 * (median 1,023 chars — one a fully correct affidavit page) in one run. */
const RUN_TOGETHER_CHAR_RATIO = 0.3;
/** Legitimately long unspaced tokens — never counted against the ratio. */
const RUN_TOGETHER_WHITELIST_RE = /^(?:https?:\/\/|www\.)|@[a-z0-9.-]+\.[a-z]{2,}$|^[a-z]:?[\\/][\w\\/.\-]+$|\.(?:pdf|docx?|xlsx?|html?|txt|jpe?g|png)$/i;

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

/** Task the output came from — mirrors OcrTask (kept as literals so this
 * module stays pure/dependency-light). Default 'ocr' preserves every
 * existing call site and test unchanged. */
export type OcrGateTask = 'ocr' | 'table' | 'seal' | 'formula' | 'chart';

/** Every gate reason for one output. Pure, and re-entrant-safe: the salvage
 *  search below calls THIS, never assessOcrOutput, so it cannot recurse. */
function computeReasons(text: string, task: OcrGateTask): string[] {
  const raw = text.trim();
  const reasons: string[] = [];
  if (!raw) return reasons; // empty is handled as "no text" upstream

  // Table Recognition: output is HTML (or markdown pipes). Markup is
  // repetitive by construction (`</td><td>` × N) and would trip the text
  // profile's repetition/soup/run-together checks on VALID tables — so
  // structural checks run on raw markup, content checks on stripped text.
  if (task === 'table') {
    const hasHtmlTable = /<table[\s>]/i.test(raw);
    const cellCount = (raw.match(/<t[dh][\s>]/gi) || []).length;
    // PaddleOCR-VL 'Table Recognition:' actually emits OTSL cell markup —
    // <fcel>value<lcel>…<nl> (first-cell / linked-cell / empty-cell /
    // new-row tokens), NOT HTML. Measured on real financial exhibits
    // 2026-08-06 (Phase 0). A normalizer converts OTSL → HTML downstream;
    // the gate must accept it as valid structure.
    const otslCells = (raw.match(/<(?:fcel|lcel|ecel|nl)>/g) || []).length;
    const pipeLines = raw.split('\n').filter(l => (l.match(/\|/g) || []).length >= 2).length;
    if (hasHtmlTable) {
      if (cellCount < 4) reasons.push('table-empty');
      // Unclosed table or output ending mid-tag ⇒ num_predict exhaustion.
      // A truncated table looks structured and is wrong — reject.
      if (!/<\/table>/i.test(raw) || /<[a-z][^>]*$/i.test(raw)) reasons.push('table-truncated');
    } else if (otslCells >= 4) {
      // OTSL: output ending mid-token ⇒ truncation.
      if (/<[a-z][^>]*$/i.test(raw)) reasons.push('table-truncated');
    } else if (pipeLines < 2) {
      // Neither HTML, OTSL, nor a markdown pipe table — the model returned
      // prose or noise for a table crop.
      reasons.push('table-empty');
    }
  }

  // Content under judgment: markup stripped for table output, raw otherwise.
  const t = task === 'table'
    ? raw.replace(/<(?:fcel|lcel|ecel|nl)>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : raw;

  // Repetition: skipped for 'table' (row structure legitimately repeats even
  // after markup stripping) and 'seal' (a 3-word output has no shingles).
  if (task !== 'table' && task !== 'seal' && isRepetitionLoop(t)) {
    reasons.push('repetition-loop');
  }

  // Unexpected script: CJK glyphs at parity with (or exceeding) Latin letters.
  // A stray stamp glyph on an English page is dominated by Latin and passes.
  // Valid for every task — it is exactly the failure mode of a garbage crop.
  const cjkCount = (t.match(CJK_RE) || []).length;
  if (cjkCount >= 2) {
    const latinCount = (t.match(/[A-Za-z]/g) || []).length;
    if (cjkCount >= latinCount) reasons.push('unexpected-script');
  }

  // LaTeX markup: court records never contain raw LaTeX; 2+ commands ⇒
  // the model is reciting math training data, not reading the page.
  if ((t.match(LATEX_RE) || []).length >= 2) reasons.push('latex-hallucination');

  // Letter soup / run-together: text-profile checks; skipped for 'table'
  // (numeric tables with short header abbreviations false-positive) and
  // 'seal' (too short to judge).
  if (task !== 'table' && task !== 'seal' && t.length >= SOUP_MIN_CHARS) {
    const tokens = t.split(/\s+/).filter(Boolean);
    // Run-together: RATIO test, not any-single-token. Reject only when a
    // meaningful share of the page's characters sit inside long unspaced
    // alpha runs — after excluding URL/email/path/filename-shaped tokens,
    // which are legitimately long. (The old `some()` quantifier zeroed
    // whole valid pages over one URL or concatenated cell.)
    const runTogetherChars = tokens
      .filter(tok =>
        tok.length >= RUN_TOGETHER_TOKEN_LEN &&
        /[a-z]/i.test(tok) &&
        !RUN_TOGETHER_WHITELIST_RE.test(tok))
      .reduce((sum, tok) => sum + tok.length, 0);
    if (runTogetherChars / t.length > RUN_TOGETHER_CHAR_RATIO) {
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

  return reasons;
}

// ---------------------------------------------------------------------------
// Repetition-loop salvage
// ---------------------------------------------------------------------------

/**
 * Below this, a salvaged prefix is not worth the risk.
 *
 * It must sit comfortably ABOVE REPETITION_MIN_CHARS (240), and that is the
 * load-bearing reason for the value rather than a taste call. `isRepetitionLoop`
 * returns false for anything shorter than 240 characters — so on an output
 * that is a loop from its very first line, the "longest passing prefix" would
 * be ~239 characters of pure garbage that passed only because the detector is
 * not operative at that length. Requiring 400 keeps the detector live on
 * whatever is returned.
 */
const MIN_SALVAGE_CHARS = 400;

/** Normalized line key: the loop shape varies only in digits and spacing
 *  ("Page 1 of 2 Page 3 of 4"), so those must not make a line look novel. */
function lineKey(line: string): string {
  return line.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
}

/** Below this share of novel lines, a run is restating rather than reading. */
const NOVELTY_FLOOR = 0.1;
/** A line recurring at least this often across the output is loop furniture. */
const REPEAT_IS_LOOPY = 3;

/**
 * Cut where the output stops carrying new content: the last line that said
 * something new, minus trailing lines that recur throughout.
 *
 * Correct for the clean-prefix shape — good text, then one line repeated —
 * but fragile by construction: "last novel line" is dragged to the very end
 * by a single late novel line. On a real 13,773-character page of 1,079
 * short lines it returned the whole output for exactly that reason.
 */
function cutAtLastNovelLine(lines: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const k = lineKey(l);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = new Set<string>();
  let lastNovel = -1;
  for (let i = 0; i < lines.length; i++) {
    const k = lineKey(lines[i]);
    if (!k) continue;
    if (!seen.has(k)) { seen.add(k); lastNovel = i; }
  }
  if (lastNovel < 0) return undefined;

  let cut = lastNovel;
  while (cut >= 0) {
    const k = lineKey(lines[cut]);
    if (k && (counts.get(k) ?? 0) >= REPEAT_IS_LOOPY) cut--;
    else break;
  }
  if (cut < 0) return undefined;
  return lines.slice(0, cut + 1).join('\n').trim();
}

/**
 * Cut where the RATE of new content collapses.
 *
 * This is the objective that survives interleaved repetition, which the
 * last-novel-line cut cannot see: a loop whose lines differ slightly (OCR
 * noise, varying amounts) looks novel line by line while being caught by the
 * gate's 24-character shingle check. The question that distinguishes them is
 * not "is this line new?" but "is this RUN still saying anything?".
 *
 * Finds the earliest index from which fewer than NOVELTY_FLOOR of the
 * remaining lines introduce anything, and keeps everything before it. Tails
 * shorter than LINE_MIN_COUNT are ignored: a density reading over two lines
 * is noise and would cut good text off the end for nothing.
 */
function cutAtNoveltyCollapse(lines: string[]): string | undefined {
  const n = lines.length;
  const firstOcc = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = lineKey(lines[i]);
    if (k && !firstOcc.has(k)) firstOcc.set(k, i);
  }
  // isFirst[i]: line i is the first appearance of its normalized form.
  const isFirst = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const k = lineKey(lines[i]);
    isFirst[i] = k && firstOcc.get(k) === i ? 1 : 0;
  }
  // suffixNovel[i] = novel lines in [i, n)
  const suffixNovel = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffixNovel[i] = suffixNovel[i + 1] + isFirst[i];

  for (let i = 0; i < n; i++) {
    const tail = n - i;
    if (tail < LINE_MIN_COUNT) break;
    if (suffixNovel[i] / tail < NOVELTY_FLOOR) {
      if (i === 0) return undefined;             // loop from the first line
      return lines.slice(0, i).join('\n').trim();
    }
  }
  return undefined;
}

/**
 * The good prefix of an output that degenerated into a repetition loop.
 *
 * Two strategies, and the SHORTER passing candidate wins. Running both rather
 * than replacing one with the other is deliberate: each is correct on a shape
 * the other misreads, and preferring the shorter one keeps the failure mode on
 * the side of dropping good text rather than keeping garbage. Whichever is
 * chosen is re-checked against the full gate, so salvage stays a use of the
 * gate and never a hole in it.
 */
export function salvageRepetitionLoop(
  text: string,
  task: OcrGateTask = 'ocr',
): { text: string } | { declined: string } {
  const lines = text.split('\n');
  if (lines.length < 2) return { declined: 'single-line output: no line boundary to cut on' };

  const candidates = [cutAtNoveltyCollapse(lines), cutAtLastNovelLine(lines)]
    .filter((c): c is string => !!c)
    .sort((a, b) => a.length - b.length);

  if (candidates.length === 0) {
    return { declined: `no cut point found (lines=${lines.length})` };
  }

  const tooShort: number[] = [];
  const residuals: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length < MIN_SALVAGE_CHARS) { tooShort.push(candidate.length); continue; }
    const residual = computeReasons(candidate, task);
    if (residual.length > 0) { residuals.push(`${candidate.length}ch:${residual.join('+')}`); continue; }
    return { text: candidate };
  }

  const detail = [
    tooShort.length ? `below the ${MIN_SALVAGE_CHARS}-char floor (${tooShort.join(', ')})` : null,
    residuals.length ? `still fails the gate (${residuals.join('; ')})` : null,
  ].filter(Boolean).join('; ');
  return { declined: `${detail} [lines=${lines.length}]` };
}

export function assessOcrOutput(
  text: string,
  opts: { task?: OcrGateTask } = {},
): OcrQualityAssessment {
  const task = opts.task ?? 'ocr';
  const reasons = computeReasons(text, task);
  if (reasons.length === 0) return { ok: true, reasons };

  // Salvage ONLY a pure repetition loop. A combined verdict (e.g.
  // 'repetition-loop' + 'unexpected-script', 88 real cases) means the output
  // was never trustworthy, so no prefix of it is either.
  if (reasons.length === 1 && reasons[0] === 'repetition-loop') {
    const outcome = salvageRepetitionLoop(text.trim(), task);
    if ('text' in outcome) return { ok: false, reasons, salvagedText: outcome.text };
    return { ok: false, reasons, salvageDeclined: outcome.declined };
  }

  return { ok: false, reasons };
}
