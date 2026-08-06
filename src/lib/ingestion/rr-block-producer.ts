/**
 * RR block producer — PLAN-rr-structure item 3.
 *
 * Builds DocparseBlocks for Reporter's Record pages from the SAME
 * reconstructRRLines() output that produces the page text (no second PDF
 * open). Structure here is metadata-only: pages produced by this module are
 * flagged structureOnly so the StructuredChunker never chunks from these
 * blocks (RR chunk text stays byte-identical to the legacy path).
 *
 * Grouping model (page → speaker-turn paragraph → line):
 * - Leading unnumbered lines (page number, cause caption) → one page_header.
 * - Trailing unnumbered lines → one page_footer.
 * - Numbered region: a new paragraph starts at each speaker-turn opener
 *   (THE COURT:, MR. …:, Q., A.). Lines before the first opener form a
 *   speaker-less paragraph (e.g. "PROCEEDINGS" headers, narrative).
 * - Blank numbered lines are KEPT as lines[] entries — the printed 1–25
 *   invariant depends on them.
 */

import type { DocparseBlock, DocparseBlockLine } from './docparse-types';
import type { RRLine } from './pdf-parser';

/** Colon-terminated speaker labels: THE COURT:, MR. SMITH:, MS. …:, JUDGE …: */
const SPEAKER_COLON_RE =
  /^(THE COURT REPORTER|THE COURT|THE WITNESS|THE BAILIFF|THE INTERPRETER|THE CLERK|MR\.|MS\.|MRS\.|DR\.|JUDGE)[^:]{0,40}:/;

/** Examination Q/A openers: "Q.  Did you…", "A.  Yes." (also bare "Q."). */
const QA_RE = /^([QA])\.(\s|$)/;

/**
 * Extract the speaker label from a turn-opening line, or null if the line
 * does not open a turn.
 */
export function extractSpeaker(text: string): string | null {
  const qa = QA_RE.exec(text);
  if (qa) return qa[1];
  const colon = SPEAKER_COLON_RE.exec(text);
  if (colon) return colon[0].slice(0, -1).trim();
  return null;
}

function toBlockLine(line: RRLine, pageHeight: number): DocparseBlockLine {
  const bbox: [number, number, number, number] | null =
    pageHeight > 0
      ? [line.x0, pageHeight - (line.y + line.height), line.x1, pageHeight - line.y]
      : null;
  return {
    ...(line.lineNumber !== null ? { lineNumber: line.lineNumber } : {}),
    text: line.text,
    bbox,
  };
}

function finishBlock(
  type: DocparseBlock['type'],
  lines: DocparseBlockLine[],
  order: number,
  speaker?: string
): DocparseBlock {
  const numbered = lines
    .map((l) => l.lineNumber)
    .filter((n): n is number => n !== undefined);
  const boxes = lines.map((l) => l.bbox).filter((b): b is [number, number, number, number] => b !== null);
  const bbox: [number, number, number, number] | null = boxes.length
    ? [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ]
    : null;
  return {
    type,
    text: lines.map((l) => l.text).filter((t) => t.length > 0).join('\n'),
    bbox,
    order,
    lines,
    ...(speaker !== undefined ? { speaker } : {}),
    ...(numbered.length ? { lineStart: Math.min(...numbered), lineEnd: Math.max(...numbered) } : {}),
  };
}

/**
 * Build structure blocks for one RR page. Pure — feeds off the same
 * reconstructRRLines() pass as the page text.
 *
 * @param rrLines - reconstructRRLines() output (top-to-bottom order)
 * @param pageHeight - page height in PDF points (bottom-left → top-left
 *   origin conversion); pass 0 when unknown → bboxes are null
 */
export function buildRRBlocks(rrLines: RRLine[], pageHeight: number): DocparseBlock[] {
  if (rrLines.length === 0) return [];

  // Split off leading/trailing unnumbered furniture around the numbered region.
  let firstNumbered = rrLines.findIndex((l) => l.lineNumber !== null);
  let lastNumbered = -1;
  for (let i = rrLines.length - 1; i >= 0; i--) {
    if (rrLines[i].lineNumber !== null) { lastNumbered = i; break; }
  }

  const blocks: DocparseBlock[] = [];
  let order = 0;

  if (firstNumbered === -1) {
    // No line-number column (caption / index / certificate pages) — the whole
    // page is furniture-ish; emit a single page_header so Meta View has
    // something to show without pretending it found speaker turns.
    blocks.push(finishBlock('page_header', rrLines.map((l) => toBlockLine(l, pageHeight)), order++));
    return blocks;
  }

  if (firstNumbered > 0) {
    blocks.push(
      finishBlock('page_header', rrLines.slice(0, firstNumbered).map((l) => toBlockLine(l, pageHeight)), order++)
    );
  }

  // Numbered region: segment into speaker turns.
  let current: DocparseBlockLine[] = [];
  let currentSpeaker: string | undefined;
  const flush = () => {
    if (current.length === 0) return;
    blocks.push(finishBlock('paragraph', current, order++, currentSpeaker));
    current = [];
    currentSpeaker = undefined;
  };

  for (let i = firstNumbered; i <= lastNumbered; i++) {
    const line = rrLines[i];
    const speaker = line.text.length > 0 ? extractSpeaker(line.text) : null;
    if (speaker !== null) {
      flush();
      currentSpeaker = speaker;
    }
    current.push(toBlockLine(line, pageHeight));
  }
  flush();

  if (lastNumbered < rrLines.length - 1) {
    blocks.push(
      finishBlock('page_footer', rrLines.slice(lastNumbered + 1).map((l) => toBlockLine(l, pageHeight)), order++)
    );
  }

  return blocks;
}
