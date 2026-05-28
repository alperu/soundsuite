/**
 * chip-segments — position-aware splitter for the composer query string.
 *
 * The chip composer at src/components/search/boolean-chip-composer.tsx renders
 * each filter chip as `{{ axon-expression }}` inline with the user's free-text
 * intent. The backend receives the rendered string verbatim, so the order of
 * chips and prose carries the user's "questions lead where the data is"
 * intent: each chip pairs with the natural-language phrase next to it, and
 * each pair drives its own sub-search.
 *
 * This module turns that flat string back into ordered segments so the
 * deep-search dispatcher (src/lib/search/deep-search.ts) can run one
 * sub-search per (chip, intent) pair — chip as a hard Lance filter, intent as
 * the FTS/vector body — plus an optional framing segment for any text before
 * the first chip (soft boost only).
 *
 * No behaviour change when the input string contains zero `{{ … }}` chips:
 * we emit a single framing segment with the whole text, preserving today's
 * single-sub-query path.
 */

import { parseBooleanQuery, type Node as BooleanAst } from './boolean-query';

export type ChipSegment = {
  kind: 'chip';
  /** Raw axon-expression text from inside the `{{ … }}` braces, trimmed. */
  raw: string;
  /** Parsed boolean AST. `null` if the expression failed to parse. */
  ast: BooleanAst | null;
  /** If the chip body didn't parse, the parser's error message — useful for telemetry. */
  parseError?: string;
  /** Free-text immediately following this chip, up to the next chip (or EOS). Trimmed. */
  nextIntent: string;
};

export type FramingSegment = {
  kind: 'framing';
  /** Free-text before the first chip (or the entire query if there are no chips). Trimmed. */
  text: string;
};

export type Segment = ChipSegment | FramingSegment;

const CHIP_RE = /\{\{\s*([\s\S]*?)\s*\}\}/g;

/**
 * Split the composer query into chip + framing segments in source order.
 *
 * Example input:
 *   `{{ filingRef==@b691 }} torrez statement {{ (case==@c1 or case==@c2) }} over time`
 *
 * Returns:
 *   [
 *     { kind: 'chip', raw: 'filingRef==@b691', ast: …, nextIntent: 'torrez statement' },
 *     { kind: 'chip', raw: '(case==@c1 or case==@c2)', ast: …, nextIntent: 'over time' },
 *   ]
 */
export function segmentChipsAndIntents(query: string): Segment[] {
  const segments: Segment[] = [];
  if (!query) return segments;

  // Walk all chip matches; everything between them is intent text.
  const chips: { raw: string; start: number; end: number }[] = [];
  CHIP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHIP_RE.exec(query)) !== null) {
    chips.push({ raw: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  if (chips.length === 0) {
    const trimmed = query.trim();
    if (trimmed.length > 0) segments.push({ kind: 'framing', text: trimmed });
    return segments;
  }

  // Framing segment: free text before the first chip.
  const leadText = query.slice(0, chips[0].start).trim();
  if (leadText.length > 0) {
    segments.push({ kind: 'framing', text: leadText });
  }

  // Chip + nextIntent for each chip, in source order.
  for (let i = 0; i < chips.length; i++) {
    const chip = chips[i];
    const nextStart = chip.end;
    const nextEnd = i + 1 < chips.length ? chips[i + 1].start : query.length;
    const nextIntent = query.slice(nextStart, nextEnd).trim();

    const parsed = parseBooleanQuery(chip.raw);
    const seg: ChipSegment = parsed.ok
      ? { kind: 'chip', raw: chip.raw, ast: parsed.ast, nextIntent }
      : { kind: 'chip', raw: chip.raw, ast: null, parseError: parsed.error, nextIntent };
    segments.push(seg);
  }

  return segments;
}
