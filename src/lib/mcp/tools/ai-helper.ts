/**
 * Shared AI helper for MCP tools.
 *
 * Provides a convenience wrapper around completeAI() that:
 * - Auto-selects the first available provider (checks config for keys)
 * - Retrieves document text chunks from the vector store for context
 * - Parses JSON from LLM responses
 */

import { completeAI, AIMessage } from '../../ai/ai-provider';
import { AIProviderKey, AI_PROVIDERS } from '../../ai/models';
import { getConfig, AppConfig } from '../../db/config';
import { ToolExecutionContext } from '../tool-types';
import { SearchQuery, MatchQuery, BooleanQuery, Occur } from '../../vector/vector-store';
import type { FullTextQuery } from '../../vector/vector-store';
import { QueryPreprocessor } from '../../search/query-preprocessor';
import { rerank } from '../../search/reranker';

/**
 * Legacy module-level provider override (kept as fallback for non-context callers).
 * The primary mechanism is now context.aiProvider/aiModel passed through ToolExecutionContext.
 */
let _providerOverride: { provider: AIProviderKey; model: string } | null = null;

/** Default models per provider — pick a capable but cost-effective model. */
const DEFAULT_MODELS: Record<AIProviderKey, string> = {
  ollama: 'qwen2.5:14b',
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5-20250929',
  grok: 'grok-3-mini',
};

/**
 * Determine the first available AI provider from the app config.
 * Priority: ollama (free, local) → anthropic → openai → groq → grok
 */
export async function getAvailableProvider(): Promise<{ provider: AIProviderKey; model: string }> {
  const config = await getConfig();

  // Ollama is highest priority — free, local, private.
  // Check the dedicated completion host first, then fall back to shared host.
  if (config.ollamaCompletionHost || config.ollamaHost) {
    const model = config.ollamaCompletionModel || DEFAULT_MODELS.ollama;
    return { provider: 'ollama', model };
  }

  const providerOrder: AIProviderKey[] = ['anthropic', 'openai', 'groq', 'grok'];

  for (const provider of providerOrder) {
    const configKey = AI_PROVIDERS[provider].configKey;
    const key = (config as any)[configKey] as string | undefined;
    if (key) {
      return { provider, model: DEFAULT_MODELS[provider] };
    }
  }

  // Also check env vars
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: DEFAULT_MODELS.anthropic };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: DEFAULT_MODELS.openai };
  if (process.env.GROQ_API_KEY) return { provider: 'groq', model: DEFAULT_MODELS.groq };

  throw new Error('No AI provider configured. Add an API key in Admin > AI Keys, or configure an Ollama host.');
}

/**
 * Call the LLM with a system prompt and user content, returning raw text.
 *
 * Provider/model resolution order:
 * 1. Explicit options.provider + options.model
 * 2. options.context.aiProvider + options.context.aiModel (from ToolExecutionContext — set per-request by the execute route)
 * 3. Module-level _providerOverride (legacy fallback)
 * 4. getAvailableProvider() auto-detect
 */
export async function callLLM(
  systemPrompt: string,
  userContent: string,
  options?: { maxTokens?: number; temperature?: number; provider?: string; model?: string; jsonMode?: boolean; thinking?: boolean; context?: ToolExecutionContext },
): Promise<string> {
  let source: string;
  const { provider, model } = (options?.provider && options?.model)
    ? (source = 'explicit-options', { provider: options.provider as AIProviderKey, model: options.model })
    : (options?.context?.aiProvider && options?.context?.aiModel)
      ? (source = 'context-override', { provider: options.context.aiProvider as AIProviderKey, model: options.context.aiModel })
      : _providerOverride
        ? (source = 'module-global', _providerOverride)
        : (source = 'auto-detect', await getAvailableProvider());
  console.log(`[callLLM] Resolved provider=${provider} model=${model} via ${source}`);
  const messages: AIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const response = await completeAI({
    provider,
    model,
    messages,
    maxTokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.2,
    jsonMode: options?.jsonMode,
    thinking: options?.thinking,
  });

  return response.content;
}

/**
 * Try to extract valid JSON from an LLM response that may contain
 * markdown fences, preamble text, or other non-JSON content.
 */
function extractJson<T>(raw: string): T {
  // Strip markdown code fences
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch { /* fall through */ }

  // Greedy: find outermost { ... } with balanced braces
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1)) as T;
        } catch { break; }
      }
    }
  }

  throw new Error(`Failed to parse LLM response as JSON. Raw response: ${raw.slice(0, 500)}`);
}

/** Reinforcement suffix appended to system prompts for JSON calls. */
const JSON_REINFORCEMENT = '\n\nCRITICAL: You MUST respond with ONLY a valid JSON object. No markdown, no explanations, no text outside the JSON. Start your response with { and end with }.';

/**
 * Call the LLM and parse the response as JSON.
 * Reinforces JSON-only output in the system prompt to help smaller models.
 * On parse failure, retries the full call (same context) with stronger JSON
 * enforcement so the model gets a second attempt with all source material.
 * If both attempts fail, returns the raw response as markdown via `_markdown`.
 */
export async function callLLMJson<T>(
  systemPrompt: string,
  userContent: string,
  options?: { maxTokens?: number; temperature?: number; provider?: string; model?: string; thinking?: boolean; context?: ToolExecutionContext },
): Promise<T> {
  const reinforcedPrompt = systemPrompt + JSON_REINFORCEMENT;
  const raw = await callLLM(reinforcedPrompt, userContent, { ...options, jsonMode: true });

  try {
    return extractJson<T>(raw);
  } catch {
    // Retry: resend the full original context (not just the broken output)
    // so the model can re-analyze with all source material.
    const strongerPrompt = systemPrompt +
      '\n\nIMPORTANT: Your previous response was not valid JSON and was rejected. ' +
      'You MUST respond with ONLY a raw JSON object. Do NOT include any markdown, ' +
      'headings, bullet points, or explanatory text. Start with { and end with }. ' +
      'Every string value must be properly quoted and escaped.';
    const retryRaw = await callLLM(
      strongerPrompt,
      userContent,
      { ...options, jsonMode: true, temperature: 0.1, maxTokens: options?.maxTokens ?? 4096 },
    );

    try {
      return extractJson<T>(retryRaw);
    } catch {
      // All JSON attempts failed — return the raw markdown so the UI can render it.
      // The _markdown field is picked up by MCPResultRenderer for display.
      return { _markdown: raw } as unknown as T;
    }
  }
}

/**
 * Retrieve all text chunks for a document from the vector store.
 * Returns chunks sorted by page number and chunk index.
 */
export async function getDocumentChunks(
  context: ToolExecutionContext,
  documentId: string,
  limit = 100,
): Promise<Array<{ text: string; pageNumber: number; chunkIndex: number }>> {
  const results = await context.vectorStore.search({
    filter: { documentId },
    limit,
  });

  return results
    .map(r => ({
      text: r.text,
      pageNumber: r.metadata.pageNumber,
      chunkIndex: r.metadata.chunkIndex,
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex);
}

/**
 * Retrieve text chunks for all documents in a case.
 * Returns chunks grouped by document with metadata.
 */
export async function getCaseChunks(
  context: ToolExecutionContext,
  caseId: string,
  limit = 200,
): Promise<Array<{ text: string; documentId: string; documentName: string; pageNumber: number }>> {
  const results = await context.vectorStore.search({
    filter: { caseId },
    limit,
  });

  // Enrich with document names
  const docIds = [...new Set(results.map(r => r.metadata.documentId))];
  const docs = await context.database.document.findMany({
    where: { id: { in: docIds } },
    select: { id: true, fileName: true },
  });
  const docMap = new Map(docs.map(d => [d.id, d.fileName]));

  return results
    .map(r => ({
      text: r.text,
      documentId: r.metadata.documentId,
      documentName: docMap.get(r.metadata.documentId) || 'Unknown',
      pageNumber: r.metadata.pageNumber,
    }))
    .sort((a, b) => a.documentName.localeCompare(b.documentName) || a.pageNumber - b.pageNumber);
}

/**
 * Retrieve text chunks for a case using the full AI search pipeline on a topic.
 * Mirrors query_case_knowledge: embedding + keyword BooleanQuery + entity
 * boosting + secondary page-reference search + cross-encoder reranking.
 */
export async function getTopicCaseChunks(
  context: ToolExecutionContext,
  caseId: string,
  topic: string,
  limit = 150,
): Promise<Array<{ text: string; documentId: string; documentName: string; pageNumber: number }>> {
  const processed = QueryPreprocessor.process(topic);

  // Over-fetch so the cross-encoder reranker has a larger candidate pool
  const retrievalLimit = limit * 3;

  context.logger.info('getTopicCaseChunks: searching', {
    topic,
    caseId,
    limit,
    retrievalLimit,
    keywords: processed.keywords,
    entities: processed.entities,
    legalTerms: processed.legalTerms,
    pageRef: processed.pageReferences,
  });

  // Generate embedding for semantic search
  const embeddings = await context.embeddingProvider.embed([topic]);
  const queryEmbedding = embeddings[0];

  // Build FTS query from extracted keywords
  let ftsQuery: FullTextQuery | undefined;
  if (processed.keywords.length > 0) {
    const clauses: [Occur, FullTextQuery][] = processed.keywords.map((kw) => [
      Occur.Should,
      new MatchQuery(kw, 'text') as FullTextQuery,
    ]);
    ftsQuery = new BooleanQuery(clauses);
  }

  const searchQuery: SearchQuery = {
    vector: queryEmbedding,
    filter: { caseId },
    limit: retrievalLimit,
  };
  if (ftsQuery) {
    searchQuery.ftsQuery = ftsQuery;
  } else {
    searchQuery.hybridQuery = topic;
  }

  let results = await context.vectorStore.search(searchQuery);

  // Secondary page-reference search: if page refs extracted and room remains
  if (processed.pageReferences && results.length < retrievalLimit) {
    const pageRef = processed.pageReferences;
    const metadataFilter: Record<string, any> = { caseId };
    if (pageRef.page !== undefined) metadataFilter.pageNumber = pageRef.page;
    if (pageRef.filingType) metadataFilter.filingType = pageRef.filingType;

    const secondaryQuery: SearchQuery = {
      limit: retrievalLimit - results.length,
      filter: metadataFilter,
    };
    if (queryEmbedding) secondaryQuery.vector = queryEmbedding;
    if (ftsQuery) secondaryQuery.ftsQuery = ftsQuery;

    try {
      const secondaryResults = await context.vectorStore.search(secondaryQuery);
      const existingIds = new Set(results.map(r => r.chunkId));
      for (const sr of secondaryResults) {
        if (!existingIds.has(sr.chunkId)) {
          results.push(sr);
        }
      }
    } catch {
      // Secondary search failure is non-fatal
    }
  }

  // Boost results containing all extracted entities
  if (processed.entities.length > 0) {
    results = results.map((result) => {
      const textLower = result.text.toLowerCase();
      const allPresent = processed.entities.every(
        (entity) => textLower.includes(entity.toLowerCase()),
      );
      return allPresent ? { ...result, score: result.score * 1.5 } : result;
    });
    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, retrievalLimit);
  }

  // Cross-encoder reranking trims from the over-fetched pool back to limit
  results = await rerank(topic, results, limit);

  // Safety trim if reranking was disabled
  if (results.length > limit) {
    results = results.slice(0, limit);
  }

  context.logger.info('getTopicCaseChunks: done', { resultCount: results.length });

  // Enrich with document names
  const docIds = [...new Set(results.map(r => r.metadata.documentId))];
  const docs = await context.database.document.findMany({
    where: { id: { in: docIds } },
    select: { id: true, fileName: true },
  });
  const docMap = new Map(docs.map(d => [d.id, d.fileName]));

  return results
    .map(r => ({
      text: r.text,
      documentId: r.metadata.documentId,
      documentName: docMap.get(r.metadata.documentId) || 'Unknown',
      pageNumber: r.metadata.pageNumber,
    }))
    .sort((a, b) => a.documentName.localeCompare(b.documentName) || a.pageNumber - b.pageNumber);
}

/**
 * Build a text context block from chunks for LLM consumption.
 * Truncates to maxChars to stay within token limits.
 */
export function buildContext(
  chunks: Array<{ text: string; documentName?: string; pageNumber: number }>,
  maxChars = 80000,
): string {
  const parts: string[] = [];
  let totalChars = 0;

  for (const chunk of chunks) {
    const header = chunk.documentName
      ? `[${chunk.documentName}, Page ${chunk.pageNumber}]`
      : `[Page ${chunk.pageNumber}]`;
    const block = `${header}\n${chunk.text}\n`;

    if (totalChars + block.length > maxChars) break;
    parts.push(block);
    totalChars += block.length;
  }

  return parts.join('\n---\n');
}
