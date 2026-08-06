/**
 * PdfBlockExtractor — structure from the PDF text layer, zero GPU.
 * PLAN-ss-docparse §0.1 step 2a: the born-digital block producer.
 *
 * Reads pdfjs `getTextContent()` WITH positions (the exact information the
 * flat extraction path discards — §3.1) and derives: reading order, heading
 * detection (font size/weight, not regex guesses), paragraph grouping,
 * page furniture (geometry + identifier capture), and table CANDIDATE
 * regions via column-alignment clustering. Table candidates carry only a
 * bbox + plain text here; the escalation orchestrator (step 3) crops the
 * region and asks ss-ocr `Table Recognition:` for structure.
 *
 * The geometry core is PURE (operates on PositionedItem[]) so it is fully
 * testable without pdfjs or a PDF file.
 *
 * Transcript guard: callers MUST NOT run this on Reporter's-Record pages
 * (line-numbered 1–25) — route them through the existing line-aware path
 * (§6.1). `looksLikeTranscriptPage()` is exported for that check, and
 * detectTableRegions is suppressed when it fires regardless.
 */

import { createLogger } from '../logger';
import type { DocparseBlock, DocparsePageResult } from './docparse-types';

const logger = createLogger('PdfBlockExtractor');

// ---------------------------------------------------------------------------
// Pure geometry core
// ---------------------------------------------------------------------------

/** A positioned text run, page coords in PDF points, origin BOTTOM-left
 * (pdfjs convention). The extractor converts to top-left in block bboxes. */
export interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number; // ≈ font size
  fontName?: string;
}

export interface PageGeometry {
  width: number;
  height: number;
}

interface Line {
  items: PositionedItem[];
  y: number;        // representative baseline y (bottom-left origin)
  x0: number;
  x1: number;
  fontSize: number; // max item height on the line
  text: string;
}

const Y_TOLERANCE = 2;           // same-line grouping (pt) — mirrors reconstructRRPageText
const FURNITURE_BAND = 0.07;     // top/bottom 7% of page height
const HEADING_SIZE_RATIO = 1.15; // ≥15% larger than modal body size
const HEADING_MAX_CHARS = 120;
const PARA_GAP_FACTOR = 1.8;     // vertical gap > 1.8× line height ⇒ new block
const TABULAR_MIN_SEGMENTS = 3;  // runs per line separated by big gaps
const TABULAR_GAP_FACTOR = 2.5;  // gap > 2.5× median intra-line gap
const TABLE_MIN_LINES = 3;       // consecutive tabular lines to form a region
const COLUMN_X_TOLERANCE = 4;    // pt — x-start clustering tolerance

const BATES_RE = /\b([A-Z]{2,8}[-_ ]?\d{4,8})\b/;
const FILESTAMP_RE = /\b(?:filed|e-filed|received)\b[:\s]*([0-9/:\sAPMapm-]{6,30})/i;

/** Group positioned items into visual lines (y-bucketing, x-sorted). */
export function groupIntoLines(items: PositionedItem[]): Line[] {
  const usable = items.filter(i => i.str.trim().length > 0);
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const item of sorted) {
    const line = lines.find(l => Math.abs(l.y - item.y) <= Y_TOLERANCE);
    if (line) {
      line.items.push(item);
    } else {
      lines.push({ items: [item], y: item.y, x0: 0, x1: 0, fontSize: 0, text: '' });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.x0 = line.items[0].x;
    const last = line.items[line.items.length - 1];
    line.x1 = last.x + last.width;
    line.fontSize = Math.max(...line.items.map(i => i.height));
    line.text = joinLineText(line.items);
  }
  return lines; // already top-to-bottom (y desc)
}

/** Join items into text, inserting a space when the x-gap implies one. */
function joinLineText(items: PositionedItem[]): string {
  let out = '';
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      const prev = items[i - 1];
      const gap = items[i].x - (prev.x + prev.width);
      const spaceWidth = Math.max(1.5, prev.height * 0.25);
      if (gap > spaceWidth) out += ' ';
    }
    out += items[i].str;
  }
  return out.trim();
}

/** Modal (most common) font size across lines — the body-text size. */
export function modalFontSize(lines: Line[]): number {
  const counts = new Map<number, number>();
  for (const l of lines) {
    const size = Math.round(l.fontSize * 2) / 2; // 0.5pt buckets
    counts.set(size, (counts.get(size) ?? 0) + l.text.length);
  }
  let best = 0, bestCount = -1;
  for (const [size, count] of counts) {
    if (count > bestCount) { best = size; bestCount = count; }
  }
  return best || 12;
}

function isBoldFont(fontName?: string): boolean {
  return !!fontName && /bold|black|heavy|demi/i.test(fontName);
}

/** "I." / "II." / "A." / "1." / "1.2." enumerator at line start. */
const NUMBERED_HEADING_RE = /^(?:[IVXLCDM]{1,7}\.|[A-Z]\.|\d{1,2}(?:\.\d{1,2})*\.)\s+\S/;

/**
 * Numbered-heading signal (added after observing real filings: pleading
 * headings like "I. NATURE OF THE EMERGENCY" are often body-sized and not
 * bold, so the font heuristics miss them). The enumerator alone is NOT
 * sufficient — numbered body lists ("1. Set this motion for hearing…")
 * share the shape. Discriminators: the text is uppercase-dominant, or the
 * line is horizontally centered on the page.
 */
export function isNumberedHeadingLine(
  line: { text: string; x0: number; x1: number },
  page: PageGeometry,
): boolean {
  const t = line.text.trim();
  if (t.length > HEADING_MAX_CHARS || !NUMBERED_HEADING_RE.test(t)) return false;
  const letters = t.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 4) {
    const upper = letters.replace(/[^A-Z]/g, '').length;
    if (upper / letters.length >= 0.8) return true;
  }
  // centered: line midpoint within 8% of page midpoint AND clearly indented
  const mid = (line.x0 + line.x1) / 2;
  const centered = Math.abs(mid - page.width / 2) <= page.width * 0.08 && line.x0 > page.width * 0.15;
  return centered && t.length <= 80;
}

/** Reporter's-Record page signature: a margin column of line numbers 1–25.
 * Table detection must be suppressed on these pages (§6.1). */
export function looksLikeTranscriptPage(lines: Line[]): boolean {
  const marginNumbers = lines.filter(l => {
    const first = l.items[0];
    return first && /^\d{1,2}$/.test(first.str.trim()) && parseInt(first.str, 10) <= 25;
  });
  return marginNumbers.length >= 15;
}

/** Detect tabular lines and cluster consecutive runs into table regions.
 * Returns line-index ranges [start, end] (inclusive). */
export function detectTableRegions(lines: Line[]): Array<{ start: number; end: number }> {
  if (lines.length === 0) return [];
  // Space-width proxy: median of SMALL intra-line gaps (≤ 2× font size —
  // the word-space population). pdfjs often emits whole phrases as single
  // runs, so the gap population can be empty or dominated by columnar
  // gaps; fall back to a font-size-derived estimate rather than letting
  // column gaps inflate the proxy and mask themselves.
  const smallGaps: number[] = [];
  for (const l of lines) {
    for (let i = 1; i < l.items.length; i++) {
      const g = l.items[i].x - (l.items[i - 1].x + l.items[i - 1].width);
      if (g > 0 && g <= 2 * l.fontSize) smallGaps.push(g);
    }
  }
  const bodySize = modalFontSize(lines);
  smallGaps.sort((a, b) => a - b);
  const spaceProxy = smallGaps.length > 0
    ? Math.max(1.5, smallGaps[Math.floor(smallGaps.length / 2)])
    : Math.max(2, bodySize * 0.3);
  const segmentThreshold = Math.max(TABULAR_GAP_FACTOR * spaceProxy, 6);

  const segmentStarts = (l: Line): number[] => {
    const starts = [l.items[0].x];
    for (let i = 1; i < l.items.length; i++) {
      const g = l.items[i].x - (l.items[i - 1].x + l.items[i - 1].width);
      if (g > segmentThreshold) starts.push(l.items[i].x);
    }
    return starts;
  };

  const tabular = lines.map(l => {
    const starts = segmentStarts(l);
    return starts.length >= TABULAR_MIN_SEGMENTS ? starts : null;
  });

  const regions: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const len = endIdx - runStart + 1;
    if (len >= TABLE_MIN_LINES && sharesColumns(tabular.slice(runStart, endIdx + 1) as number[][])) {
      regions.push({ start: runStart, end: endIdx });
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (tabular[i]) {
      if (runStart < 0) runStart = i;
    } else {
      flush(i - 1);
    }
  }
  flush(lines.length - 1);
  return regions;
}

/** ≥70% of lines share ≥3 x-start columns (within tolerance). */
function sharesColumns(startsPerLine: number[][]): boolean {
  if (startsPerLine.length < TABLE_MIN_LINES) return false;
  const clusters: Array<{ x: number; count: number }> = [];
  for (const starts of startsPerLine) {
    for (const x of starts) {
      const c = clusters.find(cl => Math.abs(cl.x - x) <= COLUMN_X_TOLERANCE);
      if (c) { c.count++; c.x = (c.x + x) / 2; }
      else clusters.push({ x, count: 1 });
    }
  }
  const threshold = Math.ceil(startsPerLine.length * 0.7);
  return clusters.filter(c => c.count >= threshold).length >= TABULAR_MIN_SEGMENTS;
}

function lineBBox(ls: Line[], page: PageGeometry): [number, number, number, number] {
  const x0 = Math.min(...ls.map(l => l.x0));
  const x1 = Math.max(...ls.map(l => l.x1));
  const yTopPdf = Math.max(...ls.map(l => l.y + l.fontSize));
  const yBotPdf = Math.min(...ls.map(l => l.y));
  // convert to TOP-left origin
  return [x0, page.height - yTopPdf, x1, page.height - yBotPdf];
}

function extractIdentifiers(text: string): DocparseBlock['identifiers'] {
  const bates = BATES_RE.exec(text)?.[1];
  const stamp = FILESTAMP_RE.exec(text)?.[1]?.trim();
  if (!bates && !stamp) return undefined;
  return { ...(bates ? { batesNumber: bates } : {}), ...(stamp ? { fileStamp: stamp } : {}) };
}

/**
 * Pure block builder over positioned items. Exported for tests.
 */
export function buildBlocks(items: PositionedItem[], page: PageGeometry): DocparseBlock[] {
  const lines = groupIntoLines(items);
  if (lines.length === 0) return [];
  const bodySize = modalFontSize(lines);
  const isTranscript = looksLikeTranscriptPage(lines);

  // §6.1 FULL transcript carve-out: Reporter's-Record pages produce NO
  // blocks at all, so the StructuredChunker delegates them to the legacy
  // line-aware path and chunk text stays byte-identical — preserving
  // startLine/endLine stamping (detectLineNumbers over chunk text at
  // ingestion) and the MCP citation fallback that re-reads margin numbers
  // from stored text. Structural chunking would re-assemble that text and
  // silently break "Vol 3, page 105, lines 4-17" citations.
  if (isTranscript) return [];

  // 1. classify furniture by geometry
  const topBand = page.height * (1 - FURNITURE_BAND);
  const bottomBand = page.height * FURNITURE_BAND;
  const kind = lines.map<'header' | 'footer' | 'body'>(l =>
    l.y >= topBand ? 'header' : l.y <= bottomBand ? 'footer' : 'body');

  // 2. table regions on body lines only (indices refer to `lines`)
  const regions = isTranscript ? [] : detectTableRegions(lines);
  const inRegion = new Array(lines.length).fill(-1);
  regions.forEach((r, ri) => {
    for (let i = r.start; i <= r.end; i++) if (kind[i] === 'body') inRegion[i] = ri;
  });

  // ── Paragraph-split signals (measured on real double-spaced pleadings,
  // debug 2026-08-06): body leading is ~32pt at 14pt type, so any font-size-
  // based gap threshold splits EVERY line. Split on gap > 1.4 × the page's
  // MODAL LEADING instead (1.4 not 1.5 — a real signature block sat at
  // exactly 1.5× and must split), plus a symmetric first-line-indent signal
  // (|Δx0| ≥ indent, previous line ragged-right, both x0 in left-alignment
  // clusters, new line not centered) for paragraph breaks without extra
  // leading. Centered caption pages are protected by the cluster gate.
  const bodyLines = lines.filter((_, i) => kind[i] === 'body');
  const INDENT_MIN = Math.max(12, bodySize * 1.2);
  const RAGGED_MIN = bodySize * 1.5;
  const maxX1 = bodyLines.length ? Math.max(...bodyLines.map(l => l.x1)) : page.width;
  // left-alignment clusters: x0 values shared by ≥2 body lines (±4pt)
  const clusters: Array<{ x: number; count: number }> = [];
  for (const l of bodyLines) {
    const c = clusters.find(cl => Math.abs(cl.x - l.x0) <= 4);
    if (c) { c.count++; } else clusters.push({ x: l.x0, count: 1 });
  }
  const leftClusters = clusters.filter(c => c.count >= 2).map(c => c.x);
  const inCluster = (x: number) => leftClusters.some(c => Math.abs(c - x) <= 4);
  // Truly centered = midpoint near page center AND BOTH edges inset — a
  // full-width line with only a first-line indent shifts its midpoint near
  // center too, and must not be mistaken for centered (it is exactly the
  // paragraph-start shape the indent clause exists to catch).
  const isCentered = (l: Line) =>
    Math.abs((l.x0 + l.x1) / 2 - page.width / 2) <= page.width * 0.08 &&
    l.x0 > page.width * 0.15 &&
    l.x1 < maxX1 - RAGGED_MIN;

  // Caption grids (court name, party names, cause number) are RUNS of
  // centered lines — a narrow-centered line whose neighbor is also centered
  // is caption content and must never become a heading, even when bold
  // (measured: this filing's caption lines ARE bold). A STANDALONE centered
  // line between non-centered neighbors is a section title ("UNSWORN
  // DECLARATION", "CERTIFICATE OF SERVICE").
  const inCenteredRun = (l: Line): boolean => {
    if (!(isCentered(l) && l.x1 - l.x0 < page.width * 0.5)) return false;
    const idx = lines.indexOf(l);
    return (idx > 0 && isCentered(lines[idx - 1])) ||
      (idx >= 0 && idx + 1 < lines.length && isCentered(lines[idx + 1]));
  };

  // Whole-line bold heading signal. Requires REAL font names — the pdfjs
  // wrapper resolves opaque g_d0_fN ids via getOperatorList/commonObjs
  // (Word-exported filings keep headings bold at body size; measured: the
  // title, every section heading incl. wrapped lines, and the certificate
  // titles are TimesNewRomanPS-BoldMT while body text is regular). Whole
  // line, not first item: a body line OPENING with bold emphasis is prose.
  // Right-half runs (e-file stamp, signature offsets) are excluded.
  const isBoldHeadingLine = (l: Line): boolean =>
    l.items.length > 0 &&
    l.items.every(it => isBoldFont(it.fontName)) &&
    l.x0 < page.width * 0.5 &&
    !inCenteredRun(l);

  // ALL-CAPS heading signal (real page 1: the document title "APPELLANT'S
  // EMERGENCY MOTION …" is body-sized, in an opaque font pdfjs reports as
  // g_d0_fN — the bold heuristic can't see it — and nearly full-width, so
  // neither the centered nor the enumerator signal fires; it merged into the
  // body paragraph). Discriminators: caps-dominant with enough letters,
  // UNTERMINATED (the caps salutation "TO THE HONORABLE … :" ends with
  // punctuation), and NOT centered (centered caps caption lines — court
  // name, party names — must stay caption paragraphs).
  const isCapsHeadingLine = (l: Line): boolean => {
    const t = l.text.trim();
    if (t.length > 80 || /[.!?:;,]$/.test(t)) return false;
    const letters = t.replace(/[^a-zA-Z]/g, '');
    if (letters.length < 8) return false;
    if (letters.replace(/[^A-Z]/g, '').length / letters.length < 0.8) return false;
    // Right-aligned caps runs (e-file stamp clerk lines at x≈544+) are
    // furniture, not headings.
    if (l.x0 >= page.width * 0.5) return false;
    // Caption runs excluded; standalone centered caps titles ("UNSWORN
    // DECLARATION" — page-20 defect) and near-full-width titles pass.
    return !inCenteredRun(l);
  };

  // Leading statistics come from NON-CENTERED body lines when enough exist:
  // a centered court caption is single-spaced (measured 16pt at 14pt type on
  // page 1 of a real motion) while the prose below is double-spaced (32pt);
  // with the caption included the two leads TIED 8-vs-8 and the tie-break
  // picked 16pt, shattering every body paragraph into one-line blocks.
  // Centered lines are never paragraph prose, so they don't get a vote —
  // unless fewer than 3 non-centered lines remain (mostly-centered pages),
  // where all body lines vote rather than falling back to the legacy
  // font-size rule that re-shatters double-spaced text.
  const nonCentered = bodyLines.filter(l => !isCentered(l));
  const leadLines = nonCentered.length >= 3 ? nonCentered : bodyLines;
  const leadCounts = new Map<number, number>();
  for (let j = 1; j < leadLines.length; j++) {
    const d = Math.round(leadLines[j - 1].y - leadLines[j].y);
    if (d > 0 && d < 200) leadCounts.set(d, (leadCounts.get(d) ?? 0) + 1);
  }
  let modalLead = 0;
  let modalCount = 0;
  for (const [lead, count] of leadCounts) {
    if (count > modalCount || (count === modalCount && lead < modalLead)) {
      modalLead = lead;
      modalCount = count;
    }
  }
  const haveLead = leadLines.length >= 3 && modalLead > 0;

  // Body left margin = the most frequent x0 among NON-CENTERED body lines —
  // tesseract's block-level "body indent" tab stop (paragraphs.cpp,
  // CalculateTabStops). Centered lines excluded: on caption-heavy pages a
  // centered-x0 collision can otherwise outvote the real margin.
  const marginClusters: Array<{ x: number; count: number }> = [];
  for (const l of nonCentered) {
    const c = marginClusters.find(cl => Math.abs(cl.x - l.x0) <= 4);
    if (c) c.count++; else marginClusters.push({ x: l.x0, count: 1 });
  }
  const bodyMargin = marginClusters.reduce<{ x: number; count: number } | null>(
    (best, c) => (!best || c.count > best.count ? c : best), null)?.x
    ?? (bodyLines.length ? Math.min(...bodyLines.map(l => l.x0)) : 0);
  const nearMargin = (x: number) => Math.abs(x - bodyMargin) <= 4;
  // A first-line indent is a TAB (0.5–0.75in), never a block-quote inset
  // (~72pt) or a signature-block offset (~234pt).
  const INDENT_MAX = Math.max(48, bodySize * 3.5);

  // Singleton first-line indent (Opus research memo, task #9). The ≥2-member
  // cluster gate below cannot see a paragraph opener that is the ONLY
  // indented line on its page (measured: a double-spaced motion page where 19
  // lines merged into one paragraph because the single x0=108 opener had no
  // cluster peer). Tesseract admits exactly this case: a line whose left tab
  // stop is infrequent survives when its OTHER edge sits on a frequent stop.
  // Conjuncts: indent measured from the dominant body margin (not the
  // previous line) and bounded above; prev starts AT that margin (stops the
  // rule inside block quotes / indented lists) and is ragged; the opener is
  // edge-corroborated (next line returns to margin, or opener runs to the
  // right edge); prev ends an idea and cur starts one (TextSupportsBreak).
  const firstLineIndent = (prev: Line, cur: Line, next?: Line): boolean => {
    const dx = cur.x0 - bodyMargin;
    if (dx < INDENT_MIN || dx > INDENT_MAX) return false;
    if (!nearMargin(prev.x0)) return false;
    if (prev.x1 >= maxX1 - RAGGED_MIN) return false; // prev not ragged
    if (isCentered(cur)) return false;
    const anchored =
      (next !== undefined && nearMargin(next.x0)) ||
      cur.x1 >= maxX1 - RAGGED_MIN;
    if (!anchored) return false;
    // \p{Lu}: Turkish-language exhibits open paragraphs with Ü/İ/Ş — an
    // ASCII [A-Z] cue silently disabled the rule for the whole document.
    return /[.!?:;"'’”)\]]$/.test(prev.text.trim()) &&
           /^["'“(\[]?[\p{Lu}0-9]/u.test(cur.text.trim());
  };

  const paragraphBreak = (prev: Line, cur: Line, next?: Line): boolean => {
    const gap = prev.y - cur.y;
    if (haveLead) {
      if (gap > 1.4 * modalLead) return true;
    } else if (gap > PARA_GAP_FACTOR * Math.max(prev.fontSize, cur.fontSize)) {
      return true; // too few lines for a stable leading mode — legacy rule
    }
    return (
      (Math.abs(cur.x0 - prev.x0) >= INDENT_MIN &&
        prev.x1 < maxX1 - RAGGED_MIN &&
        inCluster(cur.x0) &&
        inCluster(prev.x0) &&
        !isCentered(cur)) ||
      firstLineIndent(prev, cur, next)
    );
  };

  const blocks: DocparseBlock[] = [];
  let order = 0;

  const pushFurniture = (idx: number) => {
    const l = lines[idx];
    const type = /^\s*(?:page\s+)?[-–—\d\s of]+$/i.test(l.text) && l.text.replace(/\D/g, '').length > 0
      ? 'page_number' as const
      : kind[idx] === 'header' ? 'page_header' as const : 'page_footer' as const;
    blocks.push({
      type,
      text: l.text,
      bbox: lineBBox([l], page),
      order: order++,
      identifiers: extractIdentifiers(l.text),
    });
  };

  // 3. walk lines top-to-bottom, grouping into blocks
  let para: Line[] = [];
  let currentRegion = -1;
  let regionLines: Line[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const first = para[0];
    const isHeading =
      para.length <= 2 &&
      first.text.length <= HEADING_MAX_CHARS &&
      (first.fontSize >= bodySize * HEADING_SIZE_RATIO ||
        (isBoldHeadingLine(first) && first.text.length <= 80) ||
        (para.length === 1 && (isNumberedHeadingLine(first, page) || isCapsHeadingLine(first))));
    blocks.push({
      type: isHeading ? 'heading' : 'paragraph',
      text: para.map(l => l.text).join('\n'),
      bbox: lineBBox(para, page),
      order: order++,
      // page → paragraph → line hierarchy (PLAN-rr-structure item 4 for the
      // born-digital side): unnumbered lines with per-line bboxes, same
      // convention as the RR producer's numbered lines.
      lines: para.map(l => ({ text: l.text, bbox: lineBBox([l], page) })),
    });
    para = [];
  };
  const flushRegion = () => {
    if (regionLines.length === 0) return;
    blocks.push({
      type: 'table',
      text: regionLines.map(l => l.text).join('\n'),
      bbox: lineBBox(regionLines, page),
      order: order++,
      lines: regionLines.map(l => ({ text: l.text, bbox: lineBBox([l], page) })),
    });
    regionLines = [];
    currentRegion = -1;
  };

  // Multi-line heading merge state: the heading block just emitted and the
  // line it came from, so a wrapped continuation can be folded in.
  let pendingHeading: DocparseBlock | null = null;
  let pendingHeadingLine: Line | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (kind[i] !== 'body') {
      // furniture does not break a paragraph run mid-page, but top/bottom
      // bands only ever occur before/after body content in practice
      flushPara(); flushRegion();
      pendingHeading = null;
      pushFurniture(i);
      continue;
    }
    if (inRegion[i] >= 0) {
      flushPara();
      pendingHeading = null;
      if (currentRegion !== inRegion[i]) flushRegion();
      currentRegion = inRegion[i];
      regionLines.push(lines[i]);
      continue;
    }
    flushRegion();
    // A heading-like line FORCES a paragraph break before it is appended —
    // on uniformly double-spaced pages no gap exceeds 1.4×leading, so
    // without this the heading gets absorbed mid-paragraph (regression
    // observed on a real motion page the same day the leading rule landed).
    const headingLike =
      lines[i].text.length <= HEADING_MAX_CHARS &&
      (lines[i].fontSize >= bodySize * HEADING_SIZE_RATIO ||
        isBoldHeadingLine(lines[i]) ||
        isNumberedHeadingLine(lines[i], page) ||
        isCapsHeadingLine(lines[i]));

    // Wrapped-heading continuation (observed on a real motion: heading line
    // ends "…cannot yield" and the wrap "fair value." sits at NORMAL body
    // leading, so geometry cannot distinguish it). Merge the immediately
    // following line into the just-emitted heading ONLY when it starts
    // lowercase — a sentence can't start lowercase, so it must be a wrap.
    // ("heading lacks terminal punctuation" was tried and rejected: all-caps
    // headings legitimately end unpunctuated and it cascaded body lines in.)
    // capsWrap continuations are allowed to merge even when the wrap line is
    // itself headingLike-by-caps (a two-line ALL-CAPS title makes BOTH lines
    // caps-heading-like; without this they'd emit as two heading blocks) —
    // but never when the line is heading-like by SIZE (genuinely new heading).
    const sizeLike = lines[i].fontSize >= bodySize * HEADING_SIZE_RATIO;
    if (pendingHeading && pendingHeadingLine) {
      const gap = pendingHeadingLine.y - lines[i].y;
      const gapOk = haveLead ? gap <= 1.4 * modalLead : gap <= PARA_GAP_FACTOR * lines[i].fontSize;
      // NOT gated on headingLike: a lowercase BOLD wrap line ("fair value."
      // finishing a bold heading) is headingLike-by-bold yet must merge; only
      // a size-jump marks a genuinely new heading.
      const startsLower = !sizeLike && /^[a-z]/.test(lines[i].text);
      // ALL-CAPS wrap of an ALL-CAPS heading ("…AND THE FOREIGN" ↵
      // "RETALIATION"): tightly gated — short, caps-only, no enumerator,
      // heading itself caps-dominant and unterminated. Body sentences and
      // the next section heading (numbered ⇒ headingLike) can't match.
      const capsWrap =
        !sizeLike &&
        /^[A-Z][A-Z\s,'&-]{0,79}$/.test(lines[i].text.trim()) &&
        !NUMBERED_HEADING_RE.test(lines[i].text.trim()) &&
        !/[.!?:]$/.test(pendingHeading.text.trim()) &&
        (() => {
          const letters = pendingHeading.text.replace(/[^a-zA-Z]/g, '');
          return letters.length > 0 && letters.replace(/[^A-Z]/g, '').length / letters.length >= 0.8;
        })();
      const combined = `${pendingHeading.text} ${lines[i].text}`.trim();
      if (gapOk && (startsLower || capsWrap) && combined.length <= 200) {
        pendingHeading.text = combined;
        pendingHeading.lines?.push({ text: lines[i].text, bbox: lineBBox([lines[i]], page) });
        if (pendingHeading.bbox) {
          const lb = lineBBox([lines[i]], page);
          pendingHeading.bbox = [
            Math.min(pendingHeading.bbox[0], lb[0]),
            Math.min(pendingHeading.bbox[1], lb[1]),
            Math.max(pendingHeading.bbox[2], lb[2]),
            Math.max(pendingHeading.bbox[3], lb[3]),
          ];
        }
        pendingHeadingLine = lines[i]; // allow one more wrap line
        continue;
      }
      pendingHeading = null;
      pendingHeadingLine = null;
    }

    if (headingLike) {
      flushPara();
    } else if (para.length > 0) {
      // paragraph continuation vs break: modal-leading gap + indent signal
      // (measured rule), plus the size-jump guard (rarely fires, kept as a
      // heading-adjacency backstop)
      const prev = para[para.length - 1];
      const sizeJump = Math.abs(lines[i].fontSize - prev.fontSize) > bodySize * 0.2;
      // kind-guard on next: a footer line's x0 must not suppress a legitimate
      // break by failing the return-to-margin anchor.
      const next = i + 1 < lines.length && kind[i + 1] === 'body' ? lines[i + 1] : undefined;
      if (paragraphBreak(prev, lines[i], next) || sizeJump) {
        flushPara();
      }
    }
    para.push(lines[i]);
    // headings are short — flush immediately so the next line starts a body block
    if (para.length === 1 && headingLike) {
      flushPara();
      pendingHeading = blocks[blocks.length - 1]?.type === 'heading' ? blocks[blocks.length - 1] : null;
      pendingHeadingLine = pendingHeading ? lines[i] : null;
    } else if (!headingLike) {
      pendingHeading = null;
      pendingHeadingLine = null;
    }
  }
  flushPara();
  flushRegion();

  return blocks;
}

// ---------------------------------------------------------------------------
// Embedded-image detection (task #2: figure blocks)
// ---------------------------------------------------------------------------

/** Minimal op ids we track — matches pdfjs OPS values passed in by the
 * wrapper so the core stays pure/testable. */
export interface ImageOps {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
}

/**
 * Recover image placement rects from a pdfjs operator list by tracking the
 * CTM (save/restore/transform). pdfjs paints images into the unit square
 * transformed by the CTM, so the rect is the CTM image of [0,1]².
 * Returns TOP-left-origin rects in PDF points. Images smaller than `minPt`
 * in either dimension (rules, bullets, logos) are dropped.
 */
export function computeImageRects(
  fnArray: number[],
  argsArray: any[],
  ops: ImageOps,
  pageHeight: number,
  minPt = 24,
): Array<[number, number, number, number]> {
  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const mul = (m: number[], n: number[]): number[] => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const rects: Array<[number, number, number, number]> = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === ops.save) stack.push(ctm.slice());
    else if (fn === ops.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.transform) ctm = mul(ctm, argsArray[i] as number[]);
    else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject || fn === ops.paintImageMaskXObject) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
        ctm[0] * x + ctm[2] * y + ctm[4],
        ctm[1] * x + ctm[3] * y + ctm[5],
      ]);
      const xs = corners.map(c => c[0]);
      const ys = corners.map(c => c[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const h = Math.max(...ys) - Math.min(...ys);
      if (w < minPt || h < minPt) continue;
      rects.push([
        Math.min(...xs),
        pageHeight - Math.max(...ys),
        Math.max(...xs),
        pageHeight - Math.min(...ys),
      ]);
    }
  }
  return rects;
}

// ---------------------------------------------------------------------------
// pdfjs wrapper
// ---------------------------------------------------------------------------

let _pdfjs: any = null;
async function getPdfjs() {
  if (_pdfjs) return _pdfjs;
  if (typeof (globalThis as any).DOMMatrix === 'undefined') {
    // text-content only — the minimal polyfill is sufficient here (rendering
    // is pdf-page-renderer's problem, and it force-installs the real one)
    (globalThis as any).DOMMatrix = class {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      multiplySelf() { return this; }
      inverse() { return new (this.constructor as any)(); }
      static fromMatrix() { return new (this as any)(); }
    };
  }
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  _pdfjs.GlobalWorkerOptions.workerPort = null;
  return _pdfjs;
}

/**
 * Extract structured blocks for the given pages of a born-digital PDF.
 * Pages without a usable text layer yield an empty block list — the caller
 * routes those through the OCR producer instead.
 */
export async function extractPageBlocks(
  filePath: string,
  pageNumbers: number[],
): Promise<DocparsePageResult[]> {
  const pdfjs = await getPdfjs();
  const fs = await import('fs/promises');
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await pdfjs.getDocument({ data }).promise;
  const results: DocparsePageResult[] = [];
  try {
    for (const pageNumber of pageNumbers) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      // Resolve opaque font ids (g_d0_fN) to REAL font names
      // (TimesNewRomanPS-BoldMT) so isBoldFont sees boldness — Word-exported
      // filings keep headings bold at body size and the ids alone are
      // useless. getOperatorList populates page.commonObjs with the font
      // objects; on failure the opaque ids pass through unchanged.
      const fontCache = new Map<string, string>();
      let opList: { fnArray: number[]; argsArray: any[] } | null = null;
      try {
        opList = await page.getOperatorList();
        for (const it of content.items as any[]) {
          if (!it.fontName || fontCache.has(it.fontName)) continue;
          try {
            fontCache.set(it.fontName, page.commonObjs.get(it.fontName)?.name ?? it.fontName);
          } catch {
            fontCache.set(it.fontName, it.fontName);
          }
        }
      } catch { /* opaque names still work for everything except bold */ }
      const items: PositionedItem[] = content.items.map((it: any) => ({
        str: it.str ?? '',
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
        width: it.width ?? 0,
        height: it.height ?? Math.hypot(it.transform?.[2] ?? 0, it.transform?.[3] ?? 0) ?? 10,
        fontName: fontCache.get(it.fontName) ?? it.fontName,
      }));
      const blocks = buildBlocks(items, { width: viewport.width, height: viewport.height });
      // Figure blocks for embedded images (task #2) — appended after the
      // text blocks; the operator list is already paid for by the font
      // resolution above. Skipped entirely on transcript pages (zero-block
      // carve-out must stay zero-block).
      if (opList && blocks.length > 0) {
        try {
          for (const rect of computeImageRects(opList.fnArray, opList.argsArray, {
            save: pdfjs.OPS.save,
            restore: pdfjs.OPS.restore,
            transform: pdfjs.OPS.transform,
            paintImageXObject: pdfjs.OPS.paintImageXObject,
            paintInlineImageXObject: pdfjs.OPS.paintInlineImageXObject,
            paintImageMaskXObject: pdfjs.OPS.paintImageMaskXObject,
          }, viewport.height)) {
            blocks.push({ type: 'figure', text: '', bbox: rect, order: blocks.length });
          }
        } catch { /* figures are best-effort */ }
      }
      results.push({ pageNumber, blocks, producer: 'pdf', width: viewport.width, height: viewport.height });
      page.cleanup();
    }
  } finally {
    try { await doc.destroy(); } catch { /* pool-less one-shot document */ }
  }
  logger.info('Extracted structured blocks', {
    filePath: filePath.split('/').pop(),
    pages: results.length,
    blocks: results.reduce((n, r) => n + r.blocks.length, 0),
    tables: results.reduce((n, r) => n + r.blocks.filter(b => b.type === 'table').length, 0),
  });
  return results;
}
