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
  const leadCounts = new Map<number, number>();
  for (let j = 1; j < bodyLines.length; j++) {
    const d = Math.round(bodyLines[j - 1].y - bodyLines[j].y);
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
  const haveLead = bodyLines.length >= 3 && modalLead > 0;
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

  const paragraphBreak = (prev: Line, cur: Line): boolean => {
    const gap = prev.y - cur.y;
    if (haveLead) {
      if (gap > 1.4 * modalLead) return true;
    } else if (gap > PARA_GAP_FACTOR * Math.max(prev.fontSize, cur.fontSize)) {
      return true; // too few lines for a stable leading mode — legacy rule
    }
    return (
      Math.abs(cur.x0 - prev.x0) >= INDENT_MIN &&
      prev.x1 < maxX1 - RAGGED_MIN &&
      inCluster(cur.x0) &&
      inCluster(prev.x0) &&
      !isCentered(cur)
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
        (isBoldFont(first.items[0]?.fontName) && first.text.length <= 80) ||
        (para.length === 1 && isNumberedHeadingLine(first, page)));
    blocks.push({
      type: isHeading ? 'heading' : 'paragraph',
      text: para.map(l => l.text).join('\n'),
      bbox: lineBBox(para, page),
      order: order++,
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
        isBoldFont(lines[i].items[0]?.fontName) ||
        isNumberedHeadingLine(lines[i], page));

    // Wrapped-heading continuation (observed on a real motion: heading line
    // ends "…cannot yield" and the wrap "fair value." sits at NORMAL body
    // leading, so geometry cannot distinguish it). Merge the immediately
    // following line into the just-emitted heading ONLY when it starts
    // lowercase — a sentence can't start lowercase, so it must be a wrap.
    // ("heading lacks terminal punctuation" was tried and rejected: all-caps
    // headings legitimately end unpunctuated and it cascaded body lines in.)
    if (pendingHeading && pendingHeadingLine && !headingLike) {
      const gap = pendingHeadingLine.y - lines[i].y;
      const gapOk = haveLead ? gap <= 1.4 * modalLead : gap <= PARA_GAP_FACTOR * lines[i].fontSize;
      const startsLower = /^[a-z]/.test(lines[i].text);
      const combined = `${pendingHeading.text} ${lines[i].text}`.trim();
      if (gapOk && startsLower && combined.length <= 200) {
        pendingHeading.text = combined;
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
      if (paragraphBreak(prev, lines[i]) || sizeJump) {
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
      const items: PositionedItem[] = content.items.map((it: any) => ({
        str: it.str ?? '',
        x: it.transform?.[4] ?? 0,
        y: it.transform?.[5] ?? 0,
        width: it.width ?? 0,
        height: it.height ?? Math.hypot(it.transform?.[2] ?? 0, it.transform?.[3] ?? 0) ?? 10,
        fontName: it.fontName,
      }));
      const blocks = buildBlocks(items, { width: viewport.width, height: viewport.height });
      results.push({ pageNumber, blocks, producer: 'pdf' });
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
