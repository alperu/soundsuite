/**
 * VectorStore class for managing LanceDB vector database operations.
 *
 * This class provides an interface for storing and searching document embeddings
 * using LanceDB, a high-performance embedded vector database. It supports:
 * - Vector similarity search for semantic queries
 * - Full-text search with BM25 scoring via LanceDB native FTS
 * - Hybrid search combining vector + FTS with native RRF reranking
 * - Metadata filtering by case, document, and exhibit type
 *
 * Requirements: 5.4, 6.1, 6.2, 6.3
 */

import * as lancedb from '@lancedb/lancedb';
import {
  MatchQuery,
  BooleanQuery,
  Occur,
  Operator,
  rerankers,
  type FullTextQuery,
} from '@lancedb/lancedb';
import { EmbeddedChunk } from '../ingestion/embedding-provider';
import { logger } from '@/lib/logger';

// Re-export query types for consumers
export { MatchQuery, PhraseQuery, BooleanQuery, Occur, Operator } from '@lancedb/lancedb';
export type { FullTextQuery } from '@lancedb/lancedb';

/**
 * Configuration for VectorStore
 */
export interface VectorStoreConfig {
  /** Path to the LanceDB database directory */
  dbPath: string;
  /** Name of the table to use for storing chunks */
  tableName: string;
}

/**
 * Search query parameters
 */
export interface SearchQuery {
  /** Embedding vector for similarity search (optional) */
  vector?: number[];
  /** Metadata filters to apply */
  filter?: Record<string, any>;
  /** Maximum number of results to return */
  limit?: number;
  /** Regex pattern or full-text search query for hybrid search (backward compat) */
  hybridQuery?: string;
  /** Structured FTS query — string for MatchQuery, or a pre-built FullTextQuery */
  ftsQuery?: string | FullTextQuery;
}

/**
 * Search result with metadata and score
 */
export interface SearchResult {
  /** Unique chunk identifier */
  chunkId: string;
  /** The text content of the chunk */
  text: string;
  /** Metadata about the chunk */
  metadata: {
    documentId: string;
    caseId: string;
    pageNumber: number;
    chunkIndex: number;
    isExhibit: boolean;
    exhibitPath?: string;
    filingId?: string;
    filingType?: string;
    volumeNumber?: number;
    caseNumber?: string;
    documentType?: string;
    /** First transcript line number in this chunk (RR documents) */
    startLine?: number;
    /** Last transcript line number in this chunk (RR documents) */
    endLine?: number;
    /** JSON-encoded PageAnnotation[] for annotations overlapping this chunk */
    annotations?: string;
  };
  /** Similarity score (lower is better for L2 distance, higher for RRF) */
  score: number;
}

/**
 * LanceDB row schema
 */
interface LanceDBRow {
  id: string;
  vector: number[];
  text: string;
  document_id: string;
  case_id: string;
  page_number: number;
  chunk_index: number;
  is_exhibit: boolean;
  exhibit_path: string; // Empty string instead of null for non-exhibits
  filing_id: string;
  filing_type: string;
  volume_number: number;
  case_number: string;
  document_type: string;
  start_line: number;
  end_line: number;
  annotations: string;
  created_at: number;
  [key: string]: any; // Index signature for LanceDB compatibility
}

/**
 * VectorStore manages document embeddings in LanceDB.
 *
 * This class provides high-level operations for storing and searching
 * vector embeddings with associated metadata. It handles:
 * - Database initialization and table creation
 * - Batch insertion of embedded chunks
 * - Vector similarity search
 * - Full-text search with BM25 via native LanceDB FTS index
 * - Hybrid search (vector + FTS) with native RRF reranking
 * - Document cleanup operations
 */
export class VectorStore {
  private config: VectorStoreConfig;
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private storedVectorDim: number | null = null;
  private _hasFtsIndex = false;
  private rrfReranker: rerankers.RRFReranker | null = null;

  constructor(config: VectorStoreConfig) {
    this.config = config;
  }

  /** Whether a FTS index exists on the text column */
  get hasFtsIndex(): boolean {
    return this._hasFtsIndex;
  }

  /**
   * Initialize the LanceDB connection and create/open the table.
   * Also ensures the FTS index exists on the text column.
   */
  async initialize(): Promise<void> {
    try {
      // Connect to LanceDB
      this.db = await lancedb.connect(this.config.dbPath);

      // Check if table exists
      const tableNames = await this.db.tableNames();

      if (tableNames.includes(this.config.tableName)) {
        // Open existing table
        this.table = await this.db.openTable(this.config.tableName);
        // Try to create FTS index (idempotent)
        await this.ensureFtsIndex();
      } else {
        // Create new table - LanceDB will be created on first insert
        // We'll store a reference that the table needs to be created
        this.table = null;
      }
    } catch (error) {
      throw new Error(`Failed to initialize VectorStore: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Ensure a full-text search index exists on the "text" column.
   * Checks existing indices first to avoid recreating. Idempotent.
   */
  async ensureFtsIndex(): Promise<void> {
    if (!this.table) return;

    try {
      // Check if FTS index already exists
      const indices = await this.table.listIndices();
      const hasFts = indices.some(
        (idx: any) => idx.indexType === 'INVERTED' || idx.columns?.includes('text')
      );

      if (hasFts) {
        this._hasFtsIndex = true;
        logger.info('FTS index already exists on text column');
        return;
      }

      // Create FTS index on the text column
      await this.table.createIndex('text', {
        config: lancedb.Index.fts({
          withPosition: true,
          baseTokenizer: 'simple',
          language: 'English',
          stem: true,
          removeStopWords: true,
          asciiFolding: true,
        }),
      });

      this._hasFtsIndex = true;
      logger.info('Created FTS index on text column');
    } catch (error) {
      // Non-fatal — fall back to legacy LIKE search
      logger.warn('Failed to create FTS index, falling back to LIKE search', {
        error: error instanceof Error ? error.message : String(error),
      });
      this._hasFtsIndex = false;
    }
  }

  /**
   * Insert embedded chunks into the vector store.
   */
  async insertChunks(chunks: EmbeddedChunk[]): Promise<void> {
    if (!this.db) {
      throw new Error('VectorStore not initialized. Call initialize() first.');
    }

    if (chunks.length === 0) {
      return;
    }

    // Convert chunks to LanceDB rows (outside try so catch can reference them for table recreation)
    const rows: LanceDBRow[] = chunks.map((chunk) => ({
      id: this.generateId(),
      vector: chunk.embedding,
      text: chunk.text,
      document_id: chunk.metadata.documentId,
      case_id: chunk.metadata.caseId,
      page_number: chunk.metadata.pageNumber,
      chunk_index: chunk.metadata.chunkIndex,
      is_exhibit: chunk.metadata.isExhibit,
      exhibit_path: chunk.metadata.exhibitPath || '',
      filing_id: chunk.metadata.filingId || '',
      filing_type: chunk.metadata.filingType || '',
      volume_number: chunk.metadata.volumeNumber ?? 0,
      case_number: chunk.metadata.caseNumber || '',
      document_type: chunk.metadata.documentType || '',
      start_line: chunk.metadata.startLine ?? 0,
      end_line: chunk.metadata.endLine ?? 0,
      annotations: chunk.metadata.annotations || '',
      created_at: Date.now(),
    }));

    try {
      // Create table if it doesn't exist yet
      if (!this.table) {
        this.table = await this.db.createTable(this.config.tableName, rows);
        // Create FTS index on new table
        await this.ensureFtsIndex();
      } else {
        // Insert rows into existing table
        await this.table.add(rows);
      }

      // Invalidate cached dimension so next search re-checks
      this.storedVectorDim = null;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // Schema evolved — try non-destructive addColumns first, then fall back to drop+recreate
      if (errMsg.includes('not in schema') && this.db && this.table) {
        // Extract missing column name from error (e.g. "annotations not in schema")
        const missingCol = errMsg.match(/(\w+)\s+not in schema/)?.[1];
        if (missingCol) {
          try {
            logger.info('Adding missing column to LanceDB table', { column: missingCol });
            await this.table.addColumns([{ name: missingCol, valueSql: "''" }]);
            // Retry the insert after adding the column
            await this.table.add(rows);
            this.storedVectorDim = null;
            return;
          } catch (addColErr) {
            logger.warn('addColumns failed, falling back to table recreate', {
              error: addColErr instanceof Error ? addColErr.message : String(addColErr),
            });
          }
        }

        // Fallback: drop and recreate
        logger.warn('LanceDB schema mismatch detected, recreating table', { error: errMsg });
        await this.db.dropTable(this.config.tableName);
        this.table = await this.db.createTable(this.config.tableName, rows);
        this.storedVectorDim = null;
        await this.ensureFtsIndex();
        return;
      }

      throw new Error(`Failed to insert chunks: ${errMsg}`);
    }
  }

  /**
   * Perform search. Routes to the best available method based on query params
   * and whether FTS index is available.
   */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    if (!this.db) {
      throw new Error('VectorStore not initialized. Call initialize() first.');
    }

    try {
      const limit = query.limit || 10;

      // Resolve FTS query: prefer explicit ftsQuery, fall back to hybridQuery
      const ftsInput = query.ftsQuery || query.hybridQuery;

      // Handle hybrid search (vector + text matching)
      if (query.vector && ftsInput) {
        if (this._hasFtsIndex) {
          return await this.hybridSearch(query.vector, ftsInput, query.filter, limit);
        }
        // Fallback to legacy hybrid if no FTS index
        const textQuery = typeof ftsInput === 'string' ? ftsInput : query.hybridQuery || '';
        return await this.legacyHybridSearch(query.vector, textQuery, query.filter, limit);
      }

      // Handle pure vector search
      if (query.vector) {
        return await this.vectorSearch(query.vector, query.filter, limit);
      }

      // Handle pure text search (no vector)
      if (ftsInput) {
        if (this._hasFtsIndex) {
          return await this.ftsSearch(ftsInput, query.filter, limit);
        }
        const textQuery = typeof ftsInput === 'string' ? ftsInput : query.hybridQuery || '';
        return await this.legacyTextSearch(textQuery, query.filter, limit);
      }

      // No search criteria provided
      return [];
    } catch (error) {
      throw new Error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the vector dimension of stored data (cached after first call).
   */
  private async getStoredVectorDimension(): Promise<number | null> {
    if (this.storedVectorDim !== null) return this.storedVectorDim;
    if (!this.table) return null;
    try {
      const rows = await this.table.query().limit(1).toArray();
      if (rows.length > 0 && rows[0].vector) {
        this.storedVectorDim = rows[0].vector.length;
        return this.storedVectorDim;
      }
    } catch {
      // Table may be empty
    }
    return null;
  }

  /**
   * Perform pure vector similarity search.
   */
  private async vectorSearch(
    vector: number[],
    filter?: Record<string, any>,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error('Table not initialized');
    }

    // Check for dimension mismatch before searching
    const storedDim = await this.getStoredVectorDimension();
    if (storedDim !== null && storedDim !== vector.length) {
      throw new Error(
        `Embedding dimension mismatch: query=${vector.length}, stored=${storedDim}. ` +
        `The embedding model was changed after documents were indexed. ` +
        `Reindex documents from Admin > Embedding Config.`
      );
    }

    let queryBuilder = this.table.search(vector).limit(limit);

    // Apply filters if provided
    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        queryBuilder = queryBuilder.where(whereClause);
      }
    }

    const results = await queryBuilder.toArray();

    return results.map((row: any) => this.rowToSearchResult(row));
  }

  /**
   * Perform FTS search using LanceDB native full-text search with BM25 scoring.
   * Accepts either a raw string (auto-wrapped in MatchQuery) or a pre-built FullTextQuery.
   */
  private async ftsSearch(
    ftsQuery: string | FullTextQuery,
    filter?: Record<string, any>,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error('Table not initialized');
    }

    // Build the FTS query object if given a plain string
    const query: string | FullTextQuery = typeof ftsQuery === 'string'
      ? new MatchQuery(ftsQuery, 'text', { operator: Operator.Or })
      : ftsQuery;

    let queryBuilder = this.table.query().fullTextSearch(query).limit(limit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        queryBuilder = queryBuilder.where(whereClause);
      }
    }

    const results = await queryBuilder.toArray();

    return results.map((row: any) => ({
      ...this.rowToSearchResult(row),
      score: row._score !== undefined ? row._score : 0,
    }));
  }

  /**
   * Perform hybrid search using native LanceDB vector + FTS with RRF reranking.
   * Single I/O pass — faster than two parallel queries.
   */
  private async hybridSearch(
    vector: number[],
    ftsQuery: string | FullTextQuery,
    filter?: Record<string, any>,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error('Table not initialized');
    }

    // Check for dimension mismatch
    const storedDim = await this.getStoredVectorDimension();
    if (storedDim !== null && storedDim !== vector.length) {
      throw new Error(
        `Embedding dimension mismatch: query=${vector.length}, stored=${storedDim}. ` +
        `The embedding model was changed after documents were indexed. ` +
        `Reindex documents from Admin > Embedding Config.`
      );
    }

    // Build the FTS query object if given a plain string
    const fts: string | FullTextQuery = typeof ftsQuery === 'string'
      ? new MatchQuery(ftsQuery, 'text', { operator: Operator.Or })
      : ftsQuery;

    // Get or create the RRF reranker (cached)
    if (!this.rrfReranker) {
      this.rrfReranker = await rerankers.RRFReranker.create(60);
    }

    let queryBuilder = this.table
      .vectorSearch(vector)
      .fullTextSearch(fts)
      .rerank(this.rrfReranker)
      .limit(limit);

    if (filter) {
      const whereClause = this.buildWhereClause(filter);
      if (whereClause) {
        queryBuilder = queryBuilder.where(whereClause);
      }
    }

    const results = await queryBuilder.toArray();

    return results.map((row: any) => ({
      ...this.rowToSearchResult(row),
      score: row._relevance_score !== undefined ? row._relevance_score : (row._distance !== undefined ? row._distance : 0),
    }));
  }

  /**
   * Legacy text search using SQL LIKE. Used as fallback when FTS index is unavailable.
   */
  private async legacyTextSearch(
    textQuery: string,
    filter?: Record<string, any>,
    limit: number = 10
  ): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error('Table not initialized');
    }

    // Build where clause for text matching
    let whereClause = `text LIKE '%${this.escapeString(textQuery)}%'`;

    // Add additional filters
    if (filter) {
      const additionalFilters = this.buildWhereClause(filter);
      if (additionalFilters) {
        whereClause = `${whereClause} AND ${additionalFilters}`;
      }
    }

    // Use query builder with where clause
    const results = await this.table
      .query()
      .where(whereClause)
      .limit(limit)
      .toArray();

    return results.map((row: any) => ({
      ...this.rowToSearchResult(row),
      score: 0, // No similarity score for text-only search
    }));
  }

  /**
   * Legacy hybrid search using manual RRF. Used as fallback when FTS index is unavailable.
   */
  private async legacyHybridSearch(
    vector: number[],
    textQuery: string,
    filter?: Record<string, any>,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const expandedLimit = limit * 3;

    // Run both searches in parallel
    const [vectorResults, textResults] = await Promise.all([
      this.vectorSearch(vector, filter, expandedLimit),
      this.legacyTextSearch(textQuery, filter, expandedLimit),
    ]);

    // RRF constant (commonly 60)
    const k = 60;

    // Build score map: chunkId -> { result, rrfScore }
    const scoreMap = new Map<string, { result: SearchResult; rrfScore: number }>();

    // Add vector results with RRF scores
    for (let i = 0; i < vectorResults.length; i++) {
      const result = vectorResults[i];
      const rrfScore = 1 / (k + i + 1);
      scoreMap.set(result.chunkId, { result, rrfScore });
    }

    // Add text results, merging RRF scores for duplicates
    for (let i = 0; i < textResults.length; i++) {
      const result = textResults[i];
      const rrfScore = 1 / (k + i + 1);
      const existing = scoreMap.get(result.chunkId);
      if (existing) {
        existing.rrfScore += rrfScore;
      } else {
        scoreMap.set(result.chunkId, { result, rrfScore });
      }
    }

    // Sort by combined RRF score (higher is better) and take top results
    const merged = Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit)
      .map(({ result, rrfScore }) => ({
        ...result,
        score: rrfScore,
      }));

    return merged;
  }

  /**
   * Fetch chunks for a specific document without requiring a vector or text
   * query. Used by code paths that just want to read the indexed text (e.g.
   * tag-fill extractor) — `search()` requires either a vector or FTS input
   * and returns [] otherwise. This method bypasses that constraint.
   */
  async findByDocument(documentId: string, limit = 60): Promise<SearchResult[]> {
    if (!this.db || !this.table) return [];
    try {
      const rows = await this.table
        .query()
        .where(`document_id = "${documentId}"`)
        .limit(limit)
        .toArray();
      return rows.map((r) => this.rowToSearchResult(r));
    } catch (error) {
      console.warn(`[VectorStore] findByDocument(${documentId}) failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Delete all chunks associated with a specific document.
   */
  async deleteByDocument(documentId: string): Promise<void> {
    if (!this.db) {
      throw new Error('VectorStore not initialized. Call initialize() first.');
    }

    if (!this.table) {
      // Table doesn't exist yet, nothing to delete
      return;
    }

    try {
      await this.table.delete(`document_id = "${documentId}"`);
    } catch (error) {
      throw new Error(`Failed to delete chunks for document ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Delete chunks for specific pages of a document.
   * Used for selective page reindexing without clearing the entire document.
   */
  async deleteByPages(documentId: string, pageNumbers: number[]): Promise<void> {
    if (!this.db) {
      throw new Error('VectorStore not initialized. Call initialize() first.');
    }

    if (!this.table || pageNumbers.length === 0) {
      return;
    }

    try {
      const pageList = pageNumbers.join(', ');
      await this.table.delete(`document_id = "${documentId}" AND page_number IN (${pageList})`);
    } catch (error) {
      throw new Error(`Failed to delete chunks for pages [${pageNumbers.join(', ')}] of document ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Build a WHERE clause from filter object.
   */
  private buildWhereClause(filter: Record<string, any>): string {
    const conditions: string[] = [];

    if (filter.caseId) {
      conditions.push(`case_id = "${filter.caseId}"`);
    }

    if (filter.documentId) {
      conditions.push(`document_id = "${filter.documentId}"`);
    }

    if (filter.isExhibit !== undefined) {
      conditions.push(`is_exhibit = ${filter.isExhibit}`);
    }

    if (filter.pageNumber !== undefined) {
      conditions.push(`page_number = ${filter.pageNumber}`);
    }

    if (filter.filingType) {
      conditions.push(`filing_type = "${filter.filingType}"`);
    }

    if (filter.caseNumber) {
      conditions.push(`case_number = "${filter.caseNumber}"`);
    }

    if (filter.documentType) {
      conditions.push(`document_type = "${filter.documentType}"`);
    }

    return conditions.join(' AND ');
  }

  /**
   * Convert a LanceDB row to a SearchResult.
   */
  private rowToSearchResult(row: any): SearchResult {
    return {
      chunkId: row.id,
      text: row.text,
      metadata: {
        documentId: row.document_id,
        caseId: row.case_id,
        pageNumber: row.page_number,
        chunkIndex: row.chunk_index,
        isExhibit: row.is_exhibit,
        exhibitPath: row.exhibit_path && row.exhibit_path !== '' ? row.exhibit_path : undefined,
        filingId: row.filing_id && row.filing_id !== '' ? row.filing_id : undefined,
        filingType: row.filing_type && row.filing_type !== '' ? row.filing_type : undefined,
        volumeNumber: row.volume_number && row.volume_number !== 0 ? row.volume_number : undefined,
        caseNumber: row.case_number && row.case_number !== '' ? row.case_number : undefined,
        documentType: row.document_type && row.document_type !== '' ? row.document_type : undefined,
        startLine: row.start_line && row.start_line !== 0 ? row.start_line : undefined,
        endLine: row.end_line && row.end_line !== 0 ? row.end_line : undefined,
        annotations: row.annotations && row.annotations !== '' ? row.annotations : undefined,
      },
      score: row._distance !== undefined ? row._distance : 0,
    };
  }

  /**
   * Generate a unique ID for a chunk.
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Check if a string is a valid regex pattern.
   */
  private isValidRegex(pattern: string): boolean {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Escape special regex characters in a string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Escape string for SQL LIKE clause.
   */
  private escapeString(str: string): string {
    return str.replace(/'/g, "''");
  }

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    // LanceDB connections are automatically managed
    this.db = null;
    this.table = null;
    this._hasFtsIndex = false;
    this.rrfReranker = null;
  }
}
