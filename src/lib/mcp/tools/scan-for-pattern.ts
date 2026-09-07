import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { SearchQuery, SearchResult, MatchQuery, Operator } from '../../vector/vector-store';
import { getCitationFormatter, CitationInput } from '../../citations/citation-formatter';
import { detectLineNumbers } from '../../citations/line-number-detector';
import { attachMotionIds } from '../motion-resolution';
import { resolveCaseScope, caseScopeFilter, caseScopeIds, type CaseScope } from '../case-scope';

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
}

export interface ScanForPatternResult {
  results: Array<{
    text: string;
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
        'a scoped search with `nextCursor` exactly as you would an unscoped one.',
      version: '1.4.0',
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
   * Unlike the FTS path this applies the regex unconditionally — a plain
   * literal like a mid-word fragment has no metacharacters, so the
   * "looks like a regex" heuristic must not gate the filter here.
   *
   * Stops at `limit + 1` matches (the extra one only fixes the cursor), at the
   * end of the table, or at the time box — reporting `truncated` in the last
   * case so the caller can tell "no more" from "not finished".
   */
  private async runFullScan(
    context: ToolExecutionContext,
    regex: RegExp,
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
        if (!regex.test(rows[i].text)) continue;
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

    // Extract literal keywords from the pattern for FTS recall
    const keywords = extractKeywordsFromPattern(pattern);

    // Of those, the ones that are whole index tokens. A pattern whose literals
    // are only *fragments* of tokens (`[Uu]nbeknownst` → `nbeknownst`) can
    // never be reached by BM25 — that is the recall hole this tool used to
    // report as an empty result set.
    const safe = regex ? safeKeywords(pattern, regex) : keywords;
    const ftsKeywords = safe.length > 0 ? safe : keywords;

    // ── Full-scan trigger rule ────────────────────────────────────────────
    // (a) the pattern is regex-like and no literal survives as a whole token;
    // (b) FTS returned zero candidates for a single-expression pattern
    //     (no whitespace, no alternation) — a lone mid-word fragment;
    // (c) the caller is paging a full scan.
    // Multi-word / alternation input never full-scans on (b): those are the
    // natural-language and `\bfoo\b|\bbar\b` shapes the dashboard sends, and a
    // linear pass would neither find more nor finish quickly.
    const noWholeTokenKeyword = looksLikeRegex && !!regex && safe.length === 0;
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

    const wantFullScanUpFront = cursor?.s === 'full-scan' || noWholeTokenKeyword;

    if (wantFullScanUpFront && !scanSupported) {
      warnings.push(
        'This pattern needs a full text scan, but the vector store does not support one. ' +
        'Results may be incomplete.',
      );
    }

    if (wantFullScanUpFront && scanSupported && regex) {
      if (noWholeTokenKeyword) {
        warnings.push(
          'No literal in this pattern is a whole index token, so keyword recall cannot ' +
          'reach its matches — ran a full regex scan instead.',
        );
      }
      strategy = 'full-scan';
      const scan = await this.runFullScan(context, regex, filter, cursor?.o ?? 0, limit);
      matchedResults = scan.matches;
      scanned = scan.scanned;
      truncated = scan.truncated;
      if (scan.nextOffset !== null) {
        nextCursor = encodeCursor({ s: 'full-scan', o: scan.nextOffset, p: cursorKey(pattern, scope) });
      }
    } else {
      // ── FTS recall + regex post-filter (unchanged path) ─────────────────
      const pageOffset = cursor?.o ?? 0;

      // Fetch more candidates than needed so we can post-filter with regex.
      // For natural-language input we fetch exactly what the page needs since
      // there's no post-filter that would shrink the set.
      const wanted = pageOffset + limit;
      // One row past the page on the natural-language path so a next page is
      // detectable; ×5 on the regex path because the post-filter shrinks the set.
      const fetchLimit = looksLikeRegex && regex ? wanted * 5 : wanted + 1;

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
      const allMatches = looksLikeRegex && regex
        ? searchResults.filter((result) => regex!.test(result.text))
        : searchResults;

      if (looksLikeRegex && regex && allMatches.length === 0 && searchResults.length > 0) {
        // Useful diagnostic: regex post-filter dropped everything despite FTS
        // returning candidates. Almost always means the caller passed a
        // natural-language string with one stray metacharacter (parens,
        // apostrophe etc.) and our heuristic mis-classified it.
        context.logger.warn?.('scan_for_pattern: regex post-filter dropped all FTS candidates', {
          pattern: pattern.slice(0, 120),
          ftsCandidates: searchResults.length,
        });
        warnings.push(
          `Keyword recall returned ${searchResults.length} candidates but none matched the ` +
          'regex. Matches elsewhere in the corpus would not be reached by this strategy.',
        );
      }

      if (searchResults.length === 0 && regex && zeroCandidateEligible && scanSupported) {
        // The measured mid-word-fragment case: FTS has no token for it, so the
        // regex never ran. Scan instead of reporting an empty record.
        warnings.push(
          'Keyword recall returned no candidates — ran a full regex scan instead.',
        );
        strategy = 'full-scan';
        const scan = await this.runFullScan(context, regex, filter, 0, limit);
        matchedResults = scan.matches;
        scanned = scan.scanned;
        truncated = scan.truncated;
        candidatePool = 0;
        if (scan.nextOffset !== null) {
          nextCursor = encodeCursor({ s: 'full-scan', o: scan.nextOffset, p: cursorKey(pattern, scope) });
        }
      } else {
        if (searchResults.length === 0) {
          warnings.push(
            `Keyword recall returned no candidates for [${ftsKeywords.join(', ')}]. ` +
            'This is keyword recall, not an exhaustive scan — absence here is not proof of absence.',
          );
        } else if (searchResults.length >= fetchLimit) {
          warnings.push(
            `Keyword recall was capped at ${fetchLimit} candidates; more matches likely exist ` +
            'beyond this page.',
          );
        }
        matchedResults = allMatches.slice(pageOffset);
        if (matchedResults.length > limit) {
          nextCursor = encodeCursor({
            s: 'fts+regex',
            o: pageOffset + limit,
            p: cursorKey(pattern, scope),
          });
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

    // Count distinct volumes per filing type for citation formatting
    const volumeCountMap = new Map<string, number>();
    if (caseId) {
      try {
        const filings = await (context.database as any).filing.findMany({
          where: { caseId },
          select: { filingType: true, volumeNumber: true },
        });
        const typeVolumes = new Map<string, Set<number>>();
        for (const f of filings) {
          if (!f.filingType) continue;
          if (!typeVolumes.has(f.filingType)) typeVolumes.set(f.filingType, new Set());
          typeVolumes.get(f.filingType)!.add(f.volumeNumber ?? 1);
        }
        for (const [type, vols] of typeVolumes) {
          volumeCountMap.set(type, vols.size);
        }
        // Supplement from document filenames
        const caseDocs = await context.database.document.findMany({
          where: { caseId },
          select: { fileName: true, documentType: true },
        });
        const docTypeVolumes = new Map<string, Set<number>>();
        for (const doc of caseDocs) {
          if (!doc.documentType) continue;
          const volMatch = doc.fileName?.match(/-VOL(\d+)/i);
          const vol = volMatch ? parseInt(volMatch[1], 10) : 1;
          if (!docTypeVolumes.has(doc.documentType)) docTypeVolumes.set(doc.documentType, new Set());
          docTypeVolumes.get(doc.documentType)!.add(vol);
        }
        for (const [type, vols] of docTypeVolumes) {
          if (vols.size > (volumeCountMap.get(type) ?? 0)) volumeCountMap.set(type, vols.size);
        }
      } catch { /* ignore */ }
    }

    // Select citation formatter based on case metadata
    let caseData: { jurisdiction?: string | null; state?: string | null; country?: string | null; caseNumber?: string | null } | null = null;
    if (caseId) {
      caseData = await context.database.case.findUnique({
        where: { id: caseId },
        select: { jurisdiction: true, state: true, country: true, caseNumber: true },
      });
    }
    const formatter = getCitationFormatter({
      jurisdiction: caseData?.jurisdiction || undefined,
      state: caseData?.state || undefined,
      country: caseData?.country || undefined,
    });

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
        let matchedText = '';
        if (regex) {
          const m = result.text.match(regex);
          matchedText = m ? m[0] : '';
        }
        if (!matchedText && keywords.length > 0) {
          for (const kw of keywords) {
            const kwRe = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            const m = result.text.match(kwRe);
            if (m) { matchedText = m[0]; break; }
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
        const caseNumber = result.metadata.caseNumber || (document as any)?.case?.caseNumber || caseData?.caseNumber;
        // The chunk row already carries case_id; fall back to the Document's
        // case relation for rows indexed before the column was stamped.
        const rowCaseId: string | undefined =
          result.metadata.caseId || (document as any)?.case?.id || caseId || undefined;
        const filingId: string | undefined = (document as any)?.filing?.id;
        if (filingId && result.metadata.documentId) {
          docFilingIds.set(result.metadata.documentId, filingId);
        }
        const totalVolumes = filingType ? (volumeCountMap.get(filingType) ?? 1) : 1;

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

        const formatted = formatter.format(citationInput);

        return {
          text: result.text,
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
