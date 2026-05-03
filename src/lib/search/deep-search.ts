/**
 * Deep Search Engine — multi-query decomposition for complex legal research questions.
 *
 * 1. Decomposes a complex question into targeted sub-queries via LLM
 * 2. Runs parallel searches for each sub-query through the full RAG pipeline
 * 3. Deduplicates and reranks the merged result pool
 * 4. Generates a comprehensive markdown report with citations
 */

import { callLLM, callLLMJson, buildContext, getAvailableProvider } from '../mcp/tools/ai-helper';
import { streamAI, AIProviderKey } from '../ai/ai-provider';
import { rerank, RerankableResult } from './reranker';
import type { ToolRegistry } from '../mcp/tool-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeepSearchSource {
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

interface DecompositionResult {
  subQueries: string[];
  intent: string;
}

export interface DeepSearchProgress {
  step: 'decomposing' | 'searching' | 'pattern_searching' | 'merging' | 'reranking' | 'generating' | 'done' | 'warning';
  message: string;
  /** For 'searching' step: which sub-query index (0-based) */
  subQueryIndex?: number;
  subQueryTotal?: number;
  /** Partial data available at this step */
  subQueries?: string[];
  intent?: string;
  searchStats?: Partial<DeepSearchResult['searchStats']>;
  /** Non-fatal warnings collected during the run (e.g. reranker fallback). */
  warnings?: Array<{ source: string; host?: string; message: string }>;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface DeepSearchOptions {
  provider?: string;
  model?: string;
  caseId?: string;
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

interface SubQueryResult {
  subQuery: string;
  sources: DeepSearchSource[];
}

export async function executeParallelSearches(
  subQueries: string[],
  caseId: string | undefined,
  registry: ToolRegistry,
): Promise<SubQueryResult[]> {
  const promises = subQueries.map(async (subQuery): Promise<SubQueryResult> => {
    try {
      const searchResult = await registry.execute('query_case_knowledge', {
        query: subQuery,
        ...(caseId ? { caseId } : {}),
        limit: 50,
        searchMode: 'hybrid',
      });

      if (!searchResult.success || !searchResult.data?.results) {
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
      limit: 50,
    });

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

// ---------------------------------------------------------------------------
// 3. Deduplicate and Merge
// ---------------------------------------------------------------------------

function makeDeduplicationKey(source: DeepSearchSource): string {
  return `${source.document}::${source.page}::${source.text.slice(0, 100)}`;
}

export async function deduplicateAndMerge(
  subQueryResults: SubQueryResult[],
  originalQuery: string,
  onWarning?: (w: { source: string; host?: string; message: string }) => void,
): Promise<{ sources: DeepSearchSource[]; stats: { totalRetrieved: number; uniqueAfterDedup: number; finalAfterRerank: number } }> {
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

  // Rerank merged pool against original query
  if (merged.length > 0) {
    const rerankable = merged as (DeepSearchSource & RerankableResult)[];
    merged = await rerank(originalQuery, rerankable, 150, onWarning ? (w) => onWarning({
      source: w.source,
      host: w.host,
      message: `${w.reason}: ${w.message}`,
    }) : undefined);
  }

  // Sort by score descending
  merged.sort((a, b) => b.score - a.score);

  return {
    sources: merged,
    stats: {
      totalRetrieved,
      uniqueAfterDedup,
      finalAfterRerank: merged.length,
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

export async function generateReport(
  query: string,
  decomposition: DecompositionResult,
  sources: DeepSearchSource[],
  options?: { provider?: string; model?: string; history?: ConversationTurn[]; workflowContext?: string; thinking?: boolean; maxTokens?: number; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; signal?: AbortSignal; onToken?: (text: string) => void; onThinking?: (text: string) => void },
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
  }));

  // Use buildContext with citation-enriched format
  const contextParts: string[] = [];
  let totalChars = 0;
  const maxChars = 120000;

  for (const chunk of contextChunks) {
    const cite = chunk.citation;
    const block = `[${cite}]\n${chunk.text}\n`;
    if (totalChars + block.length > maxChars) break;
    contextParts.push(block);
    totalChars += block.length;
  }

  const contextBlock = contextParts.join('\n---\n');

  // Build conversation history section if follow-up
  let historySection = '';
  if (options?.history && options.history.length > 0) {
    const historyLines = options.history.map((t) =>
      t.role === 'user' ? `**User:** ${t.content}` : `**Assistant:** ${t.content}`,
    );
    historySection = `## Previous Conversation
${historyLines.join('\n\n')}

---

The user is now asking a follow-up question. Use the conversation above as context — build on what was already discussed, don't repeat prior findings, and focus on answering the new question. If the new query references specific documents or pages, focus your analysis there.

`;
  }

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

${contextBlock}`;

  try {
    // When the caller wants live tokens (deep-search route does), bypass the
    // buffered callLLM helper and drive streamAI directly so the user sees
    // the report appear word-by-word instead of after a 60-300s wait.
    if (options?.onToken || options?.onThinking) {
      const resolved = (options?.provider && options?.model)
        ? { provider: options.provider as AIProviderKey, model: options.model }
        : await getAvailableProvider();
      let fullContent = '';
      for await (const event of streamAI({
        provider: resolved.provider,
        model: resolved.model,
        messages: [
          { role: 'system', content: REPORT_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxTokens: options?.maxTokens ?? 16384,
        temperature: 0.3,
        thinking: options?.thinking,
        effort: options?.effort,
        signal: options?.signal,
      })) {
        if (event.type === 'token' && options.onToken) {
          options.onToken(event.text);
          fullContent += event.text;
        } else if (event.type === 'thinking' && options.onThinking) {
          options.onThinking(event.text);
        } else if (event.type === 'done') {
          // streamAI's done event carries the full content as a fallback for
          // providers that don't yield per-token (e.g. error fallback).
          if (!fullContent && event.content) fullContent = event.content;
        }
      }
      return fullContent;
    }
    return await callLLM(REPORT_SYSTEM_PROMPT, userContent, {
      maxTokens: options?.maxTokens ?? 16384,
      temperature: 0.3,
      provider: options?.provider,
      model: options?.model,
      thinking: options?.thinking,
      effort: options?.effort,
      signal: options?.signal,
    });
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
// 5. Orchestrator
// ---------------------------------------------------------------------------

export async function deepSearch(
  query: string,
  registry: ToolRegistry,
  options: DeepSearchOptions = {},
): Promise<DeepSearchResult> {
  const { provider, model, caseId, onProgress, history, workflowContext, thinking, maxTokens, effort, signal, onToken, onThinking } = options;
  const emit = onProgress || (() => {});
  const checkAbort = () => {
    if (signal?.aborted) {
      const err = new Error('Deep search aborted by client');
      err.name = 'AbortError';
      throw err;
    }
  };

  console.log(`[Deep Search] Starting for query: "${query.slice(0, 100)}"`);
  const t0 = Date.now();

  // Step 1: Decompose
  checkAbort();
  emit({ step: 'decomposing', message: history?.length ? 'Analyzing follow-up in context...' : 'Breaking question into targeted sub-queries...' });
  const decomposition = await decomposeQuery(query, { provider, model, history, thinking, effort, signal });
  console.log(`[Deep Search] Decomposed into ${decomposition.subQueries.length} sub-queries:`, decomposition.subQueries);

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
  const subQueryResults = await executeParallelSearches(
    decomposition.subQueries,
    caseId,
    registry,
  );

  // Step 2b: Supplementary pattern search (regex fallback for vocabulary mismatch)
  checkAbort();
  emit({
    step: 'pattern_searching',
    message: 'Running keyword pattern search for exact text matches...',
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
  });
  const patternResult = await executePatternSearch(query, caseId, registry);
  if (patternResult.sources.length > 0) {
    subQueryResults.push(patternResult);
    console.log(`[Deep Search] Pattern search found ${patternResult.sources.length} additional chunks`);
  } else {
    console.log('[Deep Search] Pattern search found no additional chunks');
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
  const warnings: Array<{ source: string; host?: string; message: string }> = [];
  const { sources, stats } = await deduplicateAndMerge(subQueryResults, query, (w) => {
    warnings.push(w);
    emit({ step: 'warning', message: `${w.source}${w.host ? ` (${w.host})` : ''}: ${w.message}`, warnings: [w] });
  });
  console.log(`[Deep Search] Merged: ${stats.totalRetrieved} total -> ${stats.uniqueAfterDedup} unique -> ${stats.finalAfterRerank} after rerank`);

  // Step 4: Generate report
  checkAbort();
  emit({
    step: 'generating',
    message: `Generating research report from ${sources.length} sources...`,
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
    searchStats: { ...stats, subQueryCount: decomposition.subQueries.length },
  });
  const report = await generateReport(query, decomposition, sources, {
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
  });

  console.log(`[Deep Search] Completed in ${Date.now() - t0}ms`);

  emit({ step: 'done', message: 'Deep search complete.', warnings: warnings.length > 0 ? warnings : undefined });

  return {
    report,
    sources,
    subQueries: decomposition.subQueries,
    intent: decomposition.intent,
    searchStats: {
      ...stats,
      subQueryCount: decomposition.subQueries.length,
    },
    model: model || 'auto',
    provider: provider || 'auto',
  };
}
