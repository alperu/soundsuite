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
import { McpError } from '../llm-policy';
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
export const DEFAULT_MODELS: Record<AIProviderKey, string> = {
  ollama: 'qwen2.5:14b',
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-5.6-terra',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.5-flash',
  grok: 'grok-4.5',
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

  const providerOrder: AIProviderKey[] = ['anthropic', 'openai', 'gemini', 'groq', 'grok'];

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
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', model: DEFAULT_MODELS.gemini };
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
  options?: { maxTokens?: number; temperature?: number; provider?: string; model?: string; jsonMode?: boolean; thinking?: boolean; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; context?: ToolExecutionContext; jsonSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }; signal?: AbortSignal },
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

  // Profile policy choke point (llm-policy.ts): a `local` MCP session may
  // only ever reach Ollama, whatever the resolution source above decided.
  // callLLMJson funnels through here, so this guard covers both entry points.
  if (options?.context?.profile === 'local' && provider !== 'ollama') {
    throw new McpError(
      'POLICY_VIOLATION',
      `profile "local" refuses provider "${provider}" (resolved via ${source}); only "ollama" is permitted`,
    );
  }
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
    effort: options?.effort,
    jsonSchema: options?.jsonSchema,
    signal: options?.signal,
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
 * Truncated raw snippet for a parse-failure message.
 *
 * The snippet may contain case text, so it is only ever placed on the error
 * *message* (which travels back to the caller that asked for the analysis) —
 * never on `logSafeMessage`, which is what gets written to the log
 * (CLAUDE.md § Privacy).
 */
const RAW_SNIPPET_CHARS = 300;

/**
 * Call the LLM and parse the response as JSON.
 * Reinforces JSON-only output in the system prompt to help smaller models.
 * On parse failure, retries the full call (same context) with stronger JSON
 * enforcement so the model gets a second attempt with all source material.
 *
 * If both attempts fail the call throws `McpError('LLM_PARSE_ERROR')`. Callers
 * that render prose rather than consuming the parsed shape may opt back into
 * the legacy `{ _markdown: raw }` degradation with `allowMarkdownFallback:
 * true`; it defaults **off** so an MCP tool never reports an unparseable model
 * response as a successful (and, on guarded tools, empty) analysis.
 */
export async function callLLMJson<T>(
  systemPrompt: string,
  userContent: string,
  options?: { maxTokens?: number; temperature?: number; provider?: string; model?: string; thinking?: boolean; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; context?: ToolExecutionContext; jsonSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown }; signal?: AbortSignal; allowMarkdownFallback?: boolean },
): Promise<T> {
  const { allowMarkdownFallback, ...llmOptions } = options ?? {};
  const reinforcedPrompt = systemPrompt + JSON_REINFORCEMENT;
  const raw = await callLLM(reinforcedPrompt, userContent, { ...llmOptions, jsonMode: true });

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
      { ...llmOptions, jsonMode: true, temperature: 0.1, maxTokens: options?.maxTokens ?? 4096 },
    );

    try {
      return extractJson<T>(retryRaw);
    } catch {
      if (allowMarkdownFallback) {
        // Opt-in only: the caller renders prose rather than consuming the
        // parsed shape. The _markdown field is picked up by MCPResultRenderer.
        return { _markdown: raw } as unknown as T;
      }
      // Fail loudly. An unparseable response is not "nothing found".
      const err = new McpError(
        'LLM_PARSE_ERROR',
        'The model did not return valid JSON after a retry, so no analysis could be produced. ' +
          `First ${Math.min(RAW_SNIPPET_CHARS, retryRaw.length)} characters of the response: ` +
          JSON.stringify(retryRaw.slice(0, RAW_SNIPPET_CHARS)),
      );
      // Log-safe twin: shape only, never the model's words (may be case text).
      err.logSafeMessage =
        `The model did not return valid JSON after a retry (${retryRaw.length} chars); response withheld from logs.`;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Item-level shape validation (SS-3 findings #4 and #5)
// ---------------------------------------------------------------------------

/**
 * Why this exists: valid JSON under the documented top-level key used to pass
 * straight through, so `{"citations": ["Vaughn v. Merrowfield, 1 F.3d 1"]}`
 * reached the client as an array of citation *objects*. A caller destructuring
 * `citation.case` gets `undefined`, or renders a bare string as if it were a
 * structured finding. Each tool now declares its documented item shape and
 * hands it to the one validator below, so the ten checks cannot drift apart.
 *
 * The rule, applied identically everywhere:
 *
 * - The model returned an **empty** list → a genuine negative. Returned as-is.
 * - **Every** item in a non-empty list is malformed → this is a shape failure,
 *   not an answer. Throws `McpError('LLM_SHAPE_ERROR')`, the same family as
 *   the top-level key guard.
 * - **Some** items are malformed → the bad ones are dropped, the good ones are
 *   returned, and `stats.itemsDropped` / `stats.warnings` say so. `stats` is
 *   present **only** when something was dropped or flagged, so its absence is
 *   itself the "nothing was lost" signal and a clean result stays byte-identical
 *   to what the model produced.
 *
 * Scores (`confidence`, `intensity`) are never a drop reason — see
 * `normaliseScore`.
 *
 * Privacy: warnings and log lines carry field names and counts only, never the
 * model's words, which are derived from case text (CLAUDE.md § Privacy).
 */
export type ItemFieldType = 'string' | 'number' | 'string[]' | 'object[]' | 'any';

export interface ItemFieldRule {
  type: ItemFieldType;
  /** Documented as nullable (e.g. an obligation with no deadline). Absent → `null`. */
  nullable?: boolean;
  /**
   * A model-supplied score. Coerced to a number when possible, `null` when not,
   * and never a reason to drop the item (SS-3 #5: a missing score is not
   * evidence of low confidence).
   */
  score?: boolean;
  /** Shape of the members of an `object[]` field. */
  items?: ItemShape;
}

/** The documented shape of one item, field by field. */
export type ItemShape = Record<string, ItemFieldRule>;

/** Surfaced on a tool result only when items were dropped or flagged. */
export interface LlmItemStats {
  /** Model-returned items discarded for not matching the documented shape. */
  itemsDropped: number;
  /** Shape-only notes: field names and counts, never model text. */
  warnings: string[];
}

/**
 * Coerce a model-supplied score to a number.
 *
 * `"0.9"` becomes `0.9`; `"high"`, `null`, `NaN` and absence all become `null`.
 * A `null` score means "the model did not give a usable score" — it must never
 * be compared against a threshold, because `undefined >= 0.7` is `false` and
 * that silently deleted findings the model actually reported.
 */
export function normaliseScore(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

interface ItemOutcome {
  /** Present only when the item matched the shape. */
  item?: Record<string, unknown>;
  /** Names of the fields that were missing or the wrong type. */
  badFields: string[];
  /** Members dropped from nested `object[]` fields (only meaningful if valid). */
  nestedDropped: number;
  /** Shape-only notes about the nested drops. */
  nestedWarnings: string[];
}

/**
 * Check one item against a shape. Presence tests use nullish comparisons, not
 * truthiness: `page: 0` and `mentions: 0` are documented values.
 */
function checkItem(raw: unknown, shape: ItemShape): ItemOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { badFields: ['<not an object>'], nestedDropped: 0, nestedWarnings: [] };
  }

  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  const badFields: string[] = [];
  let nestedDropped = 0;
  const nestedWarnings: string[] = [];

  for (const [field, rule] of Object.entries(shape)) {
    const value = src[field];

    if (rule.score) {
      out[field] = normaliseScore(value);
      continue;
    }

    if (value === undefined || value === null) {
      if (rule.nullable) out[field] = null;
      else badFields.push(field);
      continue;
    }

    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string' || !value.trim()) badFields.push(field);
        break;
      case 'number': {
        const num = normaliseScore(value);
        if (num === null) badFields.push(field);
        else out[field] = num;
        break;
      }
      case 'string[]':
        if (!Array.isArray(value)) badFields.push(field);
        break;
      case 'object[]': {
        if (!Array.isArray(value)) {
          badFields.push(field);
          break;
        }
        // A malformed nested member is dropped and counted; it never
        // invalidates the enclosing item, which is still a real answer.
        const kept: unknown[] = [];
        for (const member of value) {
          const outcome = checkItem(member, rule.items ?? {});
          if (outcome.item) kept.push(outcome.item);
          else nestedDropped++;
        }
        if (kept.length !== value.length) {
          nestedWarnings.push(
            `${field}: dropped ${value.length - kept.length} of ${value.length} malformed entries`,
          );
        }
        out[field] = kept;
        break;
      }
      case 'any':
        break;
    }
  }

  if (badFields.length > 0) return { badFields, nestedDropped: 0, nestedWarnings: [] };
  return { item: out, badFields: [], nestedDropped, nestedWarnings };
}

export interface ItemValidationContext {
  /** Tool name, for the log line. */
  tool: string;
  /** Documented top-level key the items live under, for messages. */
  key: string;
  logger?: { warn: (message: string, meta?: Record<string, any>) => void };
}

function reportDrops(
  ctx: ItemValidationContext,
  itemsDropped: number,
  warnings: string[],
  badFields: string[],
): void {
  if (itemsDropped === 0 && warnings.length === 0) return;
  ctx.logger?.warn(
    `[${ctx.tool}] dropped ${itemsDropped} malformed "${ctx.key}" item(s) from the model response`,
    // Field names and counts only — the values are case-derived text.
    { key: ctx.key, itemsDropped, badFields: [...new Set(badFields)] },
  );
}

/**
 * Validate a list the model returned under a documented key.
 *
 * Throws `LLM_SHAPE_ERROR` when a non-empty list contains no usable item;
 * otherwise returns the survivors plus `stats` when anything was dropped.
 */
export function validateItemList<T>(
  raw: unknown[],
  shape: ItemShape,
  ctx: ItemValidationContext,
): { items: T[]; stats?: LlmItemStats } {
  if (raw.length === 0) return { items: [] };

  const items: T[] = [];
  const badFields: string[] = [];
  const warnings: string[] = [];
  let nestedDropped = 0;

  for (const candidate of raw) {
    const outcome = checkItem(candidate, shape);
    if (outcome.item) {
      items.push(outcome.item as T);
      nestedDropped += outcome.nestedDropped;
      warnings.push(...outcome.nestedWarnings);
    } else {
      badFields.push(...outcome.badFields);
    }
  }

  const itemsDropped = raw.length - items.length;

  if (items.length === 0) {
    // Nothing the model returned was usable: report a shape failure rather
    // than an empty analysis, which reads as "nothing found".
    throw new McpError(
      'LLM_SHAPE_ERROR',
      `The model returned ${raw.length} "${ctx.key}" item(s), none matching the documented shape ` +
        `(missing or invalid: ${[...new Set(badFields)].join(', ')}), so no analysis could be produced.`,
    );
  }

  if (itemsDropped > 0) {
    warnings.unshift(
      `dropped ${itemsDropped} of ${raw.length} "${ctx.key}" item(s) missing or with invalid ` +
        `fields: ${[...new Set(badFields)].join(', ')}`,
    );
  }

  reportDrops(ctx, itemsDropped + nestedDropped, warnings, badFields);

  return {
    items,
    ...(itemsDropped > 0 || warnings.length > 0
      ? { stats: { itemsDropped: itemsDropped + nestedDropped, warnings } }
      : {}),
  };
}

/**
 * Validate a single object the model returned under a documented key
 * (the two tools whose result is an object rather than a list).
 *
 * There is only one "item", so the all-malformed rule collapses to: any
 * missing documented field is a shape failure. Filling the gaps with empty
 * arrays would report "no conflicts" when the model said nothing about
 * conflicts — the same false negative SS-3 #2/#3 removed.
 */
export function validateItemObject<T>(
  raw: unknown,
  shape: ItemShape,
  ctx: ItemValidationContext,
): { item: T; stats?: LlmItemStats } {
  const outcome = checkItem(raw, shape);

  if (!outcome.item) {
    throw new McpError(
      'LLM_SHAPE_ERROR',
      `The model's "${ctx.key}" object is missing or has invalid fields ` +
        `(${[...new Set(outcome.badFields)].join(', ')}), so no analysis could be produced.`,
    );
  }

  reportDrops(ctx, outcome.nestedDropped, outcome.nestedWarnings, []);

  return {
    item: outcome.item as T,
    ...(outcome.nestedDropped > 0
      ? { stats: { itemsDropped: outcome.nestedDropped, warnings: outcome.nestedWarnings } }
      : {}),
  };
}

/**
 * Apply a confidence threshold to already-validated items (SS-3 #5).
 *
 * `confidence` has been through `normaliseScore`, so it is a number or `null`
 * — never the string the model may have written. An item with a `null` score
 * is **kept**, not dropped: the model reported the finding and simply did not
 * score it, and on litigation material a discarded contradiction or privilege
 * hit is a substantive loss. The count is returned as a warning so the caller
 * knows those items were not filtered.
 */
export function applyConfidenceThreshold<T extends { confidence: number | null }>(
  items: T[],
  threshold: number,
  key: string,
): { items: T[]; warnings: string[] } {
  const unscored = items.filter(i => i.confidence === null).length;
  const kept = items.filter(i => i.confidence === null || i.confidence >= threshold);
  const warnings = unscored > 0
    ? [`${unscored} of ${items.length} "${key}" item(s) carried no usable confidence score; ` +
       `returned unfiltered with confidence: null`]
    : [];
  return { items: kept, warnings };
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
  results = await rerank(topic, results, limit, undefined, { interactive: true });

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
