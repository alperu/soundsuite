import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { SearchQuery, MatchQuery, BooleanQuery, Occur, Operator } from '../../vector/vector-store';
import type { FullTextQuery } from '../../vector/vector-store';
import { getCitationFormatter, CitationInput } from '../../citations/citation-formatter';
import { detectLineNumbers } from '../../citations/line-number-detector';
import { QueryPreprocessor } from '../../search/query-preprocessor';
import { rerank } from '../../search/reranker';
import { getChatVectorStore } from '../../chat/chat-vector-store';
import { parseBooleanQuery } from '../../search/boolean-query';
import { astToLanceQuery, BooleanFtsConversionError, extractFieldFilters, resolvePrismaFilters } from '../../search/boolean-to-fts';

export interface QueryCaseKnowledgeParams {
  query: string;
  caseId?: string;
  chatId?: string;
  limit?: number;
  searchMode?: 'vector' | 'hybrid' | 'keyword';
  /** 'boolean' parses the query as a full boolean expression with AND/OR/NOT, phrases, and `-`. */
  mode?: 'legacy' | 'boolean';
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
    annotations?: string;
    source?: 'docket' | 'chat';
    chatAttachmentId?: string;
  }>;
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
        'Perform semantic search on legal documents using natural language queries',
      version: '1.1.0',
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
            description: 'Optional case ID to filter results',
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
        },
        required: ['query'],
      },
    };
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
    const { query, caseId, chatId, limit = 10, searchMode = 'hybrid', mode = 'legacy' } = params;
    const chatHitChunkIds = new Set<string>();

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
        // Re-throw if no fallback path possible (pure vector search would have nothing to do)
        if (searchMode === 'vector') throw err;
        // Otherwise fall through — keyword search can still produce results.
      }
    }

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

    // Apply case filter if provided
    if (caseId) {
      searchQuery.filter = { caseId };
    }

    // Merge field-qualified filter clauses lifted from the boolean AST.
    if (fieldWhereClauses.length > 0) {
      if (!searchQuery.filter) searchQuery.filter = {};
      searchQuery.filter._rawWhere = fieldWhereClauses;
    }

    // Perform primary search
    let searchResults = await context.vectorStore.search(searchQuery);

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
      const metadataFilter: Record<string, any> = { ...(caseId ? { caseId } : {}) };
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
    // Pass explicit topN = limit so the reranker trims from the expanded pool.
    searchResults = await rerank(query, searchResults, limit, context.pushWarning ? (w) => {
      context.pushWarning!({ source: w.source, host: w.host, reason: w.reason, message: w.message });
    } : undefined);

    // Safety trim: if reranking was disabled, ensure we return at most `limit` results
    if (searchResults.length > limit) {
      searchResults = searchResults.slice(0, limit);
    }

    // Look up case metadata for citation formatter selection
    let caseData: { jurisdiction?: string | null; state?: string | null; country?: string | null; caseNumber?: string | null } | null = null;
    if (caseId) {
      caseData = await context.database.case.findUnique({
        where: { id: caseId },
        select: { jurisdiction: true, state: true, country: true, caseNumber: true },
      });
    }

    // Count distinct volumes per filing type for this case (to decide whether to show vol number)
    const volumeCountMap = new Map<string, number>(); // filingType -> distinct volume count
    if (caseId) {
      try {
        const filings = await (context.database as any).filing.findMany({
          where: { caseId },
          select: { filingType: true, volumeNumber: true },
        });
        const typeVolumes = new Map<string, Set<number>>();
        for (const f of filings) {
          if (!f.filingType) continue;
          const key = f.filingType;
          if (!typeVolumes.has(key)) typeVolumes.set(key, new Set());
          typeVolumes.get(key)!.add(f.volumeNumber ?? 1);
        }
        for (const [type, vols] of typeVolumes) {
          volumeCountMap.set(type, vols.size);
        }
      } catch { /* filings may not exist for all cases */ }

      // Supplement volume counts from document filenames (for docs without Filing records)
      // e.g. TRAVIS-D-1-FM-25-004488-RR-VOL002.pdf → "Reporter's Record" vol 2
      try {
        const caseDocs = await context.database.document.findMany({
          where: { caseId },
          select: { fileName: true, documentType: true },
        });
        const docTypeVolumes = new Map<string, Set<number>>();
        for (const doc of caseDocs) {
          const dt = doc.documentType;
          if (!dt) continue;
          const volMatch = doc.fileName?.match(/-VOL(\d+)/i);
          const vol = volMatch ? parseInt(volMatch[1], 10) : 1;
          if (!docTypeVolumes.has(dt)) docTypeVolumes.set(dt, new Set());
          docTypeVolumes.get(dt)!.add(vol);
        }
        for (const [type, vols] of docTypeVolumes) {
          // Only update if we have more volumes than currently known
          const current = volumeCountMap.get(type) ?? 0;
          if (vols.size > current) volumeCountMap.set(type, vols.size);
        }
      } catch { /* ignore */ }
    }

    // Select citation formatter based on case metadata
    const formatter = getCitationFormatter({
      jurisdiction: caseData?.jurisdiction || undefined,
      state: caseData?.state || undefined,
      country: caseData?.country || undefined,
    });

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
            annotations: result.metadata.annotations || undefined,
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
        const caseNumber = result.metadata.caseNumber || (document as any)?.case?.caseNumber || caseData?.caseNumber;

        // Build citation input
        const totalVolumes = filingType ? (volumeCountMap.get(filingType) ?? 1) : 1;
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

        const formatted = formatter.format(citationInput);

        return {
          text: result.text,
          document: document?.fileName || 'Unknown',
          page: result.metadata.pageNumber,
          score: result.score,
          citation: formatted.full,
          citationShort: formatted.short,
          filingType,
          volumeNumber,
          caseNumber: caseNumber || undefined,
          filingSlug: (document as any)?.filing?.slug || undefined,
          annotations: result.metadata.annotations || undefined,
        };
      }),
    );

    context.logger.info('Query completed', { resultCount: enrichedResults.length, formatter: formatter.id });

    return { results: enrichedResults };
  }
}
