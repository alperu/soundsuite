/**
 * Deep Search Engine — multi-query decomposition for complex legal research questions.
 *
 * 1. Decomposes a complex question into targeted sub-queries via LLM
 * 2. Runs parallel searches for each sub-query through the full RAG pipeline
 * 3. Deduplicates and reranks the merged result pool
 * 4. Generates a comprehensive markdown report with citations
 */

import { callLLM, callLLMJson, buildContext, getAvailableProvider } from '../mcp/tools/ai-helper';
import { streamAI } from '../ai/ai-provider';
import { supportsAdaptiveEffort, type AIProviderKey } from '../ai/models';
import { rerank, RerankableResult } from './reranker';
import { getConfig } from '../db/config';
import type { ToolRegistry } from '../mcp/tool-registry';
import { parseBooleanQuery, astSerialize } from './boolean-query';
import { runRlmWithTools, type RlmToolSpec, RLM_MODEL_ID } from '../ai/stream-rlm';
import { segmentChipsAndIntents, type Segment as ChipQuerySegment } from './chip-segments';
import { extractFieldFilters } from './boolean-to-fts';
import { sourceDedupKey } from './source-dedup';
import { buildCiteContext, citeOf, truncateBlock } from './context-builder';
import { capThoughts, createPreambleSplitter, splitReportPreamble } from './report-preamble';
import { pickProvenance, type ChunkProvenance } from './chunk-provenance';
import { extractStructureHint, speakersInclude } from './structure-hints';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ChunkProvenance fields (documentId/blockType/headingPath/speakers/
// tableMarkdown) ride on every source — optional until backfilled.
export interface DeepSearchSource extends ChunkProvenance {
  text: string;
  document: string;
  page: number;
  score: number;
  citation?: string;
  citationShort?: string;
  filingType?: string;
  volumeNumber?: number;
  caseNumber?: string;
  filingSlug?: string;
  /** Which sub-queries found this chunk */
  matchedSubQueries: string[];
}

export interface DecompositionResult {
  subQueries: string[];
  intent: string;
}

export interface DeepSearchProgress {
  step:
    | 'decomposing'
    | 'searching'
    | 'pattern_searching'
    | 'merging'
    | 'reranking'
    | 'generating'
    | 'rlm-synthesis'
    | 'rlm-subcall'
    | 'done'
    | 'warning';
  message: string;
  /** For 'searching' step: which sub-query index (0-based) */
  subQueryIndex?: number;
  subQueryTotal?: number;
  /** Partial data available at this step */
  subQueries?: string[];
  intent?: string;
  searchStats?: Partial<DeepSearchResult['searchStats']>;
  /** Non-fatal warnings collected during the run (e.g. reranker fallback). */
  warnings?: Array<{ source: string; host?: string; message: string; count?: number }>;
  /** rlm-synthesis / rlm-subcall: sidecar host serving the RLM */
  rlmHost?: string;
  /** rlm-synthesis / rlm-subcall: RLM model id */
  rlmModel?: string;
  /** rlm-subcall: 1-based round index within the tool-use loop */
  rlmRound?: number;
  /** rlm-subcall: the sub-query the model asked for */
  rlmSubQuery?: string;
  /** rlm-subcall: number of chunks returned to the model */
  rlmChunkCount?: number;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DeepSearchOptions {
  provider?: string;
  model?: string;
  caseId?: string;
  chatId?: string;
  maxDepth?: number;
  onProgress?: (progress: DeepSearchProgress) => void;
  /** Previous conversation turns for follow-up questions */
  history?: ConversationTurn[];
  /** Additional context from active workflows */
  workflowContext?: string;
  /** Control thinking/reasoning mode for models that support it (e.g. Qwen3). */
  thinking?: boolean;
  /** Output token budget for the final report LLM call. Falls back to 16384. */
  maxTokens?: number;
  /** Anthropic Opus 4.7 adaptive-thinking effort. Default 'medium'. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Abort signal to cancel mid-pipeline. Checked between major phases. */
  signal?: AbortSignal;
  /** Streamed report tokens — called for each chunk the report LLM emits. */
  onToken?: (text: string) => void;
  /** Streamed thinking tokens (Anthropic adaptive thinking). */
  onThinking?: (text: string) => void;
  /**
   * Streamed research trace: RLM evidence-gathering narration, plus anything
   * the preamble splitter diverts off the front of the synthesis output.
   * Everything here is intermediate work, never the answer.
   */
  onThoughts?: (text: string) => void;
  /**
   * Multi-pass report generation: stage 1 drafts outline + short sections
   * (summary/gaps/significance/next steps), stage 2 streams each findings
   * subsection as its own LLM call. Avoids mid-report truncation when the
   * combined output would exceed the model's per-call output cap, and keeps
   * each section under the attention sweet-spot (~4-8K tokens) for quality.
   */
  multiPass?: boolean;
  /**
   * Route the final synthesis through ss-rlm (Qwen3-8B post-trained) via
   * vLLM's OpenAI tool-calling, exposing query_case_knowledge as a tool so
   * the model can fetch additional evidence recursively instead of being
   * fed every reranked chunk up-front. When set, generated `provider` on the
   * result becomes 'rlm' and the run emits 'rlm-synthesis' / 'rlm-subcall'
   * progress events for the UI.
   */
  useRlm?: boolean;
  /** Max RLM tool-use rounds before forcing a final answer. Default 4. */
  rlmMaxRounds?: number;
  /**
   * Pre-compiled LanceDB pre-filter clauses for a graph scope (see
   * `scopeToWhereClauses`). AND'd into EVERY retrieval this run performs —
   * per-sub-query vector/FTS, the regex backstop, and the RLM's recursive
   * tool calls — so nothing outside the scope can reach the report. Callers
   * send this INSTEAD of `caseId`, never alongside it.
   */
  whereClauses?: string[];
}

export interface DeepSearchResult {
  report: string;
  sources: DeepSearchSource[];
  subQueries: string[];
  intent: string;
  searchStats: {
    totalRetrieved: number;
    uniqueAfterDedup: number;
    finalAfterRerank: number;
    subQueryCount: number;
  };
  model: string;
  provider: string;
  /** True when RLM drove the evidence-gathering stage before cloud-LLM synthesis. */
  rlmAssisted?: boolean;
  /** Sidecar host that served the RLM tool-use loop. */
  rlmHost?: string;
  /** Number of extra sources RLM discovered via recursive tool calls. */
  rlmExtraSourceCount?: number;
  /**
   * Research trace for this turn — the same text streamed via `onThoughts`,
   * accumulated so a reopened session can replay it. Absent when the run
   * produced no intermediate output. Never rendered as markdown.
   */
  thoughts?: string;
}

// ---------------------------------------------------------------------------
// 1. Query Decomposition
// ---------------------------------------------------------------------------

const DECOMPOSE_SYSTEM_PROMPT = `You are a legal research query planner. Given a complex legal research question, break it into 3-7 targeted search queries that together will cover all aspects of the question.

CRITICAL: Court transcripts and legal documents use different wording than how people describe them. You MUST generate paraphrased variations — not just the exact words from the question.

Each sub-query should:
- Be specific and searchable (like something you'd type into a search engine)
- Target a different aspect or angle of the original question
- Use ALTERNATIVE PHRASINGS and synonyms — the exact quote in a transcript will differ from how it's characterized
- Include relevant legal terminology
- Be short (under 20 words)
- If the question mentions a specific record type (RR, CR) or page number, include a sub-query with that exact reference (e.g., "RR 24 testimony about hiring")

For example, if the user asks about someone saying they "could have hired someone":
- DON'T just search: "could have hired someone"
- DO search: "hired realtor", "hire somebody to value", "could have retained", "discovery process property valuation"

Also provide a brief "intent" summarizing what the user is ultimately looking for.

Respond with JSON: { "subQueries": ["query1", "query2", ...], "intent": "brief intent summary" }`;

export async function decomposeQuery(
  query: string,
  options?: { provider?: string; model?: string; history?: ConversationTurn[]; thinking?: boolean; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; signal?: AbortSignal },
): Promise<DecompositionResult> {
  // Boolean-syntax bypass — split top-level OR branches into parallel
  // sub-queries when the user wrote a structured boolean query.
  //
  // Product rule: boolean operators are honored ONLY inside `{{ … }}` chip
  // syntax. Plain free-text prose must NOT be boolean-parsed — parseBooleanQuery
  // flags bare English "and"/"or"/"not" as operators, so a paragraph (even one
  // with incidental parens like "(via Mr. Woodby)" or brackets) would have every
  // token turned into a bare AND term and astSerialize would mangle it into
  // " and "-joined words. Without `{{ }}` chips we fall through to LLM
  // decomposition / whole-DB semantic search scoped by the dropdown. (Chip
  // queries are unchanged — they previously entered here via their field
  // operators/parens too.)
  const hasChipSyntax = /\{\{[\s\S]*?\}\}/.test(query);
  if (hasChipSyntax) {
    const parsedBool = parseBooleanQuery(query);
    if (parsedBool.ok && parsedBool.hasOperators) {
      const branches = parsedBool.ast.op === 'OR' ? parsedBool.ast.children : [parsedBool.ast];
      const subQueries = branches.map(astSerialize).filter(s => s.trim().length > 0);
      if (subQueries.length > 0) {
        return { subQueries, intent: query };
      }
    }
  }

  try {
    // For follow-ups, include conversation context so decomposition is aware of prior discussion
    let userContent = query;
    if (options?.history && options.history.length > 0) {
      const historyBlock = options.history.map((t) =>
        t.role === 'user' ? `User: ${t.content}` : `Assistant: ${t.content.slice(0, 500)}`,
      ).join('\n');
      userContent = `Previous conversation:\n${historyBlock}\n\nNew follow-up question: ${query}`;
    }

    const result = await callLLMJson<DecompositionResult>(
      DECOMPOSE_SYSTEM_PROMPT,
      userContent,
      {
        maxTokens: 512,
        temperature: 0.1,
        provider: options?.provider,
        model: options?.model,
        thinking: options?.thinking,
        effort: options?.effort,
        signal: options?.signal,
        jsonSchema: {
          type: 'object',
          properties: {
            subQueries: {
              type: 'array',
              description: '2-5 focused sub-queries that decompose the original question. Each is a self-contained search query.',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 7,
            },
            intent: {
              type: 'string',
              description: 'A brief one-sentence summary of what the user is trying to find.',
            },
          },
          required: ['subQueries', 'intent'],
        },
      },
    );

    // Validate the result
    if (
      result.subQueries &&
      Array.isArray(result.subQueries) &&
      result.subQueries.length > 0
    ) {
      let subQueries = result.subQueries.slice(0, 7);

      // Always include the original query as an additional sub-query
      // to ensure we don't miss results that match the user's exact phrasing
      const originalLower = query.toLowerCase().trim();
      const alreadyIncludes = subQueries.some(
        (sq) => sq.toLowerCase().trim() === originalLower,
      );
      if (!alreadyIncludes) {
        subQueries = [query, ...subQueries];
      }

      return {
        subQueries,
        intent: result.intent || query,
      };
    }

    // Fallback: use original query
    return { subQueries: [query], intent: query };
  } catch {
    // Decomposition failed — fall back to single query
    return { subQueries: [query], intent: query };
  }
}

// ---------------------------------------------------------------------------
// 2. Parallel Searches
// ---------------------------------------------------------------------------

export interface SubQueryResult {
  subQuery: string;
  sources: DeepSearchSource[];
}

/**
 * SubQuerySpec — structured input for a single sub-search dispatch.
 *
 * Carries optional `whereClauses` (hard Lance filter — e.g. `filing_id = '<uuid>'`
 * lifted from a chip's boolean AST via extractFieldFilters) and `softBoostRefs`
 * (score multiplier in the post-rerank stage for results matching the named
 * refs). The plain-string form (no chip filters, no boost) is preserved via
 * the overload at the call site.
 */
export interface SubQuerySpec {
  query: string;
  whereClauses?: string[];
  softBoostRefs?: Array<{ field: 'documentId' | 'caseId' | 'filingId'; values: string[] }>;
  /** Human-readable tag for telemetry / matchedSubQueries attribution. */
  label?: string;
}

/**
 * Build per-chip sub-query specs from the composer query string.
 *
 * Returns `null` when the query contains no `{{ … }}` chip segments — the
 * caller then falls back to today's LLM-decomposition path (decomposeQuery →
 * subQueries: string[]).
 *
 * When chips are present, returns one SubQuerySpec per (chip, intent) pair
 * with the chip translated into a hard Lance where-clause, plus an optional
 * "framing" spec for any free-text before the first chip — that one carries
 * no hard filter but a soft boost over the union of chip refs, implementing
 * the "questions lead where the data is" semantics.
 */
export function buildChipSpecs(query: string): SubQuerySpec[] | null {
  const segments = segmentChipsAndIntents(query);
  const chipSegments = segments.filter((s): s is Extract<ChipQuerySegment, { kind: 'chip' }> => s.kind === 'chip');
  if (chipSegments.length === 0) return null;

  // Convert each chip's AST into a Lance where-clause set + collect any ref
  // values that AND'd at the top level — those drive the framing soft boost.
  type ChipPair = { spec: SubQuerySpec; refValuesByField: Map<'documentId' | 'caseId' | 'filingId', Set<string>> };
  const chipPairs: ChipPair[] = [];
  for (const chip of chipSegments) {
    if (!chip.ast) {
      // Malformed chip — best we can do is treat the raw text as a sub-query
      // intent so the model still sees the user's named scope.
      chipPairs.push({
        spec: { query: chip.nextIntent || chip.raw, label: `chip:${chip.raw.slice(0, 40)}` },
        refValuesByField: new Map(),
      });
      continue;
    }
    const { whereClauses } = extractFieldFilters(chip.ast);

    // Collect ref UUID values (per field) by walking the AST so the framing
    // soft boost can re-use them. We only need values for the columns the
    // tool already exposes as boost fields: document_id, case_id, filing_id.
    const refValuesByField = new Map<'documentId' | 'caseId' | 'filingId', Set<string>>();
    const FIELD_TO_BOOST: Record<string, 'documentId' | 'caseId' | 'filingId'> = {
      documentId: 'documentId', fileRef: 'documentId', document: 'documentId',
      caseId: 'caseId', case: 'caseId', caseRef: 'caseId',
      filingId: 'filingId', filing: 'filingId', filingRef: 'filingId',
    };
    const walk = (node: typeof chip.ast | null) => {
      if (!node) return;
      if (node.op === 'TERM') {
        if (node.isRef && node.path && node.path.length === 1) {
          const boostField = FIELD_TO_BOOST[node.path[0]];
          if (boostField) {
            const set = refValuesByField.get(boostField) ?? new Set<string>();
            set.add(node.value);
            refValuesByField.set(boostField, set);
          }
        }
        return;
      }
      if (node.op === 'NOT') { walk(node.child); return; }
      for (const c of node.children) walk(c);
    };
    walk(chip.ast);

    chipPairs.push({
      spec: {
        // Use the paired intent text as the semantic body. If the chip has
        // no following free-text, fall back to a generic "discuss" phrasing
        // so the FTS still gets something to score against; the hard filter
        // does the real scoping work either way.
        query: chip.nextIntent && chip.nextIntent.length > 0
          ? chip.nextIntent
          : 'all available evidence',
        whereClauses,
        label: `chip:${chip.raw.slice(0, 60)}`,
      },
      refValuesByField,
    });
  }

  const specs: SubQuerySpec[] = chipPairs.map(p => p.spec);

  // Framing segment: text before the first chip (if any). Soft boost the
  // union of every chip's ref values, but do not hard-filter — the framing
  // is the user's overall question; chips are scope hints.
  const framing = segments.find((s): s is Extract<typeof s, { kind: 'framing' }> => s.kind === 'framing');
  if (framing && framing.text.length > 0) {
    const unioned: Record<'documentId' | 'caseId' | 'filingId', Set<string>> = {
      documentId: new Set(), caseId: new Set(), filingId: new Set(),
    };
    for (const p of chipPairs) {
      for (const [field, set] of p.refValuesByField) {
        for (const v of set) unioned[field].add(v);
      }
    }
    const softBoostRefs: SubQuerySpec['softBoostRefs'] = [];
    for (const field of ['documentId', 'caseId', 'filingId'] as const) {
      if (unioned[field].size > 0) softBoostRefs.push({ field, values: Array.from(unioned[field]) });
    }
    specs.unshift({
      query: framing.text,
      ...(softBoostRefs.length > 0 ? { softBoostRefs } : {}),
      label: 'framing',
    });
  }

  // Observability — when chip dispatch engages, it changes search semantics
  // dramatically (hard filters vs. plain semantic recall). Surface what was
  // detected so operators can verify the user's `{{ chip }}` syntax took
  // effect.
  const hardFilterCount = specs.reduce(
    (n, s) => n + (Array.isArray(s.whereClauses) ? s.whereClauses.length : 0),
    0,
  );
  const boostCount = specs.reduce(
    (n, s) => n + (Array.isArray(s.softBoostRefs) ? s.softBoostRefs.length : 0),
    0,
  );
  console.log(
    `[chip-specs] ${chipSegments.length} chip(s) detected → ${specs.length} sub-quer${specs.length === 1 ? 'y' : 'ies'} (hardFilters=${hardFilterCount}, softBoosts=${boostCount})`,
  );

  return specs;
}

export async function executeParallelSearches(
  subQueries: ReadonlyArray<string | SubQuerySpec>,
  caseId: string | undefined,
  registry: ToolRegistry,
  pushWarning?: (w: { source: string; host?: string; reason?: string; message: string }) => void,
  chatId?: string,
  /** Per-sub-query retrieval cap. Default 50 (the dashboard's value). */
  limitPerSubQuery: number = 50,
): Promise<SubQueryResult[]> {
  // Normalize: plain strings become bare specs so the dispatch body has one shape.
  const specs: SubQuerySpec[] = subQueries.map(s => (typeof s === 'string' ? { query: s } : s));
  const promises = specs.map(async (spec): Promise<SubQueryResult> => {
    const subQuery = spec.query;
    try {
      const searchResult = await registry.execute('query_case_knowledge', {
        query: subQuery,
        ...(caseId ? { caseId } : {}),
        ...(chatId ? { chatId } : {}),
        ...(spec.whereClauses && spec.whereClauses.length > 0 ? { whereClauses: spec.whereClauses } : {}),
        ...(spec.softBoostRefs && spec.softBoostRefs.length > 0 ? { softBoostRefs: spec.softBoostRefs } : {}),
        limit: limitPerSubQuery,
        searchMode: 'hybrid',
      }, pushWarning ? { pushWarning } : undefined);

      if (!searchResult.success) {
        if (searchResult.error && pushWarning) {
          pushWarning({ source: 'query_case_knowledge', reason: 'tool-error', message: searchResult.error });
        }
        return { subQuery, sources: [] };
      }
      if (!searchResult.data?.results) {
        return { subQuery, sources: [] };
      }

      const sources: DeepSearchSource[] = searchResult.data.results.map(
        (r: any) => ({
          text: r.text,
          document: r.document,
          page: r.page,
          score: r.score,
          citation: r.citation,
          citationShort: r.citationShort,
          filingType: r.filingType,
          volumeNumber: r.volumeNumber,
          caseNumber: r.caseNumber,
          filingSlug: r.filingSlug,
          ...pickProvenance(r),
          matchedSubQueries: [subQuery],
        }),
      );

      return { subQuery, sources };
    } catch {
      // Individual sub-query failure — skip it
      return { subQuery, sources: [] };
    }
  });

  return Promise.all(promises);
}

// ---------------------------------------------------------------------------
// 2b. Supplementary Pattern Search (regex fallback for vocabulary mismatch)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may',
  'who', 'did', 'get', 'got', 'him', 'let', 'say', 'she', 'too', 'use',
  'that', 'this', 'with', 'have', 'from', 'they', 'been', 'said', 'each',
  'which', 'their', 'will', 'other', 'about', 'many', 'then', 'them',
  'these', 'some', 'would', 'make', 'like', 'into', 'just', 'over',
  'such', 'take', 'than', 'very', 'what', 'when', 'where', 'does',
  'could', 'should', 'there', 'anywhere', 'someone', 'something',
  'find', 'look', 'check', 'tell', 'show', 'search', 'mention',
  'discuss', 'state', 'record', 'document', 'page', 'case', 'court',
]);

/**
 * Extract distinctive keywords from a query for regex pattern matching.
 * Filters stop words and short words, returns terms likely to appear verbatim
 * in document text.
 */
export function extractPatternKeywords(query: string): string[] {
  // Remove quotes, punctuation, normalize
  const cleaned = query
    .replace(/["""''`]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .toLowerCase();

  const words = cleaned.split(/\s+/).filter(Boolean);

  const keywords: string[] = [];
  for (const word of words) {
    if (word.length < 4) continue;
    if (STOP_WORDS.has(word)) continue;
    // Skip pure numbers unless they look like page refs (4+ digits)
    if (/^\d+$/.test(word) && word.length < 4) continue;
    keywords.push(word);
  }

  // Deduplicate
  return [...new Set(keywords)];
}

/**
 * Run scan_for_pattern with extracted keywords as regex alternation.
 * This guarantees literal text matches even when semantic search fails
 * due to vocabulary mismatch.
 */
export async function executePatternSearch(
  query: string,
  caseId: string | undefined,
  registry: ToolRegistry,
  pushWarning?: (w: { source: string; host?: string; reason?: string; message: string }) => void,
  scopeWhereClauses?: string[],
): Promise<SubQueryResult> {
  const keywords = extractPatternKeywords(query);

  if (keywords.length === 0) {
    return { subQuery: '[pattern search]', sources: [] };
  }

  // Build regex pattern: alternation of keywords (case-insensitive handled by scan_for_pattern)
  // Use word boundaries where possible for precision
  const pattern = keywords.map((kw) => `\\b${kw}\\b`).join('|');

  try {
    const result = await registry.execute('scan_for_pattern', {
      pattern,
      ...(caseId ? { caseId } : {}),
      ...(scopeWhereClauses && scopeWhereClauses.length > 0 ? { whereClauses: scopeWhereClauses } : {}),
      limit: 50,
    }, pushWarning ? { pushWarning } : undefined);

    if (!result.success || !result.data?.results) {
      return { subQuery: '[pattern search]', sources: [] };
    }

    // Convert scan_for_pattern results to DeepSearchSource format
    const sources: DeepSearchSource[] = result.data.results.map((r: any) => ({
      text: r.text,
      document: r.document,
      page: r.page,
      score: 0.65, // Baseline score — reranker will adjust
      citation: r.citation,
      citationShort: r.citationShort,
      filingType: r.filingType,
      volumeNumber: r.volumeNumber,
      caseNumber: r.caseNumber,
      filingSlug: r.filingSlug,
      matchedSubQueries: [`[pattern: ${keywords.join(', ')}]`],
    }));

    return { subQuery: '[pattern search]', sources };
  } catch {
    return { subQuery: '[pattern search]', sources: [] };
  }
}

/**
 * Per-chip pattern search — runs one regex backstop per chip spec, each
 * scoped by that chip's whereClauses. Mirrors the main vector+FTS per-chip
 * dispatch so the regex backstop respects the user's chip scope instead of
 * leaking across the whole corpus. Framing-segment specs run unscoped
 * (today's behaviour) since framing is intentionally broad.
 *
 * For chip specs without a paired intent (`spec.query` is the placeholder
 * "all available evidence"), we skip the pattern search — there are no
 * distinctive keywords to extract.
 */
export async function executePerChipPatternSearches(
  specs: ReadonlyArray<SubQuerySpec>,
  caseId: string | undefined,
  registry: ToolRegistry,
  pushWarning?: (w: { source: string; host?: string; reason?: string; message: string }) => void,
  scopeWhereClauses?: string[],
): Promise<SubQueryResult[]> {
  const promises = specs.map(async (spec): Promise<SubQueryResult> => {
    const keywords = extractPatternKeywords(spec.query);
    if (keywords.length === 0) return { subQuery: `[pattern search:${spec.label ?? ''}]`, sources: [] };

    const pattern = keywords.map((kw) => `\\b${kw}\\b`).join('|');

    try {
      const result = await registry.execute('scan_for_pattern', {
        pattern,
        ...(caseId ? { caseId } : {}),
        ...(() => {
          const merged = [...(spec.whereClauses ?? []), ...(scopeWhereClauses ?? [])];
          return merged.length > 0 ? { whereClauses: merged } : {};
        })(),
        limit: 50,
      }, pushWarning ? { pushWarning } : undefined);

      if (!result.success || !result.data?.results) {
        return { subQuery: `[pattern:${spec.label ?? ''}]`, sources: [] };
      }

      const sources: DeepSearchSource[] = result.data.results.map((r: any) => ({
        text: r.text,
        document: r.document,
        page: r.page,
        score: 0.65,
        citation: r.citation,
        citationShort: r.citationShort,
        filingType: r.filingType,
        volumeNumber: r.volumeNumber,
        caseNumber: r.caseNumber,
        filingSlug: r.filingSlug,
        matchedSubQueries: [`[pattern${spec.label ? ` ${spec.label}` : ''}: ${keywords.join(', ')}]`],
      }));

      return { subQuery: `[pattern:${spec.label ?? ''}]`, sources };
    } catch {
      return { subQuery: `[pattern:${spec.label ?? ''}]`, sources: [] };
    }
  });

  return Promise.all(promises);
}

// ---------------------------------------------------------------------------
// 3. Deduplicate and Merge
// ---------------------------------------------------------------------------

function makeDeduplicationKey(source: DeepSearchSource): string {
  return sourceDedupKey(source.document, source.page, source.text);
}

export async function deduplicateAndMerge(
  subQueryResults: SubQueryResult[],
  originalQuery: string,
  onWarning?: (w: { source: string; host?: string; reason?: string; message: string }) => void,
  /** Optional overrides — `rerankPoolSize` replaces the configured pool cap (MCP presets). */
  mergeOptions?: { rerankPoolSize?: number },
): Promise<{ sources: DeepSearchSource[]; stats: { totalRetrieved: number; uniqueAfterDedup: number; finalAfterRerank: number; rerankPool: number } }> {
  const seen = new Map<string, DeepSearchSource>();
  let totalRetrieved = 0;

  for (const { sources } of subQueryResults) {
    totalRetrieved += sources.length;

    for (const source of sources) {
      const key = makeDeduplicationKey(source);
      const existing = seen.get(key);

      if (existing) {
        // Keep highest score, merge matched sub-queries
        if (source.score > existing.score) {
          existing.score = source.score;
        }
        for (const sq of source.matchedSubQueries) {
          if (!existing.matchedSubQueries.includes(sq)) {
            existing.matchedSubQueries.push(sq);
          }
        }
      } else {
        seen.set(key, { ...source });
      }
    }
  }

  let merged = Array.from(seen.values());
  const uniqueAfterDedup = merged.length;

  // Boost sources found by multiple sub-queries (more relevant)
  for (const source of merged) {
    if (source.matchedSubQueries.length > 1) {
      source.score *= 1 + 0.15 * (source.matchedSubQueries.length - 1);
    }
  }

  // Rerank merged pool against original query. Cap the candidate pool to the
  // configured size FIRST: vLLM scores every document sent (the reranker's
  // top_n only limits what's returned), so prefill cost scales with the pool.
  // Trimming by first-stage score keeps only the most promising candidates —
  // the dominant lever on interactive rerank latency. Master-side: no restart.
  let rerankPool = 0;
  if (merged.length > 0) {
    const poolSize = mergeOptions?.rerankPoolSize && mergeOptions.rerankPoolSize > 0
      ? mergeOptions.rerankPoolSize
      : await getConfig().then((c) => c.rerankPoolSize ?? 150).catch(() => 150);
    if (merged.length > poolSize) {
      merged.sort((a, b) => b.score - a.score);
      merged = merged.slice(0, poolSize);
    }
    rerankPool = merged.length;
    const rerankable = merged as (DeepSearchSource & RerankableResult)[];
    merged = await rerank(originalQuery, rerankable, poolSize, onWarning ? (w) => onWarning({
      source: w.source,
      host: w.host,
      reason: w.reason,
      message: w.message,
    }) : undefined, { interactive: true });
  }

  // Filing-type-aware boost when the user's question is clearly about
  // testimony, a hearing, or a transcript. Without this, a clerk's record
  // — which mentions every hearing date administratively — dominates the
  // top N over the actual transcript that contains the witness's words.
  // Observed 2026-05-27: top 8 of 10 for "May 13 2026 hearing trust fund"
  // were clerk's record pages; the actual Cross-Examination transcript
  // (49 of 73 chunks literally contained "May 13, 2026") didn't make it
  // into the top 10. See docs/TODO-ocr-speedups.md neighbouring discussion.
  const RR_INTENT_RE = /\b(hearing|testimony|testif|deposition|cross[\s-]?examination|direct[\s-]?examination|witness|RR\b|reporter['']?s?\s*record|transcript|stenograph|cite\s+line|line\s*\d{1,4})/i;
  const wantsTranscript = RR_INTENT_RE.test(originalQuery);
  if (wantsTranscript) {
    // Heuristic: a doc is "transcript-like" if its filename or filing type
    // matches RR/Reporter's Record/Transcript patterns. We use filename
    // because documentType has been observed misclassified upstream (a
    // valid RR was tagged as "Motion" during filing-detection in the same
    // dataset that exposed this ranking bug).
    const TRANSCRIPT_FILENAME_RE = /\b(RR|reporter['']?s?\s*record|transcript)\b/i;
    const TRANSCRIPT_FILING_RE = /\b(reporter['']?s?\s*record|reporters_record|transcript|RR)\b/i;
    const TRANSCRIPT_BOOST = 1.35; // empirically chosen — large enough to
                                   // move RR pages past sibling-doc pages
                                   // of similar reranker score, small
                                   // enough that totally-irrelevant RR
                                   // pages can't outrank a strong hit.
    for (const source of merged) {
      const isTranscript =
        // Non-empty speakers is the structural signal — stamped from RR
        // speaker-turn overlap, far more reliable than the filename regex
        // (documentType has been observed misclassified upstream).
        !!source.speakers
        || (source.document && TRANSCRIPT_FILENAME_RE.test(source.document))
        || (source.filingType && TRANSCRIPT_FILING_RE.test(source.filingType));
      if (isTranscript) source.score *= TRANSCRIPT_BOOST;
    }
  }

  // Block-type multipliers (task #13 phase 1c) — applied POST-rerank like
  // the transcript boost above; the reranker itself sees bare text only.
  const TABLE_INTENT_RE = /\b(table|column|row|total|amount|sum|schedule|itemi[sz]ed|list of|index of|how (?:much|many)|\$\s?\d)/i;
  const wantsTable = TABLE_INTENT_RE.test(originalQuery);
  const TABLE_BOOST = 1.2;   // numeric/tabular intent → surface real tables
  const FIGURE_DEMOTE = 0.85; // figure OCR is the noisiest text in the corpus
  // Structure hints (phase 3b): explicit structural asks get HARD boosts —
  // "the table on page 12" pins that page's table; "what did THE COURT
  // say" pins chunks where that speaker actually speaks.
  const hint = extractStructureHint(originalQuery);
  const TABLE_PAGE_BOOST = 2.0;
  const SPEAKER_BOOST = 1.5;
  for (const source of merged) {
    if (source.blockType === 'table' && wantsTable) source.score *= TABLE_BOOST;
    else if (source.blockType === 'figure') source.score *= FIGURE_DEMOTE;
    if (hint.tablePage !== undefined && source.blockType === 'table' && source.page === hint.tablePage) {
      source.score *= TABLE_PAGE_BOOST;
    }
    if (hint.speaker && speakersInclude(source.speakers, hint.speaker)) {
      source.score *= SPEAKER_BOOST;
    }
  }

  // Sort by score descending — needed before the diversity cap below.
  merged.sort((a, b) => b.score - a.score);

  // Per-document diversity cap. Prevents one giant document (typically a
  // clerk's record or a multi-volume RR) from monopolizing the top N
  // when many of its chunks happen to score well. Without this, a doc
  // with 80 high-scoring chunks fills 80 of the top 150 slots and
  // crowds out shorter primary sources.
  //
  // Cap = max(8, ceil(targetN / distinctDocs * 0.4)) per document.
  // Tuned so that on a 4-document case the cap is ~15 chunks/doc, and
  // on a 30-document case it's ~5 — leaving room for every primary
  // source to contribute regardless of overall length.
  if (merged.length > 150) {
    const distinctDocs = new Set(merged.map(s => s.document)).size;
    const perDocCap = Math.max(8, Math.ceil((150 / Math.max(1, distinctDocs)) * 1.2));
    const perDocCount = new Map<string, number>();
    const capped: DeepSearchSource[] = [];
    const overflow: DeepSearchSource[] = [];
    for (const s of merged) {
      const n = perDocCount.get(s.document) ?? 0;
      if (n < perDocCap) {
        perDocCount.set(s.document, n + 1);
        capped.push(s);
      } else {
        overflow.push(s);
      }
      if (capped.length >= 150) break;
    }
    // If capping left us short of 150 (e.g. one-doc case), fill from overflow.
    while (capped.length < 150 && overflow.length > 0) {
      capped.push(overflow.shift()!);
    }
    merged = capped;
  }

  return {
    sources: merged,
    stats: {
      totalRetrieved,
      uniqueAfterDedup,
      finalAfterRerank: merged.length,
      rerankPool,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Report Generation
// ---------------------------------------------------------------------------

const REPORT_SYSTEM_PROMPT = `You are an expert legal research analyst. Generate a comprehensive, well-structured research report based on the provided document excerpts.

## Report Structure

1. **Summary** — 2-3 sentence overview of findings
2. **Findings** — Detailed analysis organized by topic, with citations in brackets (e.g., [2 CR 140], [3 RR 184:12])
3. **Gaps** — What wasn't found or needs further investigation
4. **Legal Significance** — Why these findings matter for the case
5. **Suggested Next Steps** — Actionable follow-up research or actions

## Citation Rules
- Use the exact citation format shown in brackets before each excerpt
- For Clerk's Record: [CaseNumber CR Page] or [CaseNumber Vol CR Page]
- For Reporter's Record: [CaseNumber RR Page:Line] or [CaseNumber Vol RR Page:Line]
- For other documents: use the citation as provided
- Always include the case number when available

## Important
- Base your analysis ONLY on the provided document excerpts
- If certain aspects of the question cannot be answered from the excerpts, say so in the Gaps section
- Be thorough but concise — quality over quantity
- Use markdown formatting for readability`;

/**
 * Closing instruction block. The synthesis prompt must NOT end on the raw
 * excerpt text: with ~150 excerpts in front of it, a model whose final input
 * token is document prose continues the *document* instead of answering it —
 * it emits more excerpt-shaped text, then reconstructs the instruction it
 * expected to find here, then finally writes the report (all of it on the
 * normal text channel, which is how 22K of raw transcript reached a saved
 * answer). Restating the task after the excerpts is what keeps the completion
 * an answer. `report-preamble.ts` is the safety net for when it isn't.
 */
const CONTEXT_CLOSING_INSTRUCTIONS = `## Instructions

The document excerpts above are your evidence — do not repeat, re-list, or quote them back in bulk.

Write the research report now, answering the research question. Start immediately with the "## Summary" heading. Follow the report structure from the system prompt, and cite every factual claim using the exact bracketed citation format shown above each excerpt.`;

/**
 * Prior turns are the easiest thing to crowd a synthesis prompt with: each
 * saved deep-search answer runs tens of thousands of characters and the client
 * replays every one of them. Past this budget the excerpt block loses room and
 * the total input balloons (a 173K-token synthesis call was what produced the
 * prompt-echo above). `generateReportWithRlm` has always capped its own
 * history; the cloud-synthesis paths did not.
 */
const SYNTHESIS_HISTORY_CHAR_CAP = 24000;

/** Shown instead of the answer when synthesis emitted no report at all. The
 *  diverted text is still available in the turn's thoughts trace. */
const NO_REPORT_MESSAGE = `## Synthesis produced no report

The synthesis model returned only echoed context and planning text — no report was written. Nothing was lost: the raw output is in the **Thoughts** section above, and the retrieved sources are listed below.

Re-run the search, or lower the number of sources / shorten the conversation history if this repeats.`;

/** Memory bound while accumulating the trace; the persisted copy is trimmed
 *  further by `capThoughts`. */
const THOUGHTS_TRACE_CAP = 200000;

/** Most-recent-first history section, bounded by {@link SYNTHESIS_HISTORY_CHAR_CAP}. */
function buildHistorySection(
  history: ConversationTurn[] | undefined,
  followUpNote: string,
): string {
  if (!history || history.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    const line = `**${t.role === 'user' ? 'User' : 'Assistant'}:** ${t.content}`;
    if (used + line.length > SYNTHESIS_HISTORY_CHAR_CAP && lines.length > 0) {
      dropped = i + 1;
      break;
    }
    lines.unshift(line);
    used += line.length;
  }
  const elision = dropped > 0
    ? `_(${dropped} earlier turn${dropped === 1 ? '' : 's'} omitted to stay within the context budget.)_\n\n`
    : '';
  return `## Previous Conversation\n${elision}${lines.join('\n\n')}\n\n---\n\n${followUpNote}\n\n`;
}

/**
 * Anthropic models that run adaptive thinking with the thinking stream
 * *omitted* by default (Fable 5 / Opus 4.7 / 4.8). At high effort these can
 * spend the entire `max_tokens` budget on invisible reasoning and emit no
 * visible answer — a blank report. Only these models need the scaled budget
 * floor and empty-completion retry below; every other model (older Anthropic,
 * OpenAI, Ollama, Groq) is left on its caller-supplied budget so its behavior
 * and output caps are unchanged.
 */
function isAdaptiveThinkingModel(model: string | undefined): boolean {
  return supportsAdaptiveEffort(model);
}

/** Token budget for synthesis. Adaptive-thinking models get a floor scaled by
 *  effort so thinking can't starve the written answer; others pass through. */
function thinkingBudget(
  maxTokens: number | undefined,
  thinking: boolean | undefined,
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  model: string | undefined,
): number {
  const base = maxTokens ?? 16384;
  if (!thinking || !isAdaptiveThinkingModel(model)) return base;
  const floor = (effort === 'max' || effort === 'xhigh') ? 48000
    : effort === 'high' ? 32000
    : 24000;
  return Math.max(base, floor);
}

export async function generateReport(
  query: string,
  decomposition: DecompositionResult,
  sources: DeepSearchSource[],
  options?: { provider?: string; model?: string; history?: ConversationTurn[]; workflowContext?: string; thinking?: boolean; maxTokens?: number; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; signal?: AbortSignal; onToken?: (text: string) => void; onThinking?: (text: string) => void; onThoughts?: (text: string) => void; onProgress?: (p: DeepSearchProgress) => void },
): Promise<string> {
  if (sources.length === 0) {
    return '## No Results Found\n\nThe deep search did not find any relevant document excerpts for your query. Try rephrasing your question or broadening the search scope.';
  }

  // Build context from sources — use large context window for deep search
  const contextChunks = sources.map((s) => ({
    text: s.text,
    documentName: s.document,
    pageNumber: s.page,
    citation: s.citation || s.citationShort || `${s.document}, p.${s.page}`,
    speakers: s.speakers,
    tableMarkdown: s.tableMarkdown,
  }));

  // Unified builder: skip-not-break on budget overflow + per-block cap
  const { contextBlock, totalChars } = buildCiteContext(
    contextChunks.map(c => ({ text: c.text, document: '', page: c.pageNumber, citation: c.citation, speakers: c.speakers, tableMarkdown: c.tableMarkdown })),
    { maxTotalChars: 120000 },
  );

  // Build conversation history section if follow-up
  const historySection = buildHistorySection(
    options?.history,
    'The user is now asking a follow-up question. Use the conversation above as context — build on what was already discussed, don\'t repeat prior findings, and focus on answering the new question. If the new query references specific documents or pages, focus your analysis there.',
  );

  const workflowSection = options?.workflowContext
    ? `## Active Workflow Context\n\n${options.workflowContext}\n\n`
    : '';

  const userContent = `${historySection}${workflowSection}## Research Question
${query}

## Sub-Questions Investigated
${decomposition.subQueries.map((sq, i) => `${i + 1}. ${sq}`).join('\n')}

## Research Intent
${decomposition.intent}

## Document Excerpts (${sources.length} sources)

${contextBlock}

---

${CONTEXT_CLOSING_INSTRUCTIONS}`;

  try {
    // When the caller wants live tokens (deep-search route does), bypass the
    // buffered callLLM helper and drive streamAI directly so the user sees
    // the report appear word-by-word instead of after a 60-300s wait.
    if (options?.onToken || options?.onThinking) {
      const resolved = (options?.provider && options?.model)
        ? { provider: options.provider as AIProviderKey, model: options.model }
        : await getAvailableProvider();
      const runStream = async (over: { thinking?: boolean; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; maxTokens?: number }): Promise<string> => {
        // Everything the model emits on the text channel goes through the
        // preamble splitter: `onToken` (the answer channel) must only ever
        // receive report prose, and any echoed context / out-loud planning in
        // front of it is diverted to the thoughts channel instead of being
        // stranded in the saved answer.
        const splitter = createPreambleSplitter({
          onToken: options.onToken,
          onThoughts: options.onThoughts,
        });
        let raw = '';
        for await (const event of streamAI({
          provider: resolved.provider,
          model: resolved.model,
          messages: [
            { role: 'system', content: REPORT_SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          maxTokens: over.maxTokens ?? options?.maxTokens ?? 16384,
          temperature: 0.3,
          thinking: over.thinking,
          effort: over.effort ?? options?.effort,
          signal: options?.signal,
        })) {
          if (event.type === 'token') {
            raw += event.text;
            splitter.push(event.text);
          } else if (event.type === 'thinking' && options.onThinking) {
            options.onThinking(event.text);
          } else if (event.type === 'done') {
            // streamAI's done event carries the full content as a fallback for
            // providers that don't yield per-token (e.g. error fallback).
            if (!raw && event.content) {
              raw = event.content;
              splitter.push(event.content);
            }
          }
        }
        return splitter.finish();
      };

      // Adaptive thinking (Fable 5 / Opus 4.7+) spends max_tokens on *omitted*
      // reasoning before writing. Deeper effort needs more headroom or the
      // visible answer is starved to nothing (a blank report — what happens at
      // effort=xhigh with the default 16k budget). Give the model room to think
      // at the chosen effort *and* write the report. (Streaming, so a large
      // ceiling is safe.)
      const effMax = thinkingBudget(options?.maxTokens, options?.thinking, options?.effort, resolved.model);

      let split = await runStream({ thinking: options?.thinking, maxTokens: effMax });
      // Safety net: if it emits NOTHING AT ALL, the model spent its whole
      // budget on omitted reasoning — retry once with more headroom, keeping
      // thinking and the user's effort on (we don't silently downgrade the
      // requested reasoning depth). An empty report with a non-empty trace is
      // a different failure (the model wrote, but wrote preamble instead of a
      // report) and a second identical call would only burn another few
      // minutes on the same prompt.
      if (
        !split.report.trim() && !split.thoughts.trim()
        && options?.thinking && isAdaptiveThinkingModel(resolved.model)
      ) {
        console.warn('[Deep Search] synthesis returned empty content — retrying with more headroom (thinking kept on)', {
          provider: resolved.provider,
          model: resolved.model,
          effort: options?.effort,
        });
        split = await runStream({ thinking: options?.thinking, maxTokens: Math.max(effMax, 64000) });
      }
      if (!split.report.trim()) {
        // The model produced text but none of it was a report (it echoed the
        // context and never got to the answer). Say so — a context dump on
        // screen was the old behavior and it read like a rendering bug.
        console.error('[Deep Search] synthesis produced no report', {
          provider: resolved.provider,
          model: resolved.model,
          sources: sources.length,
          traceChars: split.thoughts.length,
        });
        return NO_REPORT_MESSAGE;
      }
      return split.report;
    }
    const effMaxBuf = thinkingBudget(options?.maxTokens, options?.thinking, options?.effort, options?.model);
    const bufferedOpts = {
      temperature: 0.3,
      provider: options?.provider,
      model: options?.model,
      effort: options?.effort,
      signal: options?.signal,
    };
    let result = await callLLM(REPORT_SYSTEM_PROMPT, userContent, { ...bufferedOpts, maxTokens: effMaxBuf, thinking: options?.thinking });
    // Same empty-completion safety net as the streaming branch (adaptive
    // models only): keep thinking on, retry once with more headroom.
    if (!result.trim() && options?.thinking && isAdaptiveThinkingModel(options?.model)) {
      console.warn('[Deep Search] synthesis (buffered) returned empty content — retrying with more headroom (thinking kept on)', {
        provider: options?.provider,
        model: options?.model,
        effort: options?.effort,
      });
      result = await callLLM(REPORT_SYSTEM_PROMPT, userContent, { ...bufferedOpts, maxTokens: Math.max(effMaxBuf, 64000), thinking: options?.thinking });
    }
    // Same preamble split as the streaming branch — a buffered completion can
    // carry the identical echo, it just arrives all at once.
    const split = splitReportPreamble(result);
    if (split.thoughts) options?.onThoughts?.(split.thoughts);
    if (!split.report.trim()) {
      console.error('[Deep Search] synthesis (buffered) produced no report — output was prompt echo / planning only', {
        provider: options?.provider,
        model: options?.model,
        sources: sources.length,
      });
      return NO_REPORT_MESSAGE;
    }
    return split.report;
  } catch (err) {
    // Surface the real error — the old bare catch hid it and only returned
    // the "Report generation failed" fallback, making every such failure
    // indistinguishable from every other (400 vs timeout vs auth vs …).
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    console.error('[Deep Search] generateReport failed', {
      provider: options?.provider,
      model: options?.model,
      thinking: options?.thinking,
      sources: sources.length,
      contextChars: totalChars,
      status,
      error: msg,
    });
    return `## Deep Search Results\n\nReport generation failed${status ? ` (${status})` : ''}: ${msg}\n\nFound ${sources.length} relevant sources — review the sources panel below.`;
  }
}

// ---------------------------------------------------------------------------
// 4b. Multi-Pass Report Generation
// ---------------------------------------------------------------------------

interface ReportOutline {
  summary: string;
  findingsSections: Array<{
    heading: string;
    instructions: string;
    keyCitations?: string[];
  }>;
  gaps: string;
  legalSignificance: string;
  nextSteps: string[];
}

const OUTLINE_SYSTEM_PROMPT = `You are an expert legal research analyst planning a research report.

Given the research question, sub-questions, and the full set of document excerpts, produce a structured outline AND draft the short sections inline. The detailed Findings sections will be expanded in a second pass — do NOT write Findings prose here, only plan the subsections.

Respond with JSON shaped as:
{
  "summary": "2-3 sentence overview of overall findings (write this fully, citations allowed in brackets)",
  "findingsSections": [
    {
      "heading": "Topic-focused subsection title (e.g. 'Evidence of Hiring an Appraiser')",
      "instructions": "What this subsection must cover, what to look for in the excerpts, what conclusion to draw if any",
      "keyCitations": ["[2 CR 140]", "[3 RR 184:12]"]
    }
  ],
  "gaps": "1 paragraph: what wasn't found or needs further investigation (write this fully)",
  "legalSignificance": "1-2 paragraphs: why these findings matter (write this fully, citations allowed)",
  "nextSteps": ["actionable step 1", "actionable step 2", "..."]
}

Rules:
- 3-7 findingsSections, organized by distinct topic — not by sub-query
- Each findingsSection must be a meaningfully different angle (no overlap)
- summary, gaps, legalSignificance must be COMPLETE prose, not placeholders
- Use the citation format from the excerpts
- Base everything ONLY on the provided excerpts`;

const SECTION_SYSTEM_PROMPT = `You are writing ONE subsection of the Findings portion of a legal research report.

You are given:
- The original research question
- The full report outline (so you know what other subsections cover — DO NOT duplicate their content)
- All relevant document excerpts with citations
- This subsection's heading and specific instructions

Write ONLY the body content of THIS subsection. Do NOT include the heading (it will be added by the orchestrator). Do NOT write a preamble like "In this section we will...". Start directly with the analysis.

Rules:
- Use markdown citations in brackets, exact format from excerpts (e.g. [2 CR 140], [3 RR 184:12])
- Quote pertinent language directly when material
- Be analytical, not just descriptive — connect excerpts to the question
- This subsection will NOT be truncated, so be thorough; stop when the analysis is complete, not at an arbitrary length
- Base your analysis ONLY on the provided excerpts`;

function buildSourceContext(sources: DeepSearchSource[], maxChars = 120000): { contextBlock: string; chars: number } {
  const ctx = buildCiteContext(sources, { maxTotalChars: maxChars });
  return { contextBlock: ctx.contextBlock, chars: ctx.totalChars };
}

export async function generateReportMultiPass(
  query: string,
  decomposition: DecompositionResult,
  sources: DeepSearchSource[],
  options?: { provider?: string; model?: string; history?: ConversationTurn[]; workflowContext?: string; thinking?: boolean; maxTokens?: number; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; signal?: AbortSignal; onToken?: (text: string) => void; onThinking?: (text: string) => void; onThoughts?: (text: string) => void; onProgress?: (p: DeepSearchProgress) => void },
): Promise<string> {
  const progress = options?.onProgress || (() => {});
  if (sources.length === 0) {
    return '## No Results Found\n\nThe deep search did not find any relevant document excerpts for your query. Try rephrasing your question or broadening the search scope.';
  }

  const { contextBlock } = buildSourceContext(sources);

  const historySection = buildHistorySection(
    options?.history,
    'The user is now asking a follow-up question. Build on the conversation above.',
  );

  const workflowSection = options?.workflowContext
    ? `## Active Workflow Context\n\n${options.workflowContext}\n\n`
    : '';

  // Same closing-instruction rule as the single-pass path: never end the
  // prompt on raw excerpt text (see CONTEXT_CLOSING_INSTRUCTIONS).
  const baseUserContent = `${historySection}${workflowSection}## Research Question
${query}

## Sub-Questions Investigated
${decomposition.subQueries.map((sq, i) => `${i + 1}. ${sq}`).join('\n')}

## Research Intent
${decomposition.intent}

## Document Excerpts (${sources.length} sources)

${contextBlock}

---

The excerpts above are your evidence — do not repeat or quote them back in bulk. Work from them to produce what is asked for below.`;

  // Stage 1: outline + short sections
  progress({ step: 'generating', message: 'Stage 1/2: drafting outline + summary + gaps + significance...' });
  let outline: ReportOutline;
  try {
    outline = await callLLMJson<ReportOutline>(
      OUTLINE_SYSTEM_PROMPT,
      baseUserContent,
      {
        maxTokens: 4096,
        temperature: 0.2,
        provider: options?.provider,
        model: options?.model,
        thinking: options?.thinking,
        effort: options?.effort,
        signal: options?.signal,
        jsonSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            findingsSections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  heading: { type: 'string' },
                  instructions: { type: 'string' },
                  keyCitations: { type: 'array', items: { type: 'string' } },
                },
                required: ['heading', 'instructions'],
              },
              minItems: 1,
              maxItems: 8,
            },
            gaps: { type: 'string' },
            legalSignificance: { type: 'string' },
            nextSteps: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary', 'findingsSections', 'gaps', 'legalSignificance', 'nextSteps'],
        },
      },
    );
  } catch (err) {
    console.error('[Deep Search] Outline pass failed, falling back to single-pass', err);
    return generateReport(query, decomposition, sources, options);
  }

  if (!outline.findingsSections || outline.findingsSections.length === 0) {
    return generateReport(query, decomposition, sources, options);
  }

  const emit = (text: string) => { options?.onToken?.(text); };
  let full = '';
  const append = (text: string) => { full += text; emit(text); };

  // Summary (already drafted)
  append(`## Summary\n\n${outline.summary}\n\n`);

  // Findings — stream each subsection as its own LLM call
  append(`## Findings\n\n`);

  const outlineSummary = outline.findingsSections
    .map((s, i) => `${i + 1}. **${s.heading}** — ${s.instructions}`)
    .join('\n');

  const resolved = (options?.provider && options?.model)
    ? { provider: options.provider as AIProviderKey, model: options.model }
    : await getAvailableProvider();

  const perSectionMaxTokens = Math.min(options?.maxTokens ?? 8192, 8192);

  for (let i = 0; i < outline.findingsSections.length; i++) {
    if (options?.signal?.aborted) {
      const e = new Error('Deep search aborted by client');
      e.name = 'AbortError';
      throw e;
    }

    const section = outline.findingsSections[i];
    progress({
      step: 'generating',
      message: `Stage 2/2: writing section ${i + 1}/${outline.findingsSections.length} — "${section.heading}"`,
    });
    append(`### ${section.heading}\n\n`);

    // Split the user content at the shared/varying boundary: baseUserContent
    // is byte-identical across ALL section calls, so a cache breakpoint on
    // it (task #15) writes the ~32K-token excerpt prefix once and re-reads
    // it per section at 0.1×. The per-section suffix stays outside the
    // breakpoint. Non-Anthropic providers use the joined string unchanged.
    const sectionSuffix = `

## Full Report Outline (for context — do NOT duplicate other subsections)
${outlineSummary}

## Your Subsection
**Heading:** ${section.heading}
**Instructions:** ${section.instructions}
${section.keyCitations && section.keyCitations.length > 0 ? `**Suggested citations to focus on:** ${section.keyCitations.join(', ')}` : ''}

Write the body of this subsection now. Do not include the heading.`;
    const sectionUserContent = `${baseUserContent}${sectionSuffix}`;

    try {
      let sectionContent = '';
      for await (const event of streamAI({
        provider: resolved.provider,
        model: resolved.model,
        messages: [
          { role: 'system', content: SECTION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: sectionUserContent,
            cacheBlocks: [
              { text: baseUserContent, cache: true },
              { text: sectionSuffix },
            ],
          },
        ],
        maxTokens: perSectionMaxTokens,
        temperature: 0.3,
        thinking: options?.thinking,
        effort: options?.effort,
        signal: options?.signal,
      })) {
        if (event.type === 'token') {
          sectionContent += event.text;
          emit(event.text);
        } else if (event.type === 'thinking' && options?.onThinking) {
          options.onThinking(event.text);
        } else if (event.type === 'done' && !sectionContent && event.content) {
          sectionContent = event.content;
          emit(event.content);
        }
      }
      full += sectionContent;
      append(`\n\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      append(`_Section generation failed: ${msg}_\n\n`);
    }
  }

  // Short sections (already drafted in stage 1)
  append(`## Gaps\n\n${outline.gaps}\n\n`);
  append(`## Legal Significance\n\n${outline.legalSignificance}\n\n`);
  append(`## Suggested Next Steps\n\n`);
  for (const step of outline.nextSteps) {
    append(`- ${step}\n`);
  }

  return full;
}

// ---------------------------------------------------------------------------
// 4b. RLM Report Generation — recursive tool-use synthesis
// ---------------------------------------------------------------------------

const RLM_SYSTEM_PROMPT = `You are an evidence-gathering assistant. The user has a research question. Your job is to call the query_case_knowledge tool 1-3 times to fetch any additional excerpts you think are needed beyond the initial set already in your context. Do NOT write a full report — that's the next stage's job. Once you have enough evidence, respond briefly (1-2 sentences) confirming you're done.

Strategy:
1. Read the user's research question and the initial excerpts.
2. Identify aspects that are under-covered by the initial set.
3. Call query_case_knowledge with focused sub-queries (under 20 words each). Up to 3 calls.
4. Keep limit ≤ 8 per call — your 32K context fills fast with chunks. Prefer focused sub-queries over big batches.
5. For RELATIONSHIP or LINEAGE questions ("what connects X and Y", "amendment history of this motion", "every motion this judge handled"), use query_case_graph instead of/before query_case_knowledge — it walks the case's structural graph. It needs a motion id or person id (take one from a citation or a query chip; never invent ids), and returns motion ids + titles, which you can then read with query_case_knowledge.
6. When done, reply with one short sentence like "Sufficient evidence gathered — N additional aspects retrieved." Do not write Findings, Summary, or any report sections.`;

// Per-call cap on tool-result chunks. Even if the model asks for more, the
// executor enforces this — round 2 of the tool loop would otherwise pull
// 4 × 20 = 80 chunks back into context and blow past 32K.
const RLM_TOOL_LIMIT_CAP = 8;
// Each chunk is capped at this many chars in the model-facing tool result.
// Below the cap the chunk passes through unchanged; above, we truncate and
// append a marker so the model knows there's more if it re-queries narrowly.
// The full chunk still flows to the source list (the panel/UI), this only
// trims the RLM-facing string.
const RLM_TOOL_CHUNK_CHAR_CAP = 600;

const RLM_TOOLS: RlmToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'query_case_knowledge',
      description:
        'Semantic + keyword search over the case\'s indexed court documents. Returns ranked excerpts with citations. Use a short, focused sub-query (under 20 words). Excerpts are capped at ~600 chars each in the tool result.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Sub-query to search for. Be specific. Under 20 words.' },
          limit: { type: 'integer', description: 'Max excerpts to return. Default 8, hard cap 8.', default: RLM_TOOL_LIMIT_CAP },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_case_graph',
      description:
        'Structural lookups over the case knowledge graph (relationships, NOT document text). Use for lineage/connection questions semantic search misses. operation="amendment-lineage" (needs motionId) returns a motion\'s amendment history; "related-motions" (needs motionId) returns same-case motions sharing its judge/movant; "motions-by-person" (needs personId, optional role) lists motions a person appears in. Returns motion ids + titles — then call query_case_knowledge to read the text of any motion you want excerpts from. A motionId/personId must come from a citation or a query chip; do not invent ids.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['amendment-lineage', 'related-motions', 'motions-by-person'], description: 'Which structural traversal to run.' },
          motionId: { type: 'string', description: 'Motion id (amendment-lineage / related-motions).' },
          personId: { type: 'string', description: 'Person id (motions-by-person).' },
          role: { type: 'string', enum: ['judge', 'movant', 'respondent'], description: 'Optional role filter for motions-by-person.' },
        },
        required: ['operation'],
      },
    },
  },
];

/**
 * Best-effort extraction of case-id values from the inherited chip where-clauses
 * (SQL like `case_id IN ('a','b')` / `case_id = 'a'`) so graph lookups can be
 * scoped to the user's named cases. Returns [] when no case predicate is present
 * (e.g. filing-ref-only chips) — the graph tool is still fan-out-bounded.
 */
function caseIdsFromWhereClauses(whereClauses?: string[]): string[] {
  if (!whereClauses || whereClauses.length === 0) return [];
  const ids = new Set<string>();
  const joined = whereClauses.join(' ');
  const clauseRe = /case_id\s*(?:=|IN)\s*(\([^)]*\)|'[^']*')/gi;
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(joined)) !== null) {
    const idRe = /'([^']+)'/g;
    let im: RegExpExecArray | null;
    while ((im = idRe.exec(m[1])) !== null) ids.add(im[1]);
  }
  return [...ids];
}

export interface RlmEvidenceRoundsOptions {
  caseId?: string;
  chatId?: string;
  history?: ConversationTurn[];
  workflowContext?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onProgress?: (p: DeepSearchProgress) => void;
  pushWarning?: (w: { source: string; host?: string; reason?: string; message: string }) => void;
  maxRounds?: number;
  /**
   * Inherited retrieval scope from the composer's filter chips. Every
   * query_case_knowledge tool call the RLM agent makes during this run
   * inherits these where-clauses so follow-up evidence-fetches stay
   * inside the user's named chip refs (e.g. just that filing / just those
   * four cases) rather than reaching corpus-wide. Single string per entry;
   * already SQL-escaped at the call site by extractFieldFilters.
   */
  inheritedWhereClauses?: string[];
  /**
   * Called when a tool-use round completes (after its tool results are in)
   * with the sources that round discovered and a one-line note describing
   * what the model asked for. Used by the MCP evidence engine to stream
   * evidence per round; the dashboard path leaves it unset.
   */
  onRound?: (info: { round: number; sources: DeepSearchSource[]; note: string; toolCalls: number }) => void;
}

export interface RlmEvidenceRoundsResult {
  /** The model's closing narration (never a report — the prompt forbids it). */
  finalText: string;
  extraSources: DeepSearchSource[];
  /** 1-based RLM round in which each `extraSources[i]` was discovered. */
  roundOf: number[];
  host: string | null;
  model: string;
  rounds: number;
  toolCalls: number;
  /** One note per tool-use round, plus the closing narration when non-empty. */
  notes: string[];
}

/**
 * Drive the RLM evidence-gathering loop (query_case_knowledge /
 * query_case_graph tool calls against `registry`) and return what it found.
 * Writes no prose: the model's own closing text is returned as `finalText`
 * for callers that want the narration, and `generateReportWithRlm` is the
 * dashboard-facing wrapper that has always exposed it as `report`.
 */
export async function runRlmEvidenceRounds(
  query: string,
  decomposition: DecompositionResult,
  initialSources: DeepSearchSource[],
  registry: ToolRegistry,
  options: RlmEvidenceRoundsOptions = {},
): Promise<RlmEvidenceRoundsResult> {
  const emit = options.onProgress || (() => {});
  const extraSources: DeepSearchSource[] = [];
  const roundOf: number[] = [];
  // Round bookkeeping for the evidence engine. `runRlmWithTools` yields the
  // tool-call event before it invokes `executeTool`, so the round observed
  // in the event loop below is current when the executor pushes sources.
  let currentRound = 0;
  let toolCallCount = 0;
  const roundLines = new Map<number, string[]>();
  const roundSourceStart = new Map<number, number>();
  const notes: string[] = [];
  const closeRound = (round: number) => {
    if (round <= 0 || !roundLines.has(round)) return;
    const note = `rlm round ${round}: ${roundLines.get(round)!.join('; ')}`;
    notes.push(note);
    const from = roundSourceStart.get(round) ?? extraSources.length;
    options.onRound?.({ round, sources: extraSources.slice(from), note, toolCalls: roundLines.get(round)!.length });
    roundLines.delete(round);
  };
  // Full-text keys — a slice(0,60) key collided on header-repeated table
  // fragments exactly like the main dedup bug (task #13 phase 0a).
  const seenKeys = new Set(initialSources.map(s => sourceDedupKey(s.document, s.page, s.text)));

  // Initial context (same shape as generateReport but smaller — leave room
  // for recursive fetches).
  let totalChars = 0;
  // The RLM is an evidence GATHERER — it fetches more excerpts via tools, so
  // the seed must leave room inside the model's context window for those tool
  // results plus the final answer. A 60K-char seed (~18K tokens) nearly filled
  // the 32K window, so every tool result got trimmed and the model looped on
  // the same query without ever synthesizing (see logs/dashboard.log, 2026-06-08).
  // Cap both the seed total and each individual excerpt so the recursive fetches
  // have room.
  const maxChars = 30000;
  const RLM_SEED_CHUNK_CHAR_CAP = 1500;
  const seedCtx = buildCiteContext(initialSources, {
    maxTotalChars: maxChars,
    perBlockCap: RLM_SEED_CHUNK_CHAR_CAP,
  });
  const contextBlock = seedCtx.contextBlock;
  totalChars = seedCtx.totalChars;

  // Cap prior-conversation context so it can't crowd out the user's question
  // (incl. long pasted text) and the seed excerpts in the 40K RLM window. The
  // RLM re-fetches anything it needs via tools, so older turns are the safest
  // thing to bound. Keep the most RECENT turns (slice from the end).
  const HISTORY_CHAR_CAP = 12000;
  let historySection = '';
  if (options.history && options.history.length > 0) {
    const lines: string[] = [];
    let used = 0;
    for (let i = options.history.length - 1; i >= 0; i--) {
      const t = options.history[i];
      const line = `**${t.role === 'user' ? 'User' : 'Assistant'}:** ${t.content}`;
      if (used + line.length > HISTORY_CHAR_CAP && lines.length > 0) break;
      lines.unshift(line);
      used += line.length;
    }
    historySection = `## Previous Conversation\n${lines.join('\n\n')}\n\n---\n\n`;
  }
  const workflowSection = options.workflowContext ? `## Active Workflow Context\n\n${options.workflowContext}\n\n` : '';

  const userContent = `${historySection}${workflowSection}## Research Question
${query}

## Sub-Questions Investigated
${decomposition.subQueries.map((sq, i) => `${i + 1}. ${sq}`).join('\n')}

## Research Intent
${decomposition.intent}

## Initial Document Excerpts (${initialSources.length} sources)

${contextBlock}

You are in evidence-gathering mode. Call query_case_knowledge for any aspects under-covered above. Do NOT write a report — the next stage handles synthesis.`;

  const executeTool = async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; content: string; preview?: string; chunkCount?: number }> => {
    // Structural graph lookups (relationships/lineage). Returns motion metadata,
    // not document text, so it's small and skips the chunk-char cap. Scoped to
    // the user's chip cases when those are case refs.
    if (toolName === 'query_case_graph') {
      const caseScope = caseIdsFromWhereClauses(options.inheritedWhereClauses);
      const gArgs: Record<string, unknown> = {
        operation: args.operation,
        ...(typeof args.motionId === 'string' ? { motionId: args.motionId } : {}),
        ...(typeof args.personId === 'string' ? { personId: args.personId } : {}),
        ...(typeof args.role === 'string' ? { role: args.role } : {}),
        ...(caseScope.length > 0 ? { caseScope } : {}),
        limit: RLM_TOOL_LIMIT_CAP,
      };
      try {
        const gres = await registry.execute('query_case_graph', gArgs);
        if (!gres.success || !gres.data) {
          return { ok: false, content: `Graph lookup failed: ${gres.error || 'empty'}`, chunkCount: 0 };
        }
        const nodes = ((gres.data as { nodes?: Array<{ id: string; title: string; revisionSeq: number | null; relation: string }> }).nodes) ?? [];
        const op = (gres.data as { operation?: string }).operation ?? args.operation;
        if (nodes.length === 0) {
          return { ok: true, content: `No structurally-related motions found for ${op}.`, preview: `graph:${op} 0`, chunkCount: 0 };
        }
        const lines = nodes.slice(0, RLM_TOOL_LIMIT_CAP).map((n) =>
          `- motion ${n.id}${n.revisionSeq != null ? ` (rev ${n.revisionSeq})` : ''}: ${n.title} — ${n.relation}`,
        ).join('\n');
        console.log(`[RLM tool] query_case_graph op=${op} nodes=${nodes.length}`);
        return {
          ok: true,
          content: `Structural results (${op}) — call query_case_knowledge to read any of these:\n${lines}`,
          preview: `graph:${op} ${nodes.length}`,
          chunkCount: nodes.length,
        };
      } catch (err) {
        return { ok: false, content: `Graph tool error: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    if (toolName !== 'query_case_knowledge') {
      return { ok: false, content: `Unknown tool: ${toolName}` };
    }
    const subQuery = typeof args.query === 'string' ? args.query : '';
    if (!subQuery) return { ok: false, content: 'Missing query argument' };
    // Honor the model's request only up to the hard cap. The cap exists
    // because tool results accumulate across rounds and saturate the 32K
    // context window. The full ranked list still hits the source panel —
    // this only constrains what's fed back to the RLM.
    const requestedLimit = typeof args.limit === 'number' ? args.limit : RLM_TOOL_LIMIT_CAP;
    const limit = Math.max(1, Math.min(requestedLimit, RLM_TOOL_LIMIT_CAP));
    if (requestedLimit > RLM_TOOL_LIMIT_CAP) {
      console.log(`[RLM tool] query_case_knowledge cap requestedLimit=${requestedLimit} → ${limit} (RLM_TOOL_LIMIT_CAP)`);
    }
    try {
      const res = await registry.execute(
        'query_case_knowledge',
        {
          query: subQuery,
          ...(options.caseId ? { caseId: options.caseId } : {}),
          ...(options.chatId ? { chatId: options.chatId } : {}),
          ...(options.inheritedWhereClauses && options.inheritedWhereClauses.length > 0
            ? { whereClauses: options.inheritedWhereClauses }
            : {}),
          limit,
          searchMode: 'hybrid',
        },
        options.pushWarning ? { pushWarning: options.pushWarning } : undefined,
      );
      if (!res.success || !res.data?.results) {
        return { ok: false, content: `No results: ${res.error || 'empty'}`, chunkCount: 0 };
      }
      const results = res.data.results as Array<any>;
      // Accumulate any new sources into the returned report's source list.
      const newSources: DeepSearchSource[] = [];
      for (const r of results) {
        const key = sourceDedupKey(r.document, r.page, r.text || '');
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const src: DeepSearchSource = {
          text: r.text,
          document: r.document,
          page: r.page,
          score: r.score,
          citation: r.citation,
          citationShort: r.citationShort,
          filingType: r.filingType,
          volumeNumber: r.volumeNumber,
          caseNumber: r.caseNumber,
          filingSlug: r.filingSlug,
          matchedSubQueries: [`[rlm] ${subQuery}`],
        };
        newSources.push(src);
        extraSources.push(src);
        roundOf.push(currentRound);
      }
      // Build the tool-result content for the model: top excerpts with cites.
      // Truncate each chunk to RLM_TOOL_CHUNK_CHAR_CAP to keep the per-round
      // context cost bounded. The full text is still in the source list for
      // the panel/citations — this only constrains the RLM-facing string.
      let truncatedCount = 0;
      const content = results.slice(0, limit).map((r: any) => {
        const rawText: string = typeof r.text === 'string' ? r.text : '';
        const t = truncateBlock(rawText, RLM_TOOL_CHUNK_CHAR_CAP);
        if (t.truncated) truncatedCount++;
        return `[${citeOf(r)}]\n${t.text}`;
      }).join('\n\n---\n\n') || 'No matches.';
      if (truncatedCount > 0) {
        console.log(`[RLM tool] query_case_knowledge truncated ${truncatedCount}/${results.length} chunks to ${RLM_TOOL_CHUNK_CHAR_CAP} chars`);
      }
      console.log(`[RLM tool] query_case_knowledge content chars=${content.length} (limit=${limit}, returned=${results.slice(0, limit).length}, truncated=${truncatedCount})`);
      return {
        ok: true,
        content,
        preview: `${results.length} excerpts for "${subQuery.slice(0, 60)}"`,
        chunkCount: results.length,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, content: `Tool error: ${msg}` };
    }
  };

  let host: string | null = null;
  let finalReport = '';
  let roundsSeen = 0;
  const messages = [
    { role: 'system' as const, content: RLM_SYSTEM_PROMPT },
    { role: 'user' as const, content: userContent },
  ];

  // RLM context window is 40K (Qwen3-8B native max_position_embeddings=40960, fp8 KV cache).
  // vLLM enforces prompt_tokens + max_tokens <= max_model_len; if we pass
  // through a large user-facing maxTokens (e.g. 32768 from the UI for cloud
  // models) the prompt has zero room and vLLM 400s. Cap output at 4096 —
  // synthesis reports are well under that, and tool-call rounds are tiny.
  const RLM_MAX_OUTPUT_TOKENS = 4096;
  const rlmMaxTokens = Math.min(options.maxTokens ?? RLM_MAX_OUTPUT_TOKENS, RLM_MAX_OUTPUT_TOKENS);

  for await (const ev of runRlmWithTools({
    messages,
    tools: RLM_TOOLS,
    executeTool,
    maxRounds: options.maxRounds ?? 4,
    maxTokens: rlmMaxTokens,
    temperature: 0.3,
    signal: options.signal,
  })) {
    if (ev.type === 'start') {
      host = ev.host;
      emit({
        step: 'rlm-synthesis',
        message: `Routing synthesis through ss-rlm on ${ev.host}…`,
        rlmHost: ev.host,
        rlmModel: ev.model,
      });
    } else if (ev.type === 'tool-call') {
      const sq = typeof ev.args.query === 'string' ? ev.args.query : '';
      if (ev.round !== currentRound) {
        closeRound(currentRound);
        currentRound = ev.round;
        roundsSeen = Math.max(roundsSeen, ev.round);
        roundSourceStart.set(ev.round, extraSources.length);
        roundLines.set(ev.round, []);
      }
      toolCallCount++;
      const argPreview = ev.toolName === 'query_case_knowledge'
        ? `"${sq.slice(0, 80)}"`
        : String(ev.args.operation ?? '');
      roundLines.get(ev.round)!.push(`${ev.toolName}(${argPreview})`);
      emit({
        step: 'rlm-subcall',
        message: `RLM round ${ev.round}: query_case_knowledge("${sq.slice(0, 80)}")`,
        rlmHost: host || undefined,
        rlmModel: RLM_MODEL_ID,
        rlmRound: ev.round,
        rlmSubQuery: sq,
      });
    } else if (ev.type === 'tool-result') {
      const lines = roundLines.get(ev.round);
      if (lines && lines.length > 0) {
        lines[lines.length - 1] += ev.ok ? ` → ${ev.chunkCount ?? 0} excerpts` : ' → failed';
      }
      emit({
        step: 'rlm-subcall',
        message: ev.ok
          ? `RLM round ${ev.round}: ${ev.chunkCount ?? 0} excerpts returned${ev.preview ? ` — ${ev.preview}` : ''}`
          : `RLM round ${ev.round}: tool failed`,
        rlmHost: host || undefined,
        rlmModel: RLM_MODEL_ID,
        rlmRound: ev.round,
        rlmChunkCount: ev.chunkCount,
      });
    } else if (ev.type === 'token') {
      finalReport += ev.text;
      options.onToken?.(ev.text);
    } else if (ev.type === 'done') {
      if (!finalReport && ev.content) finalReport = ev.content;
      roundsSeen = Math.max(roundsSeen, ev.rounds);
    } else if (ev.type === 'notice') {
      // Input had to be shortened to fit the RLM context window — surface it so
      // the user knows the answer may be missing some of the pasted text.
      emit({ step: 'rlm-synthesis', message: ev.message, rlmHost: host || undefined, rlmModel: RLM_MODEL_ID });
    } else if (ev.type === 'error') {
      throw new Error(`RLM synthesis failed: ${ev.message}`);
    }
  }

  closeRound(currentRound);
  const closing = finalReport.trim();
  if (closing) notes.push(closing.slice(0, 500));

  return {
    finalText: finalReport,
    extraSources,
    roundOf,
    host,
    model: RLM_MODEL_ID,
    rounds: roundsSeen,
    toolCalls: toolCallCount,
    notes,
  };
}

/**
 * Dashboard-facing RLM stage: identical to `runRlmEvidenceRounds`, exposing
 * the model's closing text as `report` (the deep-search route has always
 * routed it to the thoughts channel, never the answer).
 */
export async function generateReportWithRlm(
  query: string,
  decomposition: DecompositionResult,
  initialSources: DeepSearchSource[],
  registry: ToolRegistry,
  options: RlmEvidenceRoundsOptions = {},
): Promise<{ report: string; extraSources: DeepSearchSource[]; host: string | null; model: string }> {
  const out = await runRlmEvidenceRounds(query, decomposition, initialSources, registry, options);
  return { report: out.finalText, extraSources: out.extraSources, host: out.host, model: out.model };
}

/**
 * Retrieval scope the RLM's follow-up tool calls inherit: the OR-union of
 * every chip's AND-block (so follow-ups stay inside the user's named refs),
 * AND'd with any active graph scope (appended as separate entries so it
 * narrows the chip union rather than widening it). Undefined when neither.
 */
export function buildRlmInheritedWhereClauses(
  chipSpecs: SubQuerySpec[] | null,
  scopeWhere: string[] | undefined,
): string[] | undefined {
  let inherited: string[] | undefined;
  if (chipSpecs && chipSpecs.length > 0) {
    const perChipBlocks = chipSpecs
      .filter(s => s.whereClauses && s.whereClauses.length > 0)
      .map(s => `(${s.whereClauses!.join(' AND ')})`);
    if (perChipBlocks.length > 0) {
      inherited = [perChipBlocks.length === 1 ? perChipBlocks[0] : `(${perChipBlocks.join(' OR ')})`];
    }
  }
  if (scopeWhere) {
    inherited = [...(inherited ?? []), ...scopeWhere];
  }
  return inherited;
}

// ---------------------------------------------------------------------------
// 5. Orchestrator
// ---------------------------------------------------------------------------

export async function deepSearch(
  query: string,
  registry: ToolRegistry,
  options: DeepSearchOptions = {},
): Promise<DeepSearchResult> {
  const { provider, model, caseId, chatId, onProgress, history, workflowContext, thinking, maxTokens, effort, signal, onToken, onThinking, multiPass, useRlm, rlmMaxRounds } = options;
  const scopeWhere = options.whereClauses && options.whereClauses.length > 0 ? options.whereClauses : undefined;
  const emit = onProgress || (() => {});

  // Accumulate the research trace alongside streaming it, so the completed
  // result carries it for persistence/replay.
  let thoughtsTrace = '';
  const onThoughts = (text: string) => {
    if (!text) return;
    if (thoughtsTrace.length < THOUGHTS_TRACE_CAP) thoughtsTrace += text;
    options.onThoughts?.(text);
  };
  const checkAbort = () => {
    if (signal?.aborted) {
      const err = new Error('Deep search aborted by client');
      err.name = 'AbortError';
      throw err;
    }
  };

  console.log(`[Deep Search] Starting for query: "${query.slice(0, 100)}"`);
  const t0 = Date.now();

  // Step 1: Decompose.
  //
  // Priority path: if the composer query contains `{{ … }}` chip segments,
  // honor "questions lead where the data is" semantics — each chip pairs
  // with the natural-language phrase next to it, each pair drives its own
  // sub-search with the chip as a hard Lance filter, and any free-text
  // before the first chip becomes a framing sub-search with a soft boost
  // over the chip refs. This bypasses LLM decomposition entirely; the user
  // already told us the scope.
  //
  // Fallback path: no chips → today's behavior, LLM decomposes the prose.
  checkAbort();
  emit({ step: 'decomposing', message: history?.length ? 'Analyzing follow-up in context...' : 'Breaking question into targeted sub-queries...' });

  const chipSpecs = buildChipSpecs(query);
  let dispatchSpecs: ReadonlyArray<string | SubQuerySpec>;
  let decomposition: DecompositionResult;
  if (chipSpecs && chipSpecs.length > 0) {
    dispatchSpecs = chipSpecs;
    // Synthesize a decomposition shape for the existing UI emit() / RLM API
    // contract. Each spec's query string surfaces as a sub-query label so
    // the operator sees "framing", "Vol 2 filing scope", etc. The intent
    // text is the framing if present, else the union of chip intents.
    const framingSpec = chipSpecs.find(s => s.label === 'framing');
    const intentText = framingSpec?.query
      ?? chipSpecs.filter(s => s.label !== 'framing').map(s => s.query).filter(Boolean).join(' · ')
      ?? query;
    decomposition = {
      subQueries: chipSpecs.map(s => s.query),
      intent: intentText,
    };
    console.log(`[Deep Search] Chip-driven dispatch: ${chipSpecs.length} pair(s)`,
      chipSpecs.map(s => ({ label: s.label, hasWhere: !!s.whereClauses?.length, hasBoost: !!s.softBoostRefs?.length })));
  } else {
    decomposition = await decomposeQuery(query, { provider, model, history, thinking, effort, signal });
    dispatchSpecs = decomposition.subQueries;
    console.log(`[Deep Search] Decomposed into ${decomposition.subQueries.length} sub-queries:`, decomposition.subQueries);
  }

  // Step 2: Parallel searches
  checkAbort();
  emit({
    step: 'searching',
    message: `Searching ${decomposition.subQueries.length} sub-queries in parallel...`,
    subQueryIndex: 0,
    subQueryTotal: decomposition.subQueries.length,
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
  });
  // Per-run warning collector with dedupe + counting. Identical (source, host,
  // message) warnings collapse so the UI doesn't show 16 copies of the same
  // "container not found" line when 8 parallel sub-queries each tried 2 hosts.
  const warnings: Array<{ source: string; host?: string; message: string; count: number }> = [];
  const warningIndex = new Map<string, number>();
  const pushWarning = (w: { source: string; host?: string; reason?: string; message: string }) => {
    const msg = w.reason ? `${w.reason}: ${w.message}` : w.message;
    const key = `${w.source}|${w.host ?? ''}|${msg}`;
    const existingIdx = warningIndex.get(key);
    if (existingIdx !== undefined) {
      warnings[existingIdx].count += 1;
      // Re-emit the updated warning so the UI can refresh the count.
      emit({ step: 'warning', message: `${w.source}${w.host ? ` (${w.host})` : ''}: ${msg}`, warnings: [warnings[existingIdx]] });
      return;
    }
    const out = { source: w.source, host: w.host, message: msg, count: 1 };
    warningIndex.set(key, warnings.length);
    warnings.push(out);
    emit({ step: 'warning', message: `${w.source}${w.host ? ` (${w.host})` : ''}: ${msg}`, warnings: [out] });
  };

  // An active graph scope AND-joins onto every spec's own filters (chip
  // filters narrow within the scope, they never widen past it). `_rawWhere`
  // entries AND together, so appending is exactly that intersection.
  const scopedDispatchSpecs: ReadonlyArray<string | SubQuerySpec> = scopeWhere
    ? dispatchSpecs.map(s => {
        const spec: SubQuerySpec = typeof s === 'string' ? { query: s } : s;
        return { ...spec, whereClauses: [...(spec.whereClauses ?? []), ...scopeWhere] };
      })
    : dispatchSpecs;

  const subQueryResults = await executeParallelSearches(
    scopedDispatchSpecs,
    caseId,
    registry,
    pushWarning,
    chatId,
  );

  // Step 2b: Supplementary pattern search (regex fallback for vocabulary
  // mismatch). When chips are present, dispatch one regex search per chip
  // spec scoped by that chip's whereClauses — same per-chip discipline as
  // the main vector+FTS retrieval. Otherwise fall back to today's single
  // corpus-wide regex over the whole query.
  checkAbort();
  emit({
    step: 'pattern_searching',
    message: 'Running keyword pattern search for exact text matches...',
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
  });
  if (chipSpecs && chipSpecs.length > 0) {
    const perChipPatternResults = await executePerChipPatternSearches(
      chipSpecs,
      caseId,
      registry,
      pushWarning,
      scopeWhere,
    );
    let perChipPatternTotal = 0;
    for (const r of perChipPatternResults) {
      if (r.sources.length > 0) {
        subQueryResults.push(r);
        perChipPatternTotal += r.sources.length;
      }
    }
    console.log(`[Deep Search] Per-chip pattern search found ${perChipPatternTotal} additional chunks across ${perChipPatternResults.length} chip slice(s)`);
  } else {
    const patternResult = await executePatternSearch(query, caseId, registry, pushWarning, scopeWhere);
    if (patternResult.sources.length > 0) {
      subQueryResults.push(patternResult);
      console.log(`[Deep Search] Pattern search found ${patternResult.sources.length} additional chunks`);
    } else {
      console.log('[Deep Search] Pattern search found no additional chunks');
    }
  }

  const totalRetrieved = subQueryResults.reduce((sum, r) => sum + r.sources.length, 0);

  // Step 3: Deduplicate and merge
  checkAbort();
  emit({
    step: 'merging',
    message: `Deduplicating ${totalRetrieved} chunks and reranking...`,
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
    searchStats: { totalRetrieved, subQueryCount: decomposition.subQueries.length },
  });
  const { sources, stats } = await deduplicateAndMerge(subQueryResults, query, pushWarning);
  console.log(`[Deep Search] Merged: ${stats.totalRetrieved} total -> ${stats.uniqueAfterDedup} unique -> ${stats.finalAfterRerank} after rerank`);

  // Step 4: Generate report
  checkAbort();
  emit({
    step: 'generating',
    message: useRlm
      ? `Routing synthesis through ss-rlm with ${sources.length} reranked sources...`
      : `Generating research report from ${sources.length} sources...`,
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
    searchStats: { ...stats, subQueryCount: decomposition.subQueries.length },
  });

  let report: string;
  let finalSources: DeepSearchSource[] = sources;
  let resultProvider: string = provider || 'auto';
  let resultModel: string = model || 'auto';
  let rlmAssisted = false;
  let rlmHost: string | undefined;
  let rlmExtraSourceCount = 0;

  console.log(`[Deep Search] Synthesis branch: useRlm=${useRlm} (typeof=${typeof useRlm}, raw=${JSON.stringify(useRlm)})`);

  if (useRlm) {
    // Stage 1: RLM drives the evidence-gathering loop. It does NOT write the
    // final report — its job is just to call query_case_knowledge a few times
    // to fill gaps in the initial reranked set.
    // If the user's query has chip segments, every RLM follow-up tool call
    // inherits the OR-union of chip filters so retrieval stays inside the
    // user's named scope (e.g. just that filing OR within those four
    // cases). Each chip's own whereClauses are AND-internal, so we OR
    // across chips by wrapping each chip's AND-block in parens and joining
    // with " OR ", then ship as a single composite where-clause. The
    // vector-store ANDs entries of `_rawWhere`, so a single composite
    // string preserves the intended union semantics.
    const inheritedWhereClauses = buildRlmInheritedWhereClauses(chipSpecs, scopeWhere);

    // RLM is OPTIONAL supplemental evidence-gathering — it does NOT write the
    // report (Stage 2 does). If it's down/unreachable/timing out/erroring, skip
    // it and synthesize from the already-reranked sources rather than failing
    // the whole search. A real user-abort is still propagated.
    // The RLM's streamed text is evidence-gathering narration, never the
    // report (Stage 2 writes that), so it belongs on the thoughts channel —
    // the answer channel must only ever carry synthesis output. Still capped:
    // when the RLM ignores its brief-confirmation instruction and dumps raw
    // excerpts, there is no reason to keep tens of thousands of chars of it.
    let rlmStreamedChars = 0;
    const RLM_STREAM_CAP = 3000;
    const rlmOnToken = onThoughts
      ? (t: string) => {
          if (rlmStreamedChars >= RLM_STREAM_CAP) return;
          rlmStreamedChars += t.length;
          onThoughts(t);
        }
      : undefined;
    try {
      const rlmOut = await generateReportWithRlm(query, decomposition, sources, registry, {
        caseId,
        chatId,
        history,
        workflowContext,
        maxTokens,
        signal,
        // Thoughts channel, capped (see above) — the operator still sees the
        // model ask for excerpts, but none of it can reach the answer.
        onToken: rlmOnToken,
        onProgress: emit,
        pushWarning,
        maxRounds: rlmMaxRounds,
        ...(inheritedWhereClauses ? { inheritedWhereClauses } : {}),
      });

      rlmAssisted = true;
      rlmHost = rlmOut.host || undefined;
      rlmExtraSourceCount = rlmOut.extraSources.length;

      // Merge RLM-discovered extras into the source pool. Dedup is already
      // enforced inside generateReportWithRlm via seenKeys, so a plain concat
      // here is safe. Skip re-rerank — pool stays small (typical 0-40 extras)
      // and we want the user to see the cloud-LLM report ASAP.
      if (rlmOut.extraSources.length > 0) {
        finalSources = [...sources, ...rlmOut.extraSources];
      }
    } catch (err) {
      checkAbort(); // a genuine user-abort must still bubble up, not be swallowed
      if ((err as Error)?.name === 'AbortError') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Deep Search] RLM evidence-gathering unavailable — skipping, synthesizing from reranked sources: ${msg}`);
      pushWarning({
        source: 'rlm',
        reason: 'skipped',
        message: `RLM supplemental evidence-gathering was unavailable and was skipped — the report is based on the reranked results only. (${msg.slice(0, 200)})`,
      });
      rlmAssisted = false;
      // finalSources stays = sources (no RLM extras)
    }

    // Stage 2: hand off to the standard synthesis path (Claude / user's chosen
    // provider). Runs whether RLM succeeded, was skipped, or failed — it writes
    // the actual report from whatever sources we have.
    checkAbort();
    emit({
      step: 'generating',
      message: rlmAssisted
        ? `RLM gathered ${rlmExtraSourceCount} additional sources — ${provider || 'cloud LLM'} now drafting the report (tokens will append below)...`
        : `Drafting the report from the reranked results — ${provider || 'cloud LLM'} writing now...`,
      subQueries: decomposition.subQueries,
      intent: decomposition.intent,
      searchStats: { ...stats, finalAfterRerank: finalSources.length, subQueryCount: decomposition.subQueries.length },
    });

    // Force single-pass synthesis after RLM. multiPass's outline call uses
    // Anthropic forced tool-use (jsonMode=true) which returns structured
    // JSON without streaming — that produces a ~2 min UI silence after RLM
    // already cleared its preamble. Single-pass streams from token 1.
    report = await generateReport(query, decomposition, finalSources, {
      provider,
      model,
      history,
      workflowContext,
      thinking,
      maxTokens,
      effort,
      signal,
      onToken,
      onThinking,
      onThoughts,
      onProgress: emit,
    });
    // Provider/model reflect the FINAL stage (who wrote the report), not RLM.
    // The rlmAssisted/rlmHost fields below carry the RLM contribution.
  } else {
    const reportFn = multiPass ? generateReportMultiPass : generateReport;
    report = await reportFn(query, decomposition, sources, {
      provider,
      model,
      history,
      workflowContext,
      thinking,
      maxTokens,
      effort,
      signal,
      onToken,
      onThinking,
      onThoughts,
      onProgress: emit,
    });
  }

  console.log(`[Deep Search] Completed in ${Date.now() - t0}ms`);

  emit({ step: 'done', message: 'Deep search complete.', warnings: warnings.length > 0 ? warnings : undefined });

  return {
    report,
    sources: finalSources,
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
    searchStats: {
      ...stats,
      subQueryCount: decomposition.subQueries.length,
    },
    model: resultModel,
    provider: resultProvider,
    rlmAssisted: rlmAssisted || undefined,
    rlmHost,
    rlmExtraSourceCount: rlmAssisted ? rlmExtraSourceCount : undefined,
    thoughts: thoughtsTrace ? capThoughts(thoughtsTrace) : undefined,
  };
}
