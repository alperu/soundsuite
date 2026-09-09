import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { SearchQuery, MatchQuery, BooleanQuery, Occur, Operator } from '../../vector/vector-store';
import type { FullTextQuery } from '../../vector/vector-store';
import type { CitationInput } from '../../citations/citation-formatter';
import { detectLineNumbers } from '../../citations/line-number-detector';
import { QueryPreprocessor } from '../../search/query-preprocessor';
import { rerank, type RerankOutcome, type RerankSkipReason } from '../../search/reranker';
import { getChatVectorStore } from '../../chat/chat-vector-store';
import { parseBooleanQuery } from '../../search/boolean-query';
import { astToLanceQuery, BooleanFtsConversionError, extractFieldFilters, resolvePrismaFilters } from '../../search/boolean-to-fts';
import { getConfig } from '../../db/config';
import { recordStatusFromTags } from '../../ingestion/draft-detector';
import { DRAFT_CITE_MARKER } from '../../search/context-builder';
import { attachMotionIds } from '../motion-resolution';
import { resolveCaseScope, caseScopeFilter, caseScopeIds } from '../case-scope';
import { buildCaseCitationContexts, defaultCitationContext, type CaseCitationContext } from '../case-citation-context';

export interface QueryCaseKnowledgeParams {
  query: string;
  caseId?: string;
  /** Subset scope — mutually exclusive with `caseId`. Becomes `case_id IN (…)`. */
  caseIds?: string[];
  chatId?: string;
  limit?: number;
  searchMode?: 'vector' | 'hybrid' | 'keyword';
  /** 'boolean' parses the query as a full boolean expression with AND/OR/NOT, phrases, and `-`. */
  mode?: 'legacy' | 'boolean';
  /**
   * Pre-extracted Lance/SQL where-clauses to merge into the retrieval filter
   * as hard constraints. Each string is already SQL-escaped at the call site
   * (typically by `extractFieldFilters()` in src/lib/search/boolean-to-fts.ts).
   * Used by deep-search's per-chip dispatch so chip filters survive
   * sub-query text re-parsing.
   */
  whereClauses?: string[];
  /**
   * Soft boost set — for each {field, values} entry, results whose metadata
   * field matches any value get their post-rerank score multiplied by a
   * small constant (~1.2). Used by deep-search's framing-segment path so the
   * user's chip refs nudge ranking without hard-filtering out other docs.
   */
  softBoostRefs?: Array<{ field: 'documentId' | 'caseId' | 'filingId'; values: string[] }>;
  /**
   * Record-status filter. 'filed' = only chunks whose document carries a
   * recognised court file stamp; 'draft' = only unfiled working copies;
   * 'any' (default) = no filter. Drafts are ALWAYS labelled in the result
   * (`recordStatus: 'draft'` + a DRAFT marker in `citation`) regardless.
   */
  recordStatus?: 'filed' | 'draft' | 'any';
}

export interface QueryCaseKnowledgeResult {
  results: Array<{
    text: string;
    document: string;
    page: number;
    score: number;
    citation?: string;
    citationShort?: string;
    filingType?: string;
    volumeNumber?: number;
    caseNumber?: string;
    /** Database id of the owning case — the argument every case-scoped tool
     *  requires. `caseNumber` is the human docket number, not this
     *  (REPORT-discovery-tools §5). */
    caseId?: string;
    /** Motion whose page range contains this chunk, when one resolves — the
     *  seed `query_case_graph` needs. Absent when nothing matches. */
    motionId?: string;
    annotations?: string;
    source?: 'docket' | 'chat';
    chatAttachmentId?: string;
    /** 'draft' = unfiled working copy — citation carries a DRAFT marker. */
    recordStatus?: 'filed' | 'draft' | 'unknown';
  }>;
  /**
   * What the retrieval pipeline actually did, as opposed to what was asked
   * for. Always present.
   *
   * This exists because two legs of this tool degrade into a *successful*
   * response (docs/tasks/39 item 10, docs/tasks/22):
   *
   * - `searchMode: 'hybrid'` (the default) catches an embedding failure and
   *   falls through to keyword/FTS. The caller gets lexically-matched rows
   *   and no indication the vector leg is missing.
   * - `rerank()` returns its input unchanged on all six of its failure paths,
   *   so first-stage hybrid order is indistinguishable from a cross-encoder
   *   ranking by inspecting the rows.
   *
   * Neither was observable from the response. The `pushWarning` channel these
   * two sites already write to (`tool-types.ts:122`) is never supplied on an
   * MCP-facing `ToolExecutionContext` — `get-tool-registry.ts:107-112` builds
   * the context with four fields and no warning sink — and
   * `ToolExecutionResult` has no field to carry a warning even if it were.
   * So the signal has to travel in-band, here.
   */
  retrieval: {
    /** The `searchMode` param as requested. */
    searchModeRequested: 'vector' | 'hybrid' | 'keyword';
    /**
     * What ran. Differs from `searchModeRequested` only when `'hybrid'`
     * degraded to `'keyword'` because the embedding provider failed.
     */
    searchModeEffective: 'vector' | 'hybrid' | 'keyword';
    /** False when the query was never embedded — by request or by failure. */
    vectorSearchApplied: boolean;
    /** True only when cross-encoder scores were applied to these rows. */
    rerankApplied: boolean;
    /** Set whenever `rerankApplied` is false. */
    rerankSkipReason?: RerankSkipReason;
    /** Candidates handed to the cross-encoder. */
    rerankPoolIn?: number;
  };
  /**
   * Human-readable degradation notices; `[]` when nothing degraded — the same
   * field name and contract as `scan_for_pattern.warnings`. A non-empty array
   * means these results are thinner than a healthy run's, NOT that the corpus
   * lacks the answer.
   */
  warnings: string[];
}

export class QueryCaseKnowledgeTool extends BaseMCPTool<
  QueryCaseKnowledgeParams,
  QueryCaseKnowledgeResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'query_case_knowledge',
      displayName: 'Query Case Knowledge',
      description:
        'Perform semantic search on legal documents using natural language queries. ' +
        'Each result carries citation fields plus structure metadata when available: ' +
        'documentId, blockType (paragraph|table|footnote|figure), headingPath (section ' +
        'the text sits under), speakers (|-delimited transcript speakers), and ' +
        'tableMarkdown (structured form of table chunks). Each result also carries ' +
        'recordStatus (filed|draft|unknown): DRAFT results are unfiled working copies — ' +
        'their citation is suffixed "DRAFT, filing not confirmed" and they must never be ' +
        'described as filed, ruled on, or part of the record. Scope with `caseId` (one ' +
        'case) or `caseIds` (a subset); unscoped searches every case. Scoping selects ' +
        'WHICH cases are searched — it does not raise the candidate pool or the `limit`. ' +
        'ALWAYS check `retrieval` and `warnings` before concluding anything from thin or ' +
        'empty results: this tool returns success on a degraded run. ' +
        '`retrieval.searchModeEffective` is "keyword" when the embedding provider failed ' +
        'and the search silently became lexical-only, and `retrieval.rerankApplied` is ' +
        'false when rows are in first-stage retrieval order rather than cross-encoder ' +
        'relevance order. Non-empty `warnings` means the results are thinner or worse ' +
        'ranked than a healthy run — it does NOT mean the corpus lacks the answer, so ' +
        'report the degradation rather than asserting absence.',
      version: '1.5.0',
      category: 'search',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language query to search for',
          },
          caseId: {
            type: 'string',
            description:
              'Restrict the search to one case (Case id, from list_cases). Omit to search every case. Mutually exclusive with caseIds.',
          },
          caseIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description:
              'Restrict the search to a subset of cases (Case ids, from list_cases). Mutually exclusive with caseId. Selects which cases are searched; it does not raise the candidate pool.',
          },
          chatId: {
            type: 'string',
            description: 'Optional chat session ID — also search per-chat attachments',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
          },
          searchMode: {
            type: 'string',
            description: 'Search mode: vector, hybrid, or keyword (default: hybrid)',
            enum: ['vector', 'hybrid', 'keyword'],
          },
          recordStatus: {
            type: 'string',
            description:
              'Filter by record status: "filed" returns only chunks from documents with a ' +
              'recognised court file stamp, "draft" returns only unfiled working copies, ' +
              '"any" (default) returns both. Drafts are always labelled in results.',
            enum: ['filed', 'draft', 'any'],
          },
          // Declared because internal callers pass them (deep-search's per-chip
          // dispatch, /api/search/unified, /api/search/ai). Undeclared params
          // are now rejected, so anything a caller sends must appear here.
          mode: {
            type: 'string',
            enum: ['legacy', 'boolean'],
            description:
              '"boolean" parses the query as a boolean expression (AND/OR/NOT, "phrases", -exclusion). Default "legacy".',
          },
          whereClauses: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Extra SQL-style filter clauses ANDed into the retrieval filter (advanced; used by the dashboard\'s scope chips).',
          },
          softBoostRefs: {
            type: 'array',
            items: { type: 'object' },
            description:
              'Soft ranking boosts: [{ field: documentId|caseId|filingId, values: [...] }]. Nudges ranking without hard-filtering (advanced).',
          },
        },
        required: ['query'],
      },
    };
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  validateParams(params: QueryCaseKnowledgeParams): void {
    if (!params.query || typeof params.query !== 'string') {
      const err: any = new Error('Missing or invalid query parameter');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
  }

  async executeImpl(
    params: QueryCaseKnowledgeParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<QueryCaseKnowledgeResult> {
    const { query, chatId, limit = 10, searchMode = 'hybrid', mode = 'legacy', whereClauses, softBoostRefs, recordStatus = 'any' } = params;
    const chatHitChunkIds = new Set<string>();

    // Mutual exclusion + existence in one place; a bad id fails here with
    // INVALID_PARAMS rather than returning an empty page (docs/tasks/12 §4).
    const scope = await resolveCaseScope(params, context.database);
    const scopeFilter = caseScopeFilter(scope);
    const hasScope = Object.keys(scopeFilter).length > 0;
    // Single-case metadata lookups (citation formatter, volume counts) still
    // key off one id; a subset scope leaves them on the corpus-wide defaults.
    const caseId = scope.caseId;

    // Per-phase wall-clock timings, logged as one [qck-timing] line at the end
    // so slow phases (embed vs search vs rerank vs hydrate) are attributable.
    const phaseTimings: Record<string, number> = {};
    const phaseStart = Date.now();
    let phaseMark = phaseStart;
    const markPhase = (name: string) => {
      const now = Date.now();
      phaseTimings[name] = (phaseTimings[name] ?? 0) + (now - phaseMark);
      phaseMark = now;
    };

    // Tunable hybrid-fusion constants (Config-backed; defaults 60 / 1.2 preserve
    // prior behavior). See docs/tasks/04-learned-fusion-weighting.md.
    const appConfig = await getConfig();

    // Over-fetch candidates so the cross-encoder reranker has a larger pool to judge.
    // The reranker is far better at relevance scoring than embedding similarity,
    // so casting a wider retrieval net dramatically improves recall.
    // Floor at 200 so FTS-matched chunks from docs with weaker embeddings
    // (e.g. transcripts whose chunks are large/noisy) still enter the pool.
    const retrievalLimit = Math.max(limit * 5, 200);

    // Preprocess the query to extract keywords, entities, legal terms, page references
    const processed = QueryPreprocessor.process(query);

    context.logger.info('Handling query_case_knowledge', {
      query,
      caseId,
      limit,
      retrievalLimit,
      searchMode,
      keywords: processed.keywords,
      entities: processed.entities,
      legalTerms: processed.legalTerms,
      pageRef: processed.pageReferences,
    });

    markPhase('preprocess');

    // In-band degradation ledger. `pushWarning` below reaches only the
    // in-process deep-search collector (`deep-search.ts:509`, the sole caller
    // that supplies it); everything the MCP surface returns has to be on the
    // result object itself. See `QueryCaseKnowledgeResult.retrieval`.
    const warnings: string[] = [];
    /** Flips to 'keyword' if the hybrid embed leg fails below. */
    let searchModeEffective: 'vector' | 'hybrid' | 'keyword' = searchMode;

    // Generate embedding for query (needed for vector and hybrid modes)
    let queryEmbedding: number[] | undefined;
    if (searchMode !== 'keyword') {
      try {
        const embeddings = await context.embeddingProvider.embed([query]);
        queryEmbedding = embeddings[0];
      } catch (err) {
        // Surface to UI; keyword/FTS path may still succeed below.
        const msg = (err as Error).message;
        // Try to extract host from common Ollama error shape
        const hostMatch = msg.match(/\(http:\/\/[^,)\s]+/);
        const host = hostMatch ? hostMatch[0].slice(1) : undefined;
        context.pushWarning?.({
          source: 'embedding',
          host,
          reason: 'embed-failed',
          message: msg,
        });
        // The same fact, in-band. A hybrid search that silently became
        // keyword-only must say so where the caller will actually see it.
        if (searchMode === 'hybrid') {
          searchModeEffective = 'keyword';
          warnings.push(
            `Semantic (vector) search was unavailable${host ? ` at ${host}` : ''} — the embedding ` +
              'provider failed, so these results are KEYWORD-ONLY and rank by lexical match, not ' +
              'meaning. Paraphrases and synonyms of the query will be missing. This is a degraded ' +
              `run, not an empty corpus. Provider error: ${msg}`,
          );
        }
        // Re-throw if no fallback path possible (pure vector search would have
        // nothing to do). Coded so `BaseMCPTool` forwards the provider's own
        // message — the dashboard turns it into "configure an embedding
        // provider" guidance, which a generic EXECUTION_ERROR cannot support.
        if (searchMode === 'vector') {
          const coded: any = err instanceof Error ? err : new Error(String(err));
          if (!coded.code) coded.code = 'EMBEDDING_UNAVAILABLE';
          throw coded;
        }
        // Otherwise fall through — keyword search can still produce results.
      }
    }
    markPhase('embed');

    // Build FTS query from extracted keywords using BooleanQuery
    let ftsQuery: FullTextQuery | undefined;
    // Field-filter SQL clauses lifted out of the AST (see boolean-to-fts.ts).
    // Merged into searchQuery.filter._rawWhere below.
    const fieldWhereClauses: string[] = [];
    if (searchMode === 'hybrid' || searchMode === 'keyword') {
      let booleanHandled = false;
      if (mode === 'boolean') {
        const parsed = parseBooleanQuery(query);
        if (parsed.ok) {
          // Extract field filters first — strips field-qualified TERMs whose
          // ancestors are all AND, returns SQL where-clauses + rewritten AST.
          // Async path: resolve prisma-traverse requests against the legal
          // schema and merge their where-clauses in too.
          const { whereClauses, prismaRequests, ast: strippedAst } = extractFieldFilters(parsed.ast);
          fieldWhereClauses.push(...whereClauses);
          if (prismaRequests.length > 0) {
            try {
              const { whereClauses: prismaWhere } = await resolvePrismaFilters(
                prismaRequests,
                context.database as any,
              );
              fieldWhereClauses.push(...prismaWhere);
            } catch (err) {
              context.logger.warn?.('Prisma traversal batch failed — continuing without those filters', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // If the AST still has boolean operators OR field filters were
          // extracted (a single field term should also engage the boolean path
          // so the .where() lands on LanceDB), build an FTS query.
          const shouldUseBoolean = parsed.hasOperators || whereClauses.length > 0;
          if (shouldUseBoolean && strippedAst) {
            try {
              ftsQuery = astToLanceQuery(strippedAst);
              booleanHandled = true;
            } catch (err) {
              const msg = err instanceof BooleanFtsConversionError ? err.message : String(err);
              context.logger.warn?.('Boolean FTS conversion failed — falling back to legacy', { error: msg });
            }
          } else if (shouldUseBoolean && !strippedAst) {
            // Pure field-filter query like `case:X` with no text component.
            // We have where-clauses; no FTS body needed. Mark as handled so
            // we skip the keyword fallback.
            booleanHandled = true;
          }
        } else {
          context.logger.warn?.('Boolean parse failed — falling back to legacy', {
            error: parsed.error,
            position: parsed.position,
          });
        }
      }
      if (!booleanHandled && processed.keywords.length > 0) {
        const clauses: [Occur, FullTextQuery][] = processed.keywords.map((kw) => [
          Occur.Should,
          new MatchQuery(kw, 'text') as FullTextQuery,
        ]);
        ftsQuery = new BooleanQuery(clauses);
      }
    }

    // Build search query with expanded candidate pool
    const searchQuery: SearchQuery = {
      limit: retrievalLimit,
      rrfK: appConfig.fusionRrfK,
    };

    if (queryEmbedding) {
      searchQuery.vector = queryEmbedding;
    }

    if (ftsQuery) {
      searchQuery.ftsQuery = ftsQuery;
    } else if (searchMode === 'hybrid' || searchMode === 'keyword') {
      // Fallback: pass raw query for legacy text search
      searchQuery.hybridQuery = query;
    }

    // Apply case scope if provided (`caseId` → `case_id = …`, `caseIds` → IN).
    if (hasScope) {
      searchQuery.filter = { ...scopeFilter };
    }

    // Record-status filter (draft guard). 'any' keeps legacy behaviour.
    if (recordStatus === 'filed' || recordStatus === 'draft') {
      if (!searchQuery.filter) searchQuery.filter = {};
      searchQuery.filter.recordStatus = recordStatus;
    }

    // Merge field-qualified filter clauses lifted from the boolean AST.
    if (fieldWhereClauses.length > 0) {
      if (!searchQuery.filter) searchQuery.filter = {};
      searchQuery.filter._rawWhere = fieldWhereClauses;
    }

    // Caller-supplied where-clauses (e.g. deep-search's per-chip dispatch
    // shipping pre-extracted filters so we don't have to round-trip them
    // through query text re-parsing). Merge alongside whatever the
    // boolean-mode extractor pulled out of `query` itself.
    if (whereClauses && whereClauses.length > 0) {
      if (!searchQuery.filter) searchQuery.filter = {};
      const existing = Array.isArray(searchQuery.filter._rawWhere) ? searchQuery.filter._rawWhere : [];
      searchQuery.filter._rawWhere = [...existing, ...whereClauses];
    }

    // Perform primary search
    markPhase('buildQuery');
    let searchResults = await context.vectorStore.search(searchQuery);
    markPhase('vectorSearch');

    // Per-chat attachment search — alongside docket results
    if (chatId) {
      try {
        const chatVs = await getChatVectorStore(chatId);
        const chatQuery: SearchQuery = { limit: retrievalLimit };
        if (queryEmbedding) chatQuery.vector = queryEmbedding;
        if (ftsQuery) chatQuery.ftsQuery = ftsQuery;
        else if (searchMode === 'hybrid' || searchMode === 'keyword') {
          chatQuery.hybridQuery = query;
        }
        const chatResults = await chatVs.search(chatQuery);
        for (const r of chatResults) {
          chatHitChunkIds.add(r.chunkId);
        }
        searchResults = [...searchResults, ...chatResults];
      } catch (err) {
        context.logger.warn?.('Per-chat search failed (non-fatal)', {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // If page references were extracted, run a secondary metadata-filtered search and merge
    if (processed.pageReferences && searchResults.length < retrievalLimit) {
      const pageRef = processed.pageReferences;
      const metadataFilter: Record<string, any> = { ...scopeFilter };
      if (pageRef.page !== undefined) metadataFilter.pageNumber = pageRef.page;
      if (pageRef.filingType) metadataFilter.filingType = pageRef.filingType;

      const secondaryQuery: SearchQuery = {
        limit: retrievalLimit - searchResults.length,
        filter: metadataFilter,
      };
      if (queryEmbedding) secondaryQuery.vector = queryEmbedding;
      if (ftsQuery) secondaryQuery.ftsQuery = ftsQuery;

      try {
        const secondaryResults = await context.vectorStore.search(secondaryQuery);
        // Merge, avoiding duplicates
        const existingIds = new Set(searchResults.map(r => r.chunkId));
        for (const sr of secondaryResults) {
          if (!existingIds.has(sr.chunkId)) {
            searchResults.push(sr);
          }
        }
      } catch {
        // Secondary search failure is non-fatal
      }
    }

    // Post-process: boost results containing ALL extracted entities
    if (processed.entities.length > 0) {
      searchResults = searchResults.map((result) => {
        const textLower = result.text.toLowerCase();
        const allEntitiesPresent = processed.entities.every(
          (entity) => textLower.includes(entity.toLowerCase())
        );
        if (allEntitiesPresent) {
          return { ...result, score: result.score * 1.5 };
        }
        return result;
      });
      // Re-sort by score (higher is better for RRF/BM25 scores)
      searchResults.sort((a, b) => b.score - a.score);
      searchResults = searchResults.slice(0, retrievalLimit);
    }

    // Rerank results using cross-encoder if enabled.
    // Pass explicit topN = retrievalLimit (not limit) so the reranker keeps
    // the full pool around for the transcript-intent boost below. We trim
    // to `limit` after that boost runs.
    markPhase('chatAndSecondarySearch');

    // Cap the candidate pool sent to the cross-encoder. Without a cap the
    // full retrieval pool (≥200 docs) goes to vLLM in one request, which
    // dominates tool latency (~60ms/doc on Qwen3-Reranker-8B ⇒ 200 docs ≈
    // 12s of pure inference, before queueing behind concurrent reranks).
    // This is an interactive tool returning `limit` results, so 8× the
    // requested count (floor 40) is ample oversampling for the cross-encoder;
    // the operator-wide rerankPoolSize (used as-is by deep-search's batch
    // pipeline) stays the upper bound.
    const rerankPool = Math.min(
      appConfig.rerankPoolSize ?? 150,
      Math.max(limit * 8, 40),
    );
    if (searchResults.length > rerankPool) {
      searchResults.sort((a, b) => b.score - a.score);
      searchResults = searchResults.slice(0, rerankPool);
    }

    // `rerank()` returns its input array on every failure path, so the only
    // way to know whether a cross-encoder touched these rows is to ask it.
    let rerankOutcome: RerankOutcome | undefined;
    searchResults = await rerank(query, searchResults, rerankPool, context.pushWarning ? (w) => {
      context.pushWarning!({ source: w.source, host: w.host, reason: w.reason, message: w.message });
    } : undefined, { interactive: true, onOutcome: (o) => { rerankOutcome = o; } });
    markPhase('rerank');

    // `empty-results` is benign — nothing was retrieved to rank, and the empty
    // `results` array already tells the caller that. Every other skip reason
    // means these rows are in first-stage retrieval order while looking
    // exactly like a reranked set.
    if (rerankOutcome && !rerankOutcome.applied && rerankOutcome.reason !== 'empty-results') {
      warnings.push(
        `Results were NOT reranked (${rerankOutcome.reason}) — they are in first-stage hybrid ` +
          'retrieval order, not cross-encoder relevance order. Ordering is less reliable than a ' +
          'healthy run; treat the top result as a candidate, not a best match.' +
          (rerankOutcome.message ? ` Detail: ${rerankOutcome.message}` : ''),
      );
    }

    // Transcript-intent boost — mirrors the same heuristic in
    // src/lib/search/deep-search.ts so /api/search/semantic doesn't punish
    // Reporter's Record chunks against shorter clerk's-record snippets when
    // the user is actually asking about testimony / hearings / transcripts.
    const RR_INTENT_RE = /\b(hearing|testimony|testif|deposition|cross[\s-]?examination|direct[\s-]?examination|witness|RR\b|reporter['’]?s?\s*record|transcript|stenograph|cite\s+line|line\s*\d{1,4})/i;
    if (RR_INTENT_RE.test(query)) {
      const TRANSCRIPT_FILING_RE = /\b(reporter['’]?s?\s*record|reporters_record|transcript|RR)\b/i;
      const TRANSCRIPT_BOOST = 1.35;
      for (const r of searchResults) {
        const ft = r.metadata.filingType;
        if (ft && TRANSCRIPT_FILING_RE.test(ft)) {
          r.score *= TRANSCRIPT_BOOST;
        }
      }
      searchResults.sort((a, b) => b.score - a.score);
    }

    // Caller-supplied soft boost — used by deep-search's framing-segment path
    // so the user's chip refs nudge ranking on the "questions lead where the
    // data is" overview pass, without hard-filtering out other docs the model
    // might want to reach for. Smaller multiplier than the transcript boost
    // because this is a hint about user attention, not a strong relevance
    // signal.
    if (softBoostRefs && softBoostRefs.length > 0) {
      const SOFT_BOOST = appConfig.fusionSoftBoost;
      const refSets = softBoostRefs.map(b => ({ field: b.field, set: new Set(b.values) }));
      for (const r of searchResults) {
        for (const { field, set } of refSets) {
          const v = field === 'documentId' ? r.metadata.documentId
            : field === 'caseId' ? r.metadata.caseId
            : field === 'filingId' ? r.metadata.filingId
            : undefined;
          if (v && set.has(v)) {
            r.score *= SOFT_BOOST;
            break;
          }
        }
      }
      searchResults.sort((a, b) => b.score - a.score);
    }

    // Per-document diversity cap — prevents one giant document (typically a
    // clerk's record or multi-volume RR) from monopolizing the top N when
    // many of its chunks score similarly well. Mirrors the cap applied
    // in deep-search.ts but tuned for the smaller `limit` used here.
    // Cap = max(2, ceil(limit / distinctDocs * 1.2)) per document.
    if (searchResults.length > limit) {
      const distinctDocs = new Set(searchResults.map((r) => r.metadata.documentId)).size;
      const perDocCap = Math.max(2, Math.ceil((limit / Math.max(1, distinctDocs)) * 1.2));
      const perDocCount = new Map<string, number>();
      const capped: typeof searchResults = [];
      const overflow: typeof searchResults = [];
      for (const r of searchResults) {
        const key = r.metadata.documentId;
        const n = perDocCount.get(key) ?? 0;
        if (n < perDocCap) {
          perDocCount.set(key, n + 1);
          capped.push(r);
        } else {
          overflow.push(r);
        }
        if (capped.length >= limit) break;
      }
      // If capping left us short of `limit` (e.g. very few distinct docs),
      // fill from overflow so we still hand back the requested count.
      while (capped.length < limit && overflow.length > 0) {
        capped.push(overflow.shift()!);
      }
      searchResults = capped;
    }

    // Per-case citation context (formatter + volume counts + docket number)
    // for every case in scope. `caseIds` gets the same quality `caseId` does;
    // a multi-case page formats each row with its own case's context.
    const citationContexts = await buildCaseCitationContexts(caseScopeIds(scope), context.database);
    const fallbackContext = defaultCitationContext();
    const contextFor = (rowCaseId?: string): CaseCitationContext =>
      (rowCaseId ? citationContexts.get(rowCaseId) : undefined) ?? fallbackContext;

    // documentId -> filingId for the returned hits, filled during enrichment
    // below and consumed by the single batched motion lookup that follows.
    const docFilingIds = new Map<string, string>();

    // Enrich results with document names and citations
    const enrichedResults = await Promise.all(
      searchResults.map(async (result) => {
        const isChatHit = chatHitChunkIds.has(result.chunkId);
        if (isChatHit) {
          const attachment = await (context.database as any).chatAttachment?.findUnique({
            where: { id: result.metadata.documentId },
            select: { id: true, fileName: true },
          });
          const fileName = attachment?.fileName || 'Chat attachment';
          return {
            text: result.text,
            document: fileName,
            page: result.metadata.pageNumber,
            score: result.score,
            citation: `${fileName} p.${result.metadata.pageNumber}`,
            citationShort: `${fileName} p.${result.metadata.pageNumber}`,
            filingType: undefined,
            volumeNumber: undefined,
            caseNumber: undefined,
            // A chat attachment belongs to no case and no motion.
            caseId: undefined as string | undefined,
            motionId: undefined as string | undefined,
            annotations: result.metadata.annotations || undefined,
            // Structural fields — same projection as document hits below.
            // This hand-built branch previously dropped all four (the exact
            // easy-to-miss spot PLAN-ss-docparse §6.3 flagged).
            blockType: result.metadata.blockType || undefined,
            headingPath: result.metadata.headingPath || undefined,
            speakers: result.metadata.speakers || undefined,
            tableMarkdown: result.metadata.tableMarkdown || undefined,
            recordStatus: result.metadata.recordStatus || undefined,
            source: 'chat' as const,
            chatAttachmentId: attachment?.id || result.metadata.documentId,
          };
        }
        const document = await context.database.document.findUnique({
          where: { id: result.metadata.documentId },
          select: { fileName: true, filing: true, case: true, documentType: true },
        });

        // Use metadata from LanceDB first, fall back to Prisma lookup for legacy rows,
        // then fall back to document.documentType (set during filing detection even without a Filing record)
        const filingType = result.metadata.filingType
          || (document as any)?.filing?.filingType
          || document?.documentType
          || undefined;
        let volumeNumber: number | undefined = result.metadata.volumeNumber || (document as any)?.filing?.volumeNumber;
        // Extract volume number from filename as fallback (e.g. "-VOL002" or "-VOL2")
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

        // Build citation input
        const totalVolumes = filingType ? (caseCtx.volumeCountMap.get(filingType) ?? 1) : 1;
        const filing = (document as any)?.filing;
        const citationInput: CitationInput = {
          filingType,
          volumeNumber,
          totalVolumes,
          caseNumber: caseNumber || undefined,
          pageNumber: result.metadata.pageNumber,
          fileName: document?.fileName,
          isSupplemental: filing?.isSupplemental || false,
          supplementalOrder: filing?.supplementalOrder || undefined,
        };

        // Line numbers for Reporter's Record filings: prefer stored metadata, fall back to detection
        if (filingType) {
          const ft = filingType.toLowerCase();
          if (ft.includes("reporter") || ft === 'rr') {
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

        // Draft guard: prefer the chunk stamp, fall back to the Document tag
        // (chunks indexed before the column existed and not yet backfilled).
        const chunkRecordStatus = result.metadata.recordStatus
          ?? (recordStatusFromTags((document as any)?.tags) === 'unknown'
            ? undefined
            : recordStatusFromTags((document as any)?.tags));
        const draftSuffix = chunkRecordStatus === 'draft' ? ` — ${DRAFT_CITE_MARKER}` : '';

        return {
          text: result.text,
          document: document?.fileName || 'Unknown',
          page: result.metadata.pageNumber,
          score: result.score,
          citation: formatted.full + draftSuffix,
          citationShort: formatted.short + draftSuffix,
          recordStatus: chunkRecordStatus,
          filingType,
          volumeNumber,
          caseNumber: caseNumber || undefined,
          caseId: rowCaseId,
          // Filled by the batched motion lookup below — one query for the
          // whole result set, never one per item.
          motionId: undefined as string | undefined,
          filingSlug: (document as any)?.filing?.slug || undefined,
          annotations: result.metadata.annotations || undefined,
          // Structure metadata (task #13 phases 1-2) — optional, absent on
          // chunks indexed before the columns existed and not yet backfilled
          documentId: result.metadata.documentId || undefined,
          blockType: result.metadata.blockType || undefined,
          headingPath: result.metadata.headingPath || undefined,
          speakers: result.metadata.speakers || undefined,
          tableMarkdown: result.metadata.tableMarkdown || undefined,
        };
      }),
    );

    await attachMotionIds(context, enrichedResults, docFilingIds);

    markPhase('hydrate');
    context.logger.info('[qck-timing] phase breakdown', {
      searchMode,
      totalMs: Date.now() - phaseStart,
      ...phaseTimings,
    });
    context.logger.info('Query completed', {
      resultCount: enrichedResults.length,
      // One formatter per case in scope now, so log the set rather than one id.
      formatters: [...new Set([...citationContexts.values()].map((c) => c.formatter.id))],
    });

    return {
      results: enrichedResults,
      retrieval: {
        searchModeRequested: searchMode,
        searchModeEffective,
        vectorSearchApplied: queryEmbedding !== undefined,
        rerankApplied: rerankOutcome?.applied ?? false,
        ...(rerankOutcome && !rerankOutcome.applied
          ? { rerankSkipReason: rerankOutcome.reason }
          : {}),
        ...(rerankOutcome ? { rerankPoolIn: rerankOutcome.poolIn } : {}),
      },
      warnings,
    };
  }
}

