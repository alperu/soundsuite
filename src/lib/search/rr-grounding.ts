/**
 * RR transcript grounding (task #13 phase 1d) — the PageCache sidecar.
 *
 * Every retrieved chunk carries documentId + pageNumber, and
 * PageCache.structuredJson is keyed on exactly that pair, so a claim cited
 * to a transcript page:line range can be verified DETERMINISTICALLY against
 * the printed lines — no model call. This catches the failure legal users
 * care most about: a fabricated or drifted transcript quote.
 */

import { prisma } from '../db/prisma';

export interface RRPageLine {
  lineNumber: number;
  text: string;
  speaker?: string;
}

/**
 * Printed lines (1–25) for one RR page from the persisted structure, with
 * the speaker of the turn each line belongs to. Empty when the page has no
 * RR structure (not an RR doc, or indexed before RR structure landed).
 */
export async function fetchRRLines(documentId: string, pageNumber: number): Promise<RRPageLine[]> {
  const row = await (prisma as any).pageCache.findUnique({
    where: { documentId_pageNumber: { documentId, pageNumber } },
    select: { structuredJson: true },
  });
  if (!row?.structuredJson) return [];
  let parsed: any;
  try { parsed = JSON.parse(row.structuredJson); } catch { return []; }
  if (parsed.producer !== 'rr') return [];
  const out: RRPageLine[] = [];
  for (const b of parsed.blocks ?? []) {
    for (const l of b.lines ?? []) {
      if (l.lineNumber === undefined || l.lineNumber === null) continue;
      out.push({ lineNumber: l.lineNumber, text: l.text ?? '', speaker: b.speaker });
    }
  }
  return out.sort((a, b) => a.lineNumber - b.lineNumber);
}

const normalize = (s: string) => s.replace(/[^a-z0-9]+/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export interface QuoteVerification {
  verified: boolean;
  /** Lines actually containing the quote (may extend the cited range by
   * the ±1 slack). Empty when unverified or page has no RR structure. */
  matchedLines: number[];
  /** Speakers of the matched lines' turns. */
  speakers: string[];
  /** False when the page carries no RR structure at all — "unverifiable",
   * which callers must NOT display as "fabricated". */
  checkable: boolean;
}

/**
 * Verify a quoted span against the printed transcript lines of a cited
 * range (±1 line slack for off-by-one citations). Whitespace/punctuation
 * insensitive — OCR/extraction differences must not fail real quotes.
 */
export async function verifyTranscriptQuote(
  documentId: string,
  pageNumber: number,
  lineStart: number,
  lineEnd: number,
  quote: string,
): Promise<QuoteVerification> {
  const lines = await fetchRRLines(documentId, pageNumber);
  if (lines.length === 0) return { verified: false, matchedLines: [], speakers: [], checkable: false };

  const lo = Math.max(1, lineStart - 1);
  const hi = lineEnd + 1;
  const range = lines.filter(l => l.lineNumber >= lo && l.lineNumber <= hi);
  const haystack = normalize(range.map(l => l.text).join(' '));
  const needle = normalize(quote);
  if (!needle) return { verified: false, matchedLines: [], speakers: [], checkable: true };

  const verified = haystack.includes(needle);
  if (!verified) return { verified: false, matchedLines: [], speakers: [], checkable: true };

  // Narrow to the lines that actually contain pieces of the quote.
  const words = needle.split(' ').filter(w => w.length >= 4);
  const matched = range.filter(l => {
    const n = normalize(l.text);
    return n && words.some(w => n.includes(w));
  });
  return {
    verified: true,
    matchedLines: matched.map(l => l.lineNumber),
    speakers: [...new Set(matched.map(l => l.speaker).filter((s): s is string => !!s))],
    checkable: true,
  };
}
