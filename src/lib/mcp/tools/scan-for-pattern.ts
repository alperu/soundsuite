import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { SearchQuery, SearchResult, MatchQuery, Operator } from '../../vector/vector-store';
import type { CitationInput } from '../../citations/citation-formatter';
import { detectLineNumbers } from '../../citations/line-number-detector';
import { attachMotionIds } from '../motion-resolution';
import { resolveCaseScope, caseScopeFilter, caseScopeIds, type CaseScope } from '../case-scope';
import { getCorpusDenominator, provenAbsenceClause } from '../corpus-denominator';
import { buildCaseCitationContexts, defaultCitationContext, type CaseCitationContext } from '../case-citation-context';

/** How a page of results was produced. Always present on the result. */
export type ScanStrategy = 'fts+regex' | 'full-scan';

export interface ScanForPatternParams {
  pattern: string;
  caseId?: string;
  /** Subset scope — mutually exclusive with `caseId`. Becomes `case_id IN (…)`. */
  caseIds?: string[];
  limit?: number;
  /** Opaque page token returned as `nextCursor` by a previous call. */
  cursor?: string;
  /**
   * Pre-extracted Lance/SQL where-clauses to merge into the retrieval
   * filter as hard constraints. Each string is already SQL-escaped at the
   * call site (typically by `extractFieldFilters()` in
   * src/lib/search/boolean-to-fts.ts). Used by deep-search's per-chip
   * pattern dispatch so the regex backstop respects the same scope as
   * the main vector+FTS retrieval.
   */
  whereClauses?: string[];
  /**
   * `'phrase'` (default) verifies every returned row against the pattern.
   * `'keyword'` restores the legacy bag-of-words behaviour for a non-regex
   * pattern and always says, in `warnings[]`, that the rows are unverified.
   */
  mode?: 'phrase' | 'keyword';
  /**
   * Match across a printed transcript line number (default `true`). A literal
   * space in the pattern also matches "whitespace, a one-to-three digit line
   * number, whitespace". Set false to match the caller's spacing exactly.
   */
  linePermissive?: boolean;
  /**
   * Compare with curly quotes, dash variants and diacritics folded to ASCII on
   * both sides (default `true`). Returned text is always the raw document text.
   */
  fold?: boolean;
}

export interface ScanForPatternResult {
  results: Array<{
    text: string;
    /** Id of the matched chunk. Feed it to `get_chunk_context` to read the
     *  passage that runs past this chunk's edge. */
    chunkId?: string;
    document: string;
    page: number;
    match: string;
    citation?: string;
    citationShort?: string;
    filingType?: string;
    volumeNumber?: number;
    caseNumber?: string;
    /** Owning case id — ChunkProvenance parity with query_case_knowledge, and
     *  the argument every case-scoped tool requires (REPORT-discovery-tools §5). */
    caseId?: string;
    /** Motion whose page range contains this hit, when one resolves. */
    motionId?: string;
    filingSlug?: string;
  }>;
  /** How this page was produced. `full-scan` = regex run over the raw text column. */
  strategy: ScanStrategy;
  /** FTS candidates retrieved before the regex post-filter (`fts+regex` only). */
  candidatePool?: number;
  /** Rows read off the chunk table during this call (`full-scan` only). */
  scanned?: number;
  /** True when the scan stopped early (time box / row cap) — recall is bounded. */
  truncated?: boolean;
  /** Page token for the next call. Absent = this page is the end of the answer. */
  nextCursor?: string;
  /** Non-fatal recall caveats. Empty array = the answer is believed complete. */
  warnings: string[];
}

/**
 * Extract literal keywords from a regex pattern for FTS recall.
 * Strips regex metacharacters and returns meaningful words.
 */
function extractKeywordsFromPattern(pattern: string): string[] {
  // Remove regex metacharacters and special constructs
  const cleaned = pattern
    .replace(/\\[bBdDwWsSn.]/g, ' ')   // character classes
    .replace(/[.*+?^${}()|[\]\\]/g, ' ') // metacharacters
    .replace(/\{[^}]*\}/g, ' ')          // quantifiers like {2,3}
    .replace(/[<>]/g, ' ');

  return cleaned
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2); // Only meaningful words (2+ chars)
}

/** A literal word-character run inside a regex, with its flanking context. */
interface LiteralRun {
  text: string;
  /** True when nothing to the left can extend this run into a bigger index token. */
  leftClean: boolean;
  /** Same, to the right. */
  rightClean: boolean;
}

/** Escapes that can only match a token separator (so a run beside one is whole). */
const SEPARATOR_ESCAPES = new Set(['b', 's', 'n', 'r', 't', 'f', 'v', 'W', 'A', 'Z', 'z']);

/**
 * Walk a regex and pull out its literal `[A-Za-z0-9_]` runs, recording whether
 * each run is flanked by something that guarantees a token boundary.
 *
 * This is what tells `[Uu]nbeknownst` apart from `unbeknownst`: the run
 * `nbeknownst` sits immediately after a character class, so it is a *fragment*
 * of an index token, not a token — feeding it to BM25 FTS returns nothing.
 */
function literalRuns(pattern: string): LiteralRun[] {
  const runs: LiteralRun[] = [];
  let current = '';
  let leftClean = true; // start of pattern is a boundary
  let i = 0;

  const flush = (rightClean: boolean, nextLeftClean: boolean) => {
    if (current.length > 0) runs.push({ text: current, leftClean, rightClean });
    current = '';
    leftClean = nextLeftClean;
  };

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '\\') {
      const next = pattern[i + 1];
      // Escaped punctuation (\. \- \/) is a separator; \d \w \S are not.
      const clean = next === undefined
        ? true
        : /[A-Za-z0-9]/.test(next) ? SEPARATOR_ESCAPES.has(next) : true;
      flush(clean, clean);
      i += 2;
      continue;
    }

    if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      flush(false, false);
      i = close === -1 ? pattern.length : close + 1;
      continue;
    }

    if (c === '{') {
      // Quantifier: the atom it repeats is the previous char, so that char is
      // not reliably part of the literal run.
      if (current.length > 0) current = current.slice(0, -1);
      const close = pattern.indexOf('}', i + 1);
      flush(false, false);
      i = close === -1 ? pattern.length : close + 1;
      continue;
    }

    if (c === '*' || c === '+' || c === '?') {
      if (current.length > 0) current = current.slice(0, -1);
      flush(false, false);
      i += 1;
      continue;
    }

    if (c === '|' || c === '^' || c === '$') {
      flush(true, true);
      i += 1;
      continue;
    }

    if (c === '(' || c === ')') {
      // A group edge may abut word material on the other side, so treat it as
      // possibly token-extending. `(foo|bar)baz` really does mean `foobaz`.
      flush(false, false);
      i += 1;
      continue;
    }

    if (c === '.') {
      flush(false, false);
      i += 1;
      continue;
    }

    if (/[A-Za-z0-9_]/.test(c)) {
      current += c;
      i += 1;
      continue;
    }

    // Any other literal (space, comma, hyphen, apostrophe): a token separator
    // for the FTS tokenizer.
    flush(true, true);
    i += 1;
  }

  flush(true, true);
  return runs;
}

/**
 * Literal runs usable as FTS keywords: whole index tokens of ≥3 chars.
 *
 * A run flanked on both sides by boundaries is trivially whole. A run that is
 * not gets one rescue: if the compiled regex still matches the run standing
 * alone between separators, it is whole after all (this is what keeps
 * `\bfoo\b|\bbar\b` — the shape `/api/search/ai` builds — on the FTS path).
 */
/**
 * The FTS index is built with `removeStopWords: true`
 * (`src/lib/vector/vector-store.ts`), so a keyword that is a stopword is
 * dropped by the tokenizer and contributes nothing to recall. This is
 * tantivy's English set. A *superset* is the safe direction here: an extra
 * word costs a full scan, a missing one costs evidence.
 */
const FTS_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 's', 'such', 't', 'that',
  'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was',
  'will', 'with',
]);

/** A keyword FTS can actually match: a whole token that survives the tokenizer. */
function isReachableKeyword(word: string): boolean {
  return !FTS_STOPWORDS.has(word.toLowerCase());
}

/**
 * Drop the group delimiters a naive `|` split leaves stranded on a segment.
 *
 * `(unbeknownst|safeguarding)` splits into `(unbeknownst` and `safeguarding)`,
 * and both parens make `literalRuns` mark the run as possibly token-extending —
 * so a perfectly reachable alternation looked uncovered and scanned linearly.
 *
 * Only a *leading* `(` / `(?:` and a *trailing* `)` come off. An interior `)`
 * stays: `(foo|bar)baz` really does mean `barbaz`, so that segment must remain
 * uncovered. An escaped `\)` is a literal paren, not a delimiter, and stays too.
 */
function stripGroupDelimiters(segment: string): string {
  let s = segment;
  if (s.startsWith('(?:')) s = s.slice(3);
  else if (s.startsWith('(')) s = s.slice(1);
  if (s.endsWith(')') && !s.endsWith('\\)')) s = s.slice(0, -1);
  return s;
}

/**
 * Split a pattern into alternation segments at *every* `|`, whatever its depth.
 *
 * Deliberately naive. Proper top-level parsing would keep `(MR\.|MS\.)` as one
 * unit, but the conservative split is what we want: a segment like `MR\.` that
 * yields no usable keyword marks the whole pattern as unreachable by FTS, which
 * is the correct conclusion. Over-splitting can only send us to a full scan —
 * it can never make us miss evidence.
 *
 * A pattern with no `|` is a single segment: **one branch**, decided by exactly
 * the same rule.
 */
function alternationSegments(pattern: string): string[] {
  return pattern.split('|').map(stripGroupDelimiters);
}

/**
 * True when some branch contributes no keyword FTS can reach, so BM25 recall
 * for that branch is zero and nothing downstream would say so.
 *
 * This is the discriminator that replaces "does the pattern contain `|`" — and
 * it is not a fact about alternations. A pattern with no `|` is a single
 * branch: `[Cc]ould not do` reduces to `not`, a stopword the tokenizer removes,
 * so keyword recall for it is zero however many spaces it contains.
 *
 * Conversely, a pattern whose every branch contributes a real, non-stopword
 * whole token is *trustworthy* when FTS returns nothing — the terms genuinely
 * are not in the corpus, and a linear pass would only be slower. That is the
 * `/api/search/ai` shape, and it must stay on the FTS path.
 */
function hasUncoveredBranch(pattern: string): boolean {
  // `null` regex = no rescue test: a segment is not a valid regex on its own,
  // and the whole-pattern rescue is exactly the bug this replaces.
  return alternationSegments(pattern).some(
    (seg) => !safeKeywords(seg, null).some(isReachableKeyword),
  );
}

function safeKeywords(pattern: string, regex: RegExp | null): string[] {
  const out: string[] = [];
  for (const run of literalRuns(pattern)) {
    if (run.text.length < 3) continue;
    if (run.leftClean && run.rightClean) {
      out.push(run.text);
      continue;
    }
    if (regex && regex.test(`aa ${run.text} zz`)) out.push(run.text);
  }
  return out;
}

/**
 * Reject patterns that can blow up the regex engine before we point them at
 * tens of thousands of chunks: nested quantifiers (`(a+)+`) and quantified
 * lookbehind. Cheap textual check — it only has to catch the shapes that make
 * a linear scan hang.
 */
function catastrophicReason(pattern: string): string | null {
  if (/\(\?<[=!][^)]*[*+]/.test(pattern)) {
    return 'unbounded lookbehind';
  }
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== ')') continue;
    const after = pattern[i + 1];
    if (after !== '*' && after !== '+' && after !== '{') continue;
    // Walk back to the matching '(' and inspect the group body.
    let depth = 0;
    let start = -1;
    for (let j = i; j >= 0; j--) {
      if (pattern[j] === ')' && pattern[j - 1] !== '\\') depth++;
      else if (pattern[j] === '(' && pattern[j - 1] !== '\\') {
        depth--;
        if (depth === 0) { start = j; break; }
      }
    }
    if (start === -1) continue;
    if (bodyIsAmbiguouslyRepeatable(pattern.slice(start + 1, i))) {
      return 'nested quantifier';
    }
  }
  return null;
}

/**
 * True when a quantified group's body can match the same text many ways —
 * i.e. it holds an unbounded quantifier and *nothing mandatory* to anchor an
 * iteration. `(a+)+`, `(\d+)+`, `(\s*\w*)*` blow up; `(ab+c)+` and
 * `(No\.\s*\d+)+` do not, because each iteration must start on a fixed atom.
 */
function bodyIsAmbiguouslyRepeatable(body: string): boolean {
  let hasUnboundedQuantifier = false;
  let hasMandatoryAtom = false;
  let i = 0;

  while (i < body.length) {
    const c = body[i];

    // Structural chars carry no obligation of their own.
    if (c === '|' || c === '(' || c === ')' || c === '^' || c === '$') { i += 1; continue; }

    // Consume one atom.
    let atomIsBoundary = false;
    if (c === '\\') {
      atomIsBoundary = SEPARATOR_ESCAPES.has(body[i + 1] ?? '') && /[A-Za-z]/.test(body[i + 1] ?? '');
      i += 2;
    } else if (c === '[') {
      const close = body.indexOf(']', i + 1);
      i = close === -1 ? body.length : close + 1;
    } else {
      i += 1;
    }

    // …then the quantifier applied to it, if any.
    let quantified = false;
    const q = body[i];
    if (q === '*' || q === '+' || q === '?') {
      quantified = true;
      if (q !== '?') hasUnboundedQuantifier = true;
      i += 1;
    } else if (q === '{') {
      const close = body.indexOf('}', i + 1);
      const spec = body.slice(i + 1, close === -1 ? body.length : close);
      quantified = true;
      if (/^\d+,\s*$/.test(spec)) hasUnboundedQuantifier = true;
      i = close === -1 ? body.length : close + 1;
    }

    if (!quantified && !atomIsBoundary) hasMandatoryAtom = true;
  }

  return hasUnboundedQuantifier && !hasMandatoryAtom;
}

// ── Text folding (docs/tasks/18) ────────────────────────────────────────────
//
// The FTS index already folds at index time (`asciiFolding: true`,
// src/lib/vector/vector-store.ts), so keyword *recall* is not the gap. The gap
// is the regex comparison, which tests a raw pattern against raw text: a
// quotation pasted out of Word carries a curly apostrophe the corpus does not
// use, and a name transliterated with diacritics in one filing and without in
// another matches only one of the two. Fold both sides; return the raw text.

/** Punctuation that folds to its ASCII form. Case is NOT folded here — the
 *  regex already runs case-insensitive, and case-folding would widen it. */
const FOLD_CHARS: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '‵': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '‶': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-',
  '―': '-', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  ' ': ' ', ' ': ' ', '　': ' ',
};

const COMBINING_MARKS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃰︠-︯]/g;
/** Nothing outside ASCII means nothing to fold — the fast path a 250k-row scan needs. */
const NEEDS_FOLD = /[^\x00-\x7f]/;

function foldChar(ch: string): string {
  const mapped = FOLD_CHARS[ch];
  if (mapped !== undefined) return mapped;
  return ch.normalize('NFKD').replace(COMBINING_MARKS, '');
}

/** Folded form only. Identity for pure-ASCII input. */
function foldText(raw: string): string {
  if (!NEEDS_FOLD.test(raw)) return raw;
  let out = '';
  for (let i = 0; i < raw.length; i++) out += foldChar(raw[i]);
  return out;
}

/**
 * Folded form plus an index map back to the raw string, so a match found in
 * folded space can be sliced out of the raw text. `map[i]` is the raw offset of
 * folded character `i`; `map[folded.length]` is `raw.length`. `map === null`
 * means the fold was the identity and offsets need no translation.
 *
 * Without this, folding would silently cite the wrong span: NFKD decomposition
 * and a wide-dash-to-hyphen map both change string length.
 */
function foldWithMap(raw: string): { text: string; map: number[] | null } {
  if (!NEEDS_FOLD.test(raw)) return { text: raw, map: null };
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const folded = foldChar(raw[i]);
    for (let k = 0; k < folded.length; k++) {
      out += folded[k];
      map.push(i);
    }
  }
  map.push(raw.length);
  return { text: out, map };
}

// ── Line-number tolerance (docs/tasks/17) ───────────────────────────────────

/**
 * What a literal space becomes: at least one whitespace character, optionally a
 * printed line number and more whitespace.
 *
 * The `\s+` is load-bearing. The v10 report proposed `\s*(?:\d{1,3}\s+)?\s*`,
 * in which every quantifier is zero-or-more — that makes whitespace optional,
 * so `the court` would match `thecourt`, manufacturing exactly the
 * false-positive class task #16 exists to remove.
 */
const LINE_BREAK_GAP = '\\s+(?:\\d{1,3}\\s+)?';

/** Index of the `]` closing the class opened at `start`, or -1 if unterminated. */
function characterClassEnd(source: string, start: number): number {
  let j = start + 1;
  while (j < source.length) {
    if (source[j] === '\\') { j += 2; continue; }
    if (source[j] === ']') return j;
    j += 1;
  }
  return -1;
}

/**
 * Rewrite every *literal* space run in a regex source as `LINE_BREAK_GAP`.
 *
 * Deliberately narrow: a space inside a character class is left alone (it is
 * one alternative of a set, not a gap between words), whitespace the caller
 * wrote as `\s` is left alone (it is already their choice), and a space a
 * quantifier applies to is left alone (`ledger ?closed` means "optional
 * space"; rewriting it would make the space mandatory and change the answer).
 */
function insertLineTolerance(source: string): { source: string; changed: boolean } {
  let out = '';
  let changed = false;
  let i = 0;

  while (i < source.length) {
    const c = source[i];

    if (c === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === '[') {
      const close = characterClassEnd(source, i);
      if (close === -1) { out += source.slice(i); break; }
      out += source.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    if (c === ' ') {
      let j = i;
      while (j < source.length && source[j] === ' ') j += 1;
      const next = source[j];
      if (next === '*' || next === '+' || next === '?' || next === '{') {
        out += source.slice(i, j); // quantified — the caller's spacing stands
      } else {
        out += LINE_BREAK_GAP;
        changed = true;
      }
      i = j;
      continue;
    }

    out += c;
    i += 1;
  }

  return { source: out, changed };
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The single pattern-preparation step. Tasks 17 and 18 both rewrite the source
 * before compiling, so they compose here rather than as two passes that could
 * fight (folding must run first: a non-breaking space becomes a plain space,
 * which line tolerance then treats as a gap).
 */
interface PreparedPattern {
  /** What every match — post-filter, full scan, snippet — is tested against. */
  regex: RegExp | null;
  /** The same pattern without line tolerance, for the crossed-a-line warning. */
  strictRegex: RegExp | null;
  /** True when a literal space was actually rewritten. */
  lineTolerant: boolean;
  /** True when a rewritten source failed to compile and we fell back. */
  degraded: boolean;
}

function preparePattern(
  pattern: string,
  opts: { literal: boolean; linePermissive: boolean; fold: boolean },
): PreparedPattern {
  const compile = (s: string): RegExp | null => {
    try { return new RegExp(s, 'i'); } catch { return null; }
  };

  const base = opts.literal ? escapeLiteral(pattern) : pattern;
  const strictSource = opts.fold ? foldText(base) : base;
  const tolerant = opts.linePermissive
    ? insertLineTolerance(strictSource)
    : { source: strictSource, changed: false };

  let lineTolerant = tolerant.changed;
  let degraded = false;
  let regex = compile(tolerant.source);

  // A rewrite that will not compile must not silently disable matching.
  if (!regex && tolerant.source !== strictSource) {
    regex = compile(strictSource);
    lineTolerant = false;
    degraded = regex !== null;
  }
  if (!regex && strictSource !== base) {
    regex = compile(base);
    lineTolerant = false;
    degraded = regex !== null;
  }

  return {
    regex,
    strictRegex: lineTolerant ? compile(strictSource) : regex,
    lineTolerant: lineTolerant && regex !== null,
    degraded,
  };
}

/** Cursor payload. Opaque to callers; validated against the pattern on reuse. */
interface ScanCursor {
  s: ScanStrategy;
  /** `fts+regex`: index into the matched list. `full-scan`: row offset. */
  o: number;
  /** Pattern fingerprint — a cursor from another query must not silently page. */
  p: string;
}

function cursorKey(pattern: string, scope?: CaseScope): string {
  const ids = scope ? caseScopeIds(scope) : [];
  return `${pattern}|${ids.join(',')}`.slice(0, 200);
}

function encodeCursor(c: ScanCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): ScanCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed?.o !== 'number' || (parsed.s !== 'fts+regex' && parsed.s !== 'full-scan')) {
      return null;
    }
    return parsed as ScanCursor;
  } catch {
    return null;
  }
}

/** Row shape both retrieval paths produce. */
type SearchResultRow = SearchResult;

/** Rows read per LanceDB page during a full scan. */
const SCAN_BATCH = 1000;
/** Wall-clock budget for one full-scan call before it reports partial results. */
const SCAN_TIME_BUDGET_MS = 10_000;
/** Hard ceiling on rows read in one call, regardless of the time box. */
const SCAN_MAX_ROWS = 250_000;
/** Largest page a caller may request. Beyond this, page with `cursor`. */
const MAX_PAGE_LIMIT = 200;

export class ScanForPatternTool extends BaseMCPTool<
  ScanForPatternParams,
  ScanForPatternResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'scan_for_pattern',
      displayName: 'Scan for Pattern',
      description:
        'Search for exact patterns in legal documents using regex. Character classes, ' +
        'alternations and mid-word fragments fall back to a true regex scan of the ' +
        'chunk text, so a pattern FTS cannot tokenize still returns its hits. Every ' +
        'result reports `strategy`, recall counts and `warnings[]`; page with ' +
        '`cursor` / `nextCursor` rather than raising `limit`. Results carry the ' +
        'same structure metadata as query_case_knowledge when available (documentId, ' +
        'blockType, headingPath, speakers, tableMarkdown). Scope with `caseId` (one ' +
        'case) or `caseIds` (a subset); unscoped spans every case. Scoping selects ' +
        'WHICH cases are searched — it does not raise the candidate pool, so exhaust ' +
        'a scoped search with `nextCursor` exactly as you would an unscoped one. ' +
        'Absence of `nextCursor` means the answer is complete, and it is complete for ' +
        'a reason: a pattern with any branch the index cannot match (a fragment, a ' +
        'word under three characters, or a stopword) escalates to a full regex scan ' +
        'BEFORE the keyword query runs, and a candidate pool that came back capped ' +
        'escalates after it. A zero over a fully covered, uncapped keyword pass is an ' +
        'absence proven OVER THE INDEX, and `warnings[]` names the denominator it was ' +
        'proven from — the indexed chunks, and how many of the scope\'s documents are ' +
        'indexed at all. Read that denominator before relying on a negative: an absence ' +
        'is proven of the corpus only at complete coverage, and coverage is currently ' +
        'partial and varies sharply per case (call corpus_status). A bounded answer ' +
        'always says what bounded it instead. ' +
        'Every returned row is VERIFIED to contain the pattern (mode: "phrase", the ' +
        'default) — a bag-of-words hit is never presented as a match. A literal space ' +
        'matches across a printed transcript line number, and curly quotes, dashes and ' +
        'diacritics are folded on both sides of the comparison, so a phrase pasted out ' +
        'of a brief still finds the corpus form.',
      version: '1.7.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          caseId: {
            type: 'string',
            description:
              'Restrict the scan to one case (Case id, from list_cases). Omit to scan every case. Mutually exclusive with caseIds.',
          },
          caseIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description:
              'Restrict the scan to a subset of cases (Case ids, from list_cases). Mutually exclusive with caseId. Selects which cases are searched; it does not raise the candidate pool.',
          },
          whereClauses: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Extra SQL-style filter clauses ANDed into the retrieval filter (advanced; used by the dashboard\'s scope chips).',
          },
          limit: {
            type: 'number',
            description:
              'Results per page (default: 10, max: 200). This bounds the page, not ' +
              'the answer — follow `nextCursor` for the rest.',
          },
          cursor: {
            type: 'string',
            description: 'Page token from a previous call\'s `nextCursor`.',
          },
          mode: {
            type: 'string',
            enum: ['phrase', 'keyword'],
            description:
              'phrase (default): every returned row is verified to contain the pattern. ' +
              'keyword: legacy bag-of-words recall for a non-regex pattern — rows are ' +
              'NOT verified and warnings[] says so. Use query_case_knowledge for ' +
              'semantic search instead of this.',
          },
          linePermissive: {
            type: 'boolean',
            description:
              'Default true. A literal space in the pattern also matches across a ' +
              'printed transcript line number, so a quoted phrase that straddles a line ' +
              'break is still found. Set false to match your spacing exactly.',
          },
          fold: {
            type: 'boolean',
            description:
              'Default true. Compares with curly quotes, dash variants and diacritics ' +
              'folded to ASCII on both sides, so a quotation pasted from a brief finds ' +
              'the corpus spelling. Returned text is always raw. Set false to hunt an ' +
              'exact glyph.',
          },
        },
        required: ['pattern'],
      },
    };
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  validateParams(params: ScanForPatternParams): void {
    if (!params.pattern || typeof params.pattern !== 'string') {
      const err: any = new Error('Missing or invalid pattern parameter');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
    try {
      new RegExp(params.pattern);
    } catch (error) {
      const err: any = new Error(
        `Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      err.code = 'INVALID_REGEX';
      throw err;
    }
    // A pattern that compiles can still take exponential time on a long chunk.
    // Reject it here rather than hanging a scan over the whole corpus.
    const reason = catastrophicReason(params.pattern);
    if (reason) {
      const err: any = new Error(
        `Invalid regex pattern: ${reason} can backtrack catastrophically over document text`,
      );
      err.code = 'INVALID_REGEX';
      throw err;
    }
  }

  /**
   * Run the compiled regex over the raw chunk text, paging the table directly.
   *
   * `matches_` is the same predicate the FTS post-filter uses — one prepared
   * pattern and one folding decision for both paths, so the two can never
   * disagree about what matched (docs/tasks/17 item 3).
   *
   * Stops at `limit + 1` matches (the extra one only fixes the cursor), at the
   * end of the table, or at the time box — reporting `truncated` in the last
   * case so the caller can tell "no more" from "not finished".
   */
  private async runFullScan(
    context: ToolExecutionContext,
    matches_: (text: string) => boolean,
    filter: Record<string, any> | undefined,
    startOffset: number,
    limit: number,
  ): Promise<{
    matches: SearchResultRow[];
    scanned: number;
    truncated: boolean;
    nextOffset: number | null;
  }> {
    const matches: SearchResultRow[] = [];
    const need = limit + 1;
    const deadline = Date.now() + SCAN_TIME_BUDGET_MS;
    let rowOffset = startOffset;
    let scanned = 0;
    let truncated = false;
    let nextOffset: number | null = null;

    while (matches.length < need) {
      if (Date.now() > deadline || scanned >= SCAN_MAX_ROWS) {
        truncated = true;
        nextOffset = rowOffset;
        break;
      }

      const rows = await context.vectorStore.scanTextColumn({
        filter,
        limit: SCAN_BATCH,
        offset: rowOffset,
      });
      if (rows.length === 0) break;

      let stopped = false;
      for (let i = 0; i < rows.length; i++) {
        scanned++;
        if (!matches_(rows[i].text)) continue;
        if (matches.length === limit) {
          // One past the page: resume *at* this row so it is not skipped.
          nextOffset = rowOffset + i;
          stopped = true;
          break;
        }
        matches.push(rows[i]);
      }
      if (stopped) break;

      rowOffset += rows.length;
      if (rows.length < SCAN_BATCH) break; // end of table
    }

    return { matches, scanned, truncated, nextOffset };
  }

  async executeImpl(
    params: ScanForPatternParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ScanForPatternResult> {
    const { pattern, whereClauses } = params;
    const limit = Math.max(1, Math.min(params.limit ?? 10, MAX_PAGE_LIMIT));
    const warnings: string[] = [];
    const mode: 'phrase' | 'keyword' = params.mode === 'keyword' ? 'keyword' : 'phrase';
    const linePermissive = params.linePermissive !== false;
    const foldEnabled = params.fold !== false;

    // Mutual exclusion + existence in one place; a bad id fails here with
    // INVALID_PARAMS rather than returning an empty page (docs/tasks/12 §4).
    const scope = await resolveCaseScope(params, context.database);
    const scopeIds = caseScopeIds(scope);
    // Single-case metadata lookups below still key off one id.
    const caseId = scope.caseId;

    context.logger.info('Handling scan_for_pattern', { pattern, caseCount: scopeIds.length, limit });

    // Resume a previous page. A cursor minted for a different pattern/case
    // would silently page through the wrong answer, so reject it outright.
    let cursor: ScanCursor | null = null;
    if (params.cursor) {
      cursor = decodeCursor(params.cursor);
      if (!cursor || cursor.p !== cursorKey(pattern, scope)) {
        const err: any = new Error('Invalid or mismatched cursor for this pattern');
        err.code = 'INVALID_PARAMS';
        throw err;
      }
    }

    // Detect whether the input is an actual regex (has metacharacters) or a
    // plain natural-language phrase. When users / callers pass natural text
    // (e.g. "May 13 2026 hearing trust fund"), the strict regex post-filter
    // below would require that contiguous string to appear in a chunk —
    // which it never does (real text has commas, line breaks, different
    // word order). All FTS candidates would be filtered to 0.
    //
    // For natural-language input we trust the FTS recall (BM25 already
    // ranks by tokenized relevance). For real regex input we still apply
    // the post-filter so callers asking for `\bMay\s+\d+\b` etc. get
    // precise matches.
    //
    // Heuristic: the input is "regex-like" if it contains any unescaped
    // regex metacharacter that has no plain-text meaning. We strip word
    // chars / spaces / hyphens / commas / common punctuation first so a
    // phrase like "Cross-Examination" doesn't trip the hyphen check.
    const regexMeta = /[.*+?^${}()|[\]\\<>]|\\[bBdDwWsSn]/;
    const looksLikeRegex = regexMeta.test(pattern);

    let regex: RegExp | null = null;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      // Invalid regex — treat as natural-language input.
      regex = null;
    }

    // ── One pattern-preparation step (docs/tasks/17 + /18) ────────────────
    // `regex` above stays the *raw* compiled pattern: every strategy decision
    // below (`safeKeywords`, `hasUncoveredBranch`, branch coverage) reasons
    // about literals in the pattern the caller wrote, and must never see the
    // `\s+(?:\d{1,3}\s+)?` this step injects.
    //
    // A pattern with no metacharacters is compiled as an escaped literal so it
    // can be verified at all — that is task #16's whole point.
    const prepared = preparePattern(pattern, {
      literal: !looksLikeRegex,
      linePermissive,
      fold: foldEnabled,
    });
    const matchRegex = prepared.regex;
    const foldFor = (text: string): string => (foldEnabled ? foldText(text) : text);
    const matchesPattern = (text: string): boolean =>
      matchRegex !== null && matchRegex.test(foldFor(text));

    if (prepared.degraded) {
      warnings.push(
        'Line-number tolerance and/or text folding could not be applied to this pattern ' +
        '(the rewritten form did not compile) — matched the pattern exactly as written.',
      );
    }

    /**
     * Whether the rows returned were checked against the pattern.
     *
     * `looksLikeRegex` keeps deciding STRATEGY — the dashboard path must not
     * start linear-scanning — but it no longer decides VERIFICATION. Those are
     * different questions, and collapsing them is what let a six-word phrase
     * return twenty citations to passages that did not contain it, under
     * `warnings: []` (docs/tasks/16).
     */
    const verify =
      matchRegex !== null && (mode === 'phrase' || (looksLikeRegex && !!regex));

    if (mode === 'keyword' && !verify) {
      warnings.push(
        'mode: "keyword" — these rows are keyword (BM25) matches and were NOT verified ' +
        'against the pattern. A row may not contain it. Use the default mode: "phrase" ' +
        'to have every row checked.',
      );
    }

    // Extract literal keywords from the pattern for FTS recall
    const keywords = extractKeywordsFromPattern(pattern);

    // Of those, the ones that are whole index tokens. A pattern whose literals
    // are only *fragments* of tokens (`[Uu]nbeknownst` → `nbeknownst`) can
    // never be reached by BM25 — that is the recall hole this tool used to
    // report as an empty result set.
    const safe = regex ? safeKeywords(pattern, regex) : keywords;
    // Fold the keywords too, so recall and verification agree on spelling: the
    // index folds at write time (`asciiFolding: true`), so an unfolded keyword
    // with a diacritic or a curly apostrophe asks for a token it never wrote.
    const ftsKeywords = (safe.length > 0 ? safe : keywords).map((k) =>
      foldEnabled ? foldText(k) : k,
    );

    // ── Full-scan trigger rule ────────────────────────────────────────────
    // (a) the pattern is regex-like and no literal survives as a whole token;
    // (b) FTS returned zero candidates for a single-expression pattern
    //     (no whitespace, no alternation) — a lone mid-word fragment;
    // (c) the caller is paging a full scan.
    // Multi-word / alternation input never full-scans on (b): those are the
    // natural-language and `\bfoo\b|\bbar\b` shapes the dashboard sends, and a
    // linear pass would neither find more nor finish quickly.
    // A branch that contributes no FTS-reachable keyword makes BM25 recall for
    // that branch silently zero. Measured: `(MR\.|MS\.|THE COURT)` kept only
    // `THE` (a stopword) and returned nothing for a phrase on nearly every
    // transcript page; `[Cc]ould not do` kept only `not` and did the same with
    // no `|` in sight. A pattern with no alternation is one branch, judged by
    // the same rule. Scan instead.
    //
    // The `looksLikeRegex` gate is load-bearing: natural-language input runs no
    // post-filter, so scanning it linearly for a contiguous string would return
    // a confident zero for a phrase whose words are all present.
    const uncoveredBranch = looksLikeRegex && !!regex && hasUncoveredBranch(pattern);
    // `safe.length === 0` stays as a second disjunct: `stripGroupDelimiters`
    // can make a segment look whole when the full-pattern walk found nothing,
    // and over-escalating costs time while under-escalating costs evidence.
    const noWholeTokenKeyword =
      looksLikeRegex && !!regex && (safe.length === 0 || uncoveredBranch);
    /**
     * Every branch contributes a keyword the index can actually match, so an OR
     * keyword query is a genuine superset of this pattern's matches. When such
     * a pool is also uncapped, a zero is a *proven* absence, not an unreached
     * one — the distinction the warnings must carry.
     */
    const coveredKeywordSet =
      looksLikeRegex && !!regex && !uncoveredBranch && safe.length > 0;
    const zeroCandidateEligible = !!regex && !/\s/.test(pattern) && !pattern.includes('|');
    const scanSupported = typeof (context.vectorStore as any)?.scanTextColumn === 'function';

    // Retrieval scope, shared by both paths so the full scan never widens it.
    let filter: Record<string, any> | undefined;
    const scopeFilter = caseScopeFilter(scope);
    if (Object.keys(scopeFilter).length > 0) filter = { ...scopeFilter };
    if (whereClauses && whereClauses.length > 0) {
      filter = { ...(filter ?? {}), _rawWhere: [...whereClauses] };
    }

    let strategy: ScanStrategy = 'fts+regex';
    let matchedResults: SearchResultRow[] = [];
    let candidatePool: number | undefined;
    let scanned: number | undefined;
    let truncated = false;
    let nextCursor: string | undefined;

    /**
     * A full scan that reached the end of the table with no match is the
     * strongest proof this tool can produce — and it was the one carrying no
     * numbers. The uncapped `fts+regex` branch named its denominator while all
     * three full-scan paths said only "ran a full regex scan instead" or
     * "exhaustive over the index", so the more confident statement was the less
     * qualified one. See task 33.
     *
     * All four conditions are load-bearing. `!cursor` in particular: on a later
     * page, earlier pages may have returned matches, so a zero here is not an
     * absence for the query. Dropping it would emit a confident absence claim
     * for a phrase the tool had already found.
     */
    const noteFullScanAbsence = async (scan: {
      matches: unknown[];
      scanned: number;
      truncated: boolean;
      nextOffset: number | null;
    }): Promise<void> => {
      if (cursor) return; //             a page, not the whole answer
      if (scan.matches.length !== 0) return; // not an absence
      if (scan.truncated) return; //     time box / SCAN_MAX_ROWS cut it short
      if (scan.nextOffset !== null) return; // rows remain unscanned

      const clause = provenAbsenceClause(await getCorpusDenominator(context, scopeIds));
      // `scanned` is quoted alongside the denominator rather than instead of
      // it: a divergence between chunks actually read and the vector store's
      // count is itself a finding, and only visible if both numbers are shown.
      warnings.push(
        `The scan read all ${scan.scanned.toLocaleString('en-US')} chunks in scope to the ` +
        `end of the table and matched nothing: ${clause}.`,
      );
    };

    const wantFullScanUpFront = cursor?.s === 'full-scan' || noWholeTokenKeyword;

    if (wantFullScanUpFront && !scanSupported) {
      warnings.push(
        'This pattern needs a full text scan, but the vector store does not support one. ' +
        'Results may be incomplete.',
      );
    }

    if (wantFullScanUpFront && scanSupported && matchRegex) {
      if (uncoveredBranch && pattern.includes('|')) {
        warnings.push(
          'At least one alternation branch contributes no keyword the index can match ' +
          '(too short, a fragment, or a stopword), so keyword recall would miss that ' +
          'branch entirely — ran a full regex scan instead.',
        );
      } else if (uncoveredBranch) {
        warnings.push(
          'Every literal in this pattern is unreachable by the index (too short, a ' +
          'fragment, or a stopword the tokenizer removes), so keyword recall would ' +
          'miss its matches entirely — ran a full regex scan instead.',
        );
      } else if (noWholeTokenKeyword) {
        warnings.push(
          'No literal in this pattern is a whole index token, so keyword recall cannot ' +
          'reach its matches — ran a full regex scan instead.',
        );
      }
      strategy = 'full-scan';
      const scan = await this.runFullScan(context, matchesPattern, filter, cursor?.o ?? 0, limit);
      matchedResults = scan.matches;
      scanned = scan.scanned;
      truncated = scan.truncated;
      if (scan.nextOffset !== null) {
        nextCursor = encodeCursor({ s: 'full-scan', o: scan.nextOffset, p: cursorKey(pattern, scope) });
      }
      await noteFullScanAbsence(scan);
    } else {
      // ── FTS recall + regex post-filter (unchanged path) ─────────────────
      const pageOffset = cursor?.o ?? 0;

      // Fetch more candidates than needed so we can post-filter with regex.
      // For natural-language input we fetch exactly what the page needs since
      // there's no post-filter that would shrink the set.
      const wanted = pageOffset + limit;
      // One row past the page on the natural-language path so a next page is
      // detectable; ×5 on the regex path because the post-filter shrinks the set.
      const fetchLimit = verify ? wanted * 5 : wanted + 1;

      // Build search query — use FTS keywords for initial recall
      const searchQuery: SearchQuery = {
        limit: fetchLimit,
      };

      if (ftsKeywords.length > 0) {
        // Use FTS with extracted keywords (OR logic for broad recall)
        searchQuery.ftsQuery = new MatchQuery(ftsKeywords.join(' '), 'text', {
          operator: Operator.Or,
        });
      } else {
        // No useful keywords extracted — fall back to legacy LIKE with the raw pattern
        searchQuery.hybridQuery = pattern;
      }

      // Apply case filter and caller-supplied hard where-clauses (e.g.
      // deep-search's per-chip pattern dispatch shipping the chip's extracted
      // filters so the regex backstop stays inside the user's named scope).
      if (filter) searchQuery.filter = { ...filter };

      // Perform initial recall search
      const searchResults = await context.vectorStore.search(searchQuery);
      candidatePool = searchResults.length;

      // Post-filter: only apply the regex if the input is actually regex-like
      // AND the regex compiled. For natural-language queries, trust FTS recall.
      const allMatches = verify
        ? searchResults.filter((result) => matchesPattern(result.text))
        : searchResults;

      // Whether the pool was truncated decides which kind of zero this is, so
      // it has to be known before any warning is written.
      const poolCapped = searchResults.length >= fetchLimit;

      if (searchResults.length === 0 && matchRegex && zeroCandidateEligible && scanSupported) {
        // The measured mid-word-fragment case: FTS has no token for it, so the
        // regex never ran. Scan instead of reporting an empty record.
        warnings.push(
          'Keyword recall returned no candidates — ran a full regex scan instead.',
        );
        strategy = 'full-scan';
        const scan = await this.runFullScan(context, matchesPattern, filter, 0, limit);
        matchedResults = scan.matches;
        scanned = scan.scanned;
        truncated = scan.truncated;
        candidatePool = 0;
        if (scan.nextOffset !== null) {
          nextCursor = encodeCursor({ s: 'full-scan', o: scan.nextOffset, p: cursorKey(pattern, scope) });
        }
        await noteFullScanAbsence(scan);
      } else {
        matchedResults = allMatches.slice(pageOffset);

        const pageFills = matchedResults.length > limit;
        // When the page escalates below, the pool's limits are moot — saying
        // anything about unreached matches there would contradict the scan.
        const willEscalate = poolCapped && !pageFills && verify && scanSupported;
        // A superset pool that was never truncated: whatever the regex rejected,
        // nothing outside the pool could have satisfied it either.
        const provenAbsence = coveredKeywordSet && !poolCapped && !willEscalate;

        if (searchResults.length === 0) {
          // The denominator is read only when a proven claim is about to be
          // made, and only then — it costs a grouped count plus one vector
          // count, cached for the paging window.
          const clause = provenAbsence
            ? provenAbsenceClause(await getCorpusDenominator(context, scopeIds))
            : '';
          warnings.push(
            provenAbsence
              ? `Keyword recall returned no candidates for [${ftsKeywords.join(', ')}]. ` +
                'Every branch of this pattern contributes a keyword the index can match and ' +
                'the candidate pool was not capped, so this answer is exhaustive over the ' +
                `index: ${clause}.`
              : `Keyword recall returned no candidates for [${ftsKeywords.join(', ')}]. ` +
                'This is keyword recall, not an exhaustive scan — absence here is not proof of absence.',
          );
        } else if (verify && allMatches.length === 0 && !willEscalate) {
          // Useful diagnostic: regex post-filter dropped everything despite FTS
          // returning candidates. Without full branch coverage this almost
          // always means the caller passed a natural-language string with one
          // stray metacharacter and our heuristic mis-classified it.
          context.logger.warn?.('scan_for_pattern: regex post-filter dropped all FTS candidates', {
            pattern: pattern.slice(0, 120),
            ftsCandidates: searchResults.length,
          });
          const clause = provenAbsence
            ? provenAbsenceClause(await getCorpusDenominator(context, scopeIds))
            : '';
          warnings.push(
            provenAbsence
              ? `Keyword recall returned ${searchResults.length} candidates over a keyword set ` +
                'the index fully covers, and none matched the regex. The pool was not capped, ' +
                `so this answer is exhaustive over the index: ${clause}.`
              : `Keyword recall returned ${searchResults.length} candidates but none matched the ` +
                'regex. Matches elsewhere in the corpus would not be reached by this strategy.',
          );
        }

        if (willEscalate && matchRegex) {
          // The unsound terminal state: the candidate pool was truncated, yet
          // this page would end the answer with no cursor to follow. A caller
          // obeying the "page to exhaustion" contract would read that as
          // complete. Finish the job with a strategy that can actually finish.
          warnings.push(
            // States the ACTION, not the outcome. This warning is pushed before
            // `runFullScan` below, so it cannot know what the scan covered. It
            // previously read "so the result is exhaustive over the index" —
            // a completeness claim asserted before the fact, and reachably
            // false: a truncated escalation put that sentence in the same
            // `warnings[]` as "Results are partial — follow `nextCursor`".
            // What the scan actually proved is stated afterwards, by
            // `noteFullScanAbsence` or by the truncation/cap warnings.
            `Keyword recall was capped at ${fetchLimit} candidates and this page would ` +
            'have ended the answer — escalating to a full regex scan, which is not ' +
            'bounded by that cap. What it covered is reported below.',
          );
          if (cursor) {
            warnings.push(
              'Strategy changed mid-answer: rows already returned on earlier pages may ' +
              'repeat here. De-duplicate before counting.',
            );
          }
          strategy = 'full-scan';
          const scan = await this.runFullScan(context, matchesPattern, filter, 0, limit);
          matchedResults = scan.matches;
          scanned = scan.scanned;
          truncated = scan.truncated;
          candidatePool = searchResults.length;
          await noteFullScanAbsence(scan);
          if (scan.nextOffset !== null) {
            nextCursor = encodeCursor({ s: 'full-scan', o: scan.nextOffset, p: cursorKey(pattern, scope) });
          }
        } else {
          if (poolCapped) {
            warnings.push(
              `Keyword recall was capped at ${fetchLimit} candidates; more matches likely exist ` +
              'beyond this page.',
            );
          }
          if (pageFills) {
            nextCursor = encodeCursor({
              s: 'fts+regex',
              o: pageOffset + limit,
              p: cursorKey(pattern, scope),
            });
          }
        }
      }
    }

    if (truncated && scanned !== undefined) {
      warnings.push(
        `Scan stopped after ${scanned} rows (time box). Results are partial — follow ` +
        '`nextCursor` to continue.',
      );
    }

    // Take only the requested page
    const limitedResults = matchedResults.slice(0, limit);

    // An operator asserting a quotation should know the match crossed a printed
    // line number rather than appearing as contiguous text. Checked on the rows
    // actually returned — those are the only ones anyone will cite.
    if (prepared.lineTolerant && prepared.strictRegex && limitedResults.length > 0) {
      const strict = prepared.strictRegex;
      const crossed = limitedResults.some((r) => !strict.test(foldFor(r.text)));
      if (crossed) {
        warnings.push(
          'At least one match on this page spans a printed transcript line number: it ' +
          'matched with line-number tolerance, not as contiguous text. Check the line ' +
          'break before quoting it. Pass `linePermissive: false` for strict spacing.',
        );
      }
    }

    // Per-case citation context (formatter + volume counts + docket number)
    // for every case in scope. `caseIds` gets the same quality `caseId` does;
    // a multi-case page formats each row with its own case's context.
    const citationContexts = await buildCaseCitationContexts(scopeIds, context.database);
    const fallbackContext = defaultCitationContext();
    const contextFor = (rowCaseId?: string): CaseCitationContext =>
      (rowCaseId ? citationContexts.get(rowCaseId) : undefined) ?? fallbackContext;

    // documentId -> filingId for the returned hits, consumed by the single
    // batched motion lookup after enrichment.
    const docFilingIds = new Map<string, string>();

    // Enrich results with document names, matches, and citations
    const enrichedResults = await Promise.all(
      limitedResults.map(async (result) => {
        const document = await context.database.document.findUnique({
          where: { id: result.metadata.documentId },
          select: { fileName: true, filing: true, case: true, documentType: true },
        });

        // Extract the matched text. With the regex post-filter now optional,
        // `regex` may be null (natural-language input). In that case we surface
        // the first matching keyword instead so the UI's snippet field still
        // shows something useful.
        // Folding can change string length, so the match is located in folded
        // space and then sliced out of the RAW text via the offset map. The
        // operator must see and cite what the document actually says.
        let matchedText = '';
        const { text: haystack, map } = foldEnabled
          ? foldWithMap(result.text)
          : { text: result.text, map: null as number[] | null };
        const sliceRaw = (m: RegExpExecArray): string => {
          const start = map ? map[m.index] : m.index;
          const end = map ? map[m.index + m[0].length] : m.index + m[0].length;
          return result.text.slice(start, end);
        };

        if (matchRegex) {
          const m = matchRegex.exec(haystack);
          if (m) matchedText = sliceRaw(m);
        }
        // Snippet fallback for a row the regex did not match (`mode: 'keyword'`).
        // It searches the same folded haystack the primary path does, so it
        // agrees with recall about spelling instead of missing a diacritic.
        if (!matchedText && keywords.length > 0) {
          for (const kw of keywords) {
            const folded = foldEnabled ? foldText(kw) : kw;
            const kwRe = new RegExp(`\\b${folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            const m = kwRe.exec(haystack);
            if (m) { matchedText = sliceRaw(m); break; }
          }
        }

        // Build citation (same logic as query-case-knowledge)
        const filingType = result.metadata.filingType
          || (document as any)?.filing?.filingType
          || document?.documentType
          || undefined;
        let volumeNumber: number | undefined = result.metadata.volumeNumber || (document as any)?.filing?.volumeNumber;
        if (!volumeNumber && document?.fileName) {
          const volMatch = document.fileName.match(/-VOL(\d+)/i);
          if (volMatch) volumeNumber = parseInt(volMatch[1], 10);
        }
        // The chunk row already carries case_id; fall back to the Document's
        // case relation for rows indexed before the column was stamped.
        const rowCaseId: string | undefined =
          result.metadata.caseId || (document as any)?.case?.id || caseId || undefined;
        const caseCtx = contextFor(rowCaseId);
        const caseNumber = result.metadata.caseNumber || (document as any)?.case?.caseNumber || caseCtx.caseNumber;
        const filingId: string | undefined = (document as any)?.filing?.id;
        if (filingId && result.metadata.documentId) {
          docFilingIds.set(result.metadata.documentId, filingId);
        }
        const totalVolumes = filingType ? (caseCtx.volumeCountMap.get(filingType) ?? 1) : 1;

        const citationInput: CitationInput = {
          filingType,
          volumeNumber,
          totalVolumes,
          caseNumber: caseNumber || undefined,
          pageNumber: result.metadata.pageNumber,
          fileName: document?.fileName,
        };

        // Line numbers for Reporter's Record: prefer stored metadata, fall back to detection
        if (filingType) {
          const ft = filingType.toLowerCase();
          if (ft.includes('reporter') || ft === 'rr') {
            if (result.metadata.startLine && result.metadata.endLine) {
              citationInput.lineStart = result.metadata.startLine;
              citationInput.lineEnd = result.metadata.endLine;
            } else {
              const lineRange = detectLineNumbers(result.text);
              citationInput.lineStart = lineRange.startLine;
              citationInput.lineEnd = lineRange.endLine;
            }
          }
        }

        const formatted = caseCtx.formatter.format(citationInput);

        return {
          text: result.text,
          // `get_chunk_context` takes a chunkId and its description names this
          // tool as a source for one. Without this field that entry path does
          // not exist — found by calling the two tools in sequence, which no
          // unit test does.
          chunkId: result.chunkId,
          document: document?.fileName || 'Unknown',
          page: result.metadata.pageNumber,
          match: matchedText,
          citation: formatted.full,
          citationShort: formatted.short,
          filingType,
          volumeNumber,
          caseNumber: caseNumber || undefined,
          caseId: rowCaseId,
          // Filled by the batched motion lookup below — one query for the
          // whole result set, never one per item.
          motionId: undefined as string | undefined,
          filingSlug: (document as any)?.filing?.slug || undefined,
          // ChunkProvenance parity with query_case_knowledge (task #13
          // phase 3c) — optional until backfilled
          documentId: result.metadata.documentId || undefined,
          blockType: result.metadata.blockType || undefined,
          headingPath: result.metadata.headingPath || undefined,
          speakers: result.metadata.speakers || undefined,
          tableMarkdown: result.metadata.tableMarkdown || undefined,
        };
      }),
    );

    await attachMotionIds(context, enrichedResults, docFilingIds);

    context.logger.info('Pattern scan completed', {
      resultCount: enrichedResults.length,
      strategy,
      ftsKeywords,
      candidatePool,
      scanned,
      truncated,
      warnings: warnings.length,
    });

    return {
      results: enrichedResults,
      strategy,
      ...(candidatePool !== undefined ? { candidatePool } : {}),
      ...(scanned !== undefined ? { scanned } : {}),
      ...(truncated ? { truncated } : {}),
      ...(nextCursor ? { nextCursor } : {}),
      warnings,
    };
  }
}
