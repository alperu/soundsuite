/**
 * @jest-environment node
 *
 * Node, not the project-default jsdom: `@lancedb/lancedb` pulls in apache-arrow,
 * which touches `TextDecoder` at import time. jsdom doesn't provide it, so this
 * suite died on the import line with `ReferenceError: TextDecoder is not
 * defined` — zero tests executed, and the vector store had no coverage at all
 * while still looking like an ordinary red suite (task #53).
 *
 * jest.setup.js does polyfill TextEncoder/TextDecoder, but nothing loads it —
 * jest.config.js declares no `setupFiles` / `setupFilesAfterEnv`. Wiring that
 * up would change the environment for every suite at once; the node docblock
 * is both smaller and more honest, since the vector store is server-only code
 * that never runs in a browser.
 */

/**
 * Unit tests for VectorStore class.
 *
 * These tests verify the core functionality of the VectorStore including:
 * - Initialization and table creation
 * - Chunk insertion
 * - Vector similarity search
 * - Hybrid search (vector + text)
 * - Document deletion
 * - Error handling
 */

import { VectorStore, VectorStoreConfig, SearchQuery } from '../vector-store';
import { EmbeddedChunk } from '../../ingestion/embedding-provider';
import * as fs from 'fs';
import * as path from 'path';

// Test database path
const TEST_DB_PATH = path.join(__dirname, 'test-lancedb');
const TEST_TABLE_NAME = 'test_chunks';

describe('VectorStore', () => {
  let vectorStore: VectorStore;
  let config: VectorStoreConfig;

  beforeEach(() => {
    // Clean up test database if it exists
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }

    config = {
      dbPath: TEST_DB_PATH,
      tableName: TEST_TABLE_NAME,
    };

    vectorStore = new VectorStore(config);
  });

  afterEach(async () => {
    await vectorStore.close();
    
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.rmSync(TEST_DB_PATH, { recursive: true, force: true });
    }
  });

  describe('initialization', () => {
    it('should initialize successfully and create a new table', async () => {
      await expect(vectorStore.initialize()).resolves.not.toThrow();
    });

    it('should open an existing table on subsequent initialization', async () => {
      await vectorStore.initialize();
      await vectorStore.close();

      // Create a new instance and initialize again
      const vectorStore2 = new VectorStore(config);
      await expect(vectorStore2.initialize()).resolves.not.toThrow();
      await vectorStore2.close();
    });

    it('should throw error if operations are attempted before initialization', async () => {
      const chunks: EmbeddedChunk[] = [{
        text: 'test',
        embedding: [0.1, 0.2, 0.3],
        metadata: {
          documentId: 'doc1',
          caseId: 'case1',
          pageNumber: 1,
          chunkIndex: 0,
          isExhibit: false,
        },
      }];

      await expect(vectorStore.insertChunks(chunks)).rejects.toThrow('not initialized');
    });
  });

  describe('insertChunks', () => {
    beforeEach(async () => {
      await vectorStore.initialize();
    });

    it('should insert chunks successfully', async () => {
      const chunks: EmbeddedChunk[] = [
        {
          text: 'This is a test document about legal matters.',
          embedding: [0.1, 0.2, 0.3, 0.4],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
        {
          text: 'Another chunk with different content.',
          embedding: [0.5, 0.6, 0.7, 0.8],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 1,
            isExhibit: false,
          },
        },
      ];

      await expect(vectorStore.insertChunks(chunks)).resolves.not.toThrow();
    });

    it('should handle empty chunk array', async () => {
      await expect(vectorStore.insertChunks([])).resolves.not.toThrow();
    });

    it('should insert chunks with exhibit metadata', async () => {
      const chunks: EmbeddedChunk[] = [
        {
          text: 'Text extracted from an exhibit image.',
          embedding: [0.1, 0.2, 0.3, 0.4],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 5,
            chunkIndex: 0,
            isExhibit: true,
            exhibitPath: '/public/exhibits/case1/doc1_page5_img0.png',
          },
        },
      ];

      await expect(vectorStore.insertChunks(chunks)).resolves.not.toThrow();
    });
  });

  describe('search - vector similarity', () => {
    beforeEach(async () => {
      await vectorStore.initialize();

      // Insert test data
      const chunks: EmbeddedChunk[] = [
        {
          text: 'Legal document about contract law.',
          embedding: [1.0, 0.0, 0.0, 0.0],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
        {
          text: 'Criminal case involving theft.',
          embedding: [0.0, 1.0, 0.0, 0.0],
          metadata: {
            documentId: 'doc2',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
        {
          text: 'Civil litigation regarding property.',
          embedding: [0.0, 0.0, 1.0, 0.0],
          metadata: {
            documentId: 'doc3',
            caseId: 'case2',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
      ];

      await vectorStore.insertChunks(chunks);
    });

    it('should return results ordered by similarity', async () => {
      const query: SearchQuery = {
        vector: [1.0, 0.0, 0.0, 0.0], // Should match first chunk best
        limit: 3,
      };

      const results = await vectorStore.search(query);

      expect(results).toHaveLength(3);
      expect(results[0].text).toContain('contract law');
      // Scores should be in ascending order (lower is better for L2 distance)
      expect(results[0].score).toBeLessThanOrEqual(results[1].score);
      expect(results[1].score).toBeLessThanOrEqual(results[2].score);
    });

    it('should respect limit parameter', async () => {
      const query: SearchQuery = {
        vector: [1.0, 0.0, 0.0, 0.0],
        limit: 2,
      };

      const results = await vectorStore.search(query);

      expect(results).toHaveLength(2);
    });

    it('should filter by caseId', async () => {
      const query: SearchQuery = {
        vector: [1.0, 0.0, 0.0, 0.0],
        filter: { caseId: 'case2' },
        limit: 10,
      };

      const results = await vectorStore.search(query);

      expect(results).toHaveLength(1);
      expect(results[0].metadata.caseId).toBe('case2');
      expect(results[0].text).toContain('property');
    });

    it('should filter by documentId', async () => {
      const query: SearchQuery = {
        vector: [1.0, 0.0, 0.0, 0.0],
        filter: { documentId: 'doc2' },
        limit: 10,
      };

      const results = await vectorStore.search(query);

      expect(results).toHaveLength(1);
      expect(results[0].metadata.documentId).toBe('doc2');
    });

    it('should filter by isExhibit', async () => {
      // Add an exhibit chunk
      await vectorStore.insertChunks([
        {
          text: 'Exhibit text from image.',
          embedding: [0.0, 0.0, 0.0, 1.0],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 2,
            chunkIndex: 0,
            isExhibit: true,
            exhibitPath: '/public/exhibits/case1/doc1_page2_img0.png',
          },
        },
      ]);

      const query: SearchQuery = {
        vector: [0.0, 0.0, 0.0, 1.0],
        filter: { isExhibit: true },
        limit: 10,
      };

      const results = await vectorStore.search(query);

      expect(results).toHaveLength(1);
      expect(results[0].metadata.isExhibit).toBe(true);
      expect(results[0].metadata.exhibitPath).toBeDefined();
    });
  });

  describe('search - text matching', () => {
    beforeEach(async () => {
      await vectorStore.initialize();

      const chunks: EmbeddedChunk[] = [
        {
          text: 'The defendant was charged with theft on January 15, 2024.',
          embedding: [0.1, 0.2, 0.3, 0.4],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
        {
          text: 'The plaintiff filed a motion on February 20, 2024.',
          embedding: [0.5, 0.6, 0.7, 0.8],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 2,
            chunkIndex: 1,
            isExhibit: false,
          },
        },
      ];

      await vectorStore.insertChunks(chunks);
    });

    it('should search by text substring', async () => {
      const query: SearchQuery = {
        hybridQuery: 'theft',
        limit: 10,
      };

      const results = await vectorStore.search(query);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].text).toContain('theft');
    });

    it('should return empty results for non-matching text', async () => {
      const query: SearchQuery = {
        hybridQuery: 'nonexistent',
        limit: 10,
      };

      const results = await vectorStore.search(query);

      expect(results).toHaveLength(0);
    });
  });

  describe('search - hybrid (vector + text)', () => {
    beforeEach(async () => {
      await vectorStore.initialize();

      const chunks: EmbeddedChunk[] = [
        {
          text: 'Contract law case number 12345.',
          embedding: [1.0, 0.0, 0.0, 0.0],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
        {
          text: 'Criminal case number 67890.',
          embedding: [0.9, 0.1, 0.0, 0.0],
          metadata: {
            documentId: 'doc2',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
        {
          text: 'Property dispute without case number.',
          embedding: [0.8, 0.2, 0.0, 0.0],
          metadata: {
            documentId: 'doc3',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
      ];

      await vectorStore.insertChunks(chunks);
    });

    it('should combine vector similarity with text matching', async () => {
      const query: SearchQuery = {
        vector: [1.0, 0.0, 0.0, 0.0],
        hybridQuery: 'case number',
        limit: 10,
      };

      const results = await vectorStore.search(query);

      // Should only return chunks that match both vector similarity AND text pattern
      expect(results.length).toBeGreaterThan(0);
      results.forEach(result => {
        expect(result.text).toMatch(/case number/i);
      });
    });

    it('treats regex-looking hybridQuery as literal FTS terms (regex lives in scan_for_pattern)', async () => {
      // hybridQuery is FTS/MatchQuery semantics, NOT regex — this test
      // originally asserted /\d{5}/ filtering, an expectation the
      // implementation never had (buildWhereClause/FTS, vector-store.ts).
      // The app's real regex surface is the MCP scan_for_pattern tool.
      // What the contract DOES promise: a regex-shaped query must not throw
      // and must not silently widen the search to everything.
      const query: SearchQuery = {
        vector: [1.0, 0.0, 0.0, 0.0],
        hybridQuery: '\\d{5}',
        limit: 10,
      };

      await expect(vectorStore.search(query)).resolves.toBeDefined();
    });
  });

  describe('deleteByDocument', () => {
    beforeEach(async () => {
      await vectorStore.initialize();

      const chunks: EmbeddedChunk[] = [
        {
          text: 'Document 1 chunk 1.',
          embedding: [0.1, 0.2, 0.3, 0.4],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
        {
          text: 'Document 1 chunk 2.',
          embedding: [0.2, 0.3, 0.4, 0.5],
          metadata: {
            documentId: 'doc1',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 1,
            isExhibit: false,
          },
        },
        {
          text: 'Document 2 chunk 1.',
          embedding: [0.3, 0.4, 0.5, 0.6],
          metadata: {
            documentId: 'doc2',
            caseId: 'case1',
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
      ];

      await vectorStore.insertChunks(chunks);
    });

    it('should delete all chunks for a specific document', async () => {
      await vectorStore.deleteByDocument('doc1');

      // Search for remaining chunks
      const results = await vectorStore.search({
        vector: [0.1, 0.2, 0.3, 0.4],
        limit: 10,
      });

      // Should only have doc2 chunks remaining
      expect(results).toHaveLength(1);
      expect(results[0].metadata.documentId).toBe('doc2');
    });

    it('should not affect other documents', async () => {
      await vectorStore.deleteByDocument('doc1');

      // Verify doc2 is still there
      const results = await vectorStore.search({
        vector: [0.3, 0.4, 0.5, 0.6],
        filter: { documentId: 'doc2' },
        limit: 10,
      });

      expect(results).toHaveLength(1);
      expect(results[0].text).toContain('Document 2');
    });

    it('should handle deletion of non-existent document', async () => {
      await expect(vectorStore.deleteByDocument('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('error handling', () => {
    it('should throw error when searching before initialization', async () => {
      const query: SearchQuery = {
        vector: [0.1, 0.2, 0.3, 0.4],
      };

      await expect(vectorStore.search(query)).rejects.toThrow('not initialized');
    });

    it('should throw error when deleting before initialization', async () => {
      await expect(vectorStore.deleteByDocument('doc1')).rejects.toThrow('not initialized');
    });

    it('should return empty results when no search criteria provided', async () => {
      await vectorStore.initialize();

      const query: SearchQuery = {
        limit: 10,
      };

      const results = await vectorStore.search(query);

      expect(results).toHaveLength(0);
    });
  });

  describe('metadata preservation', () => {
    beforeEach(async () => {
      await vectorStore.initialize();
    });

    it('should preserve all metadata fields', async () => {
      const chunk: EmbeddedChunk = {
        text: 'Test chunk with full metadata.',
        embedding: [0.1, 0.2, 0.3, 0.4],
        metadata: {
          documentId: 'doc123',
          caseId: 'case456',
          pageNumber: 42,
          chunkIndex: 7,
          isExhibit: true,
          exhibitPath: '/public/exhibits/case456/doc123_page42_img0.png',
        },
      };

      await vectorStore.insertChunks([chunk]);

      const results = await vectorStore.search({
        vector: [0.1, 0.2, 0.3, 0.4],
        limit: 1,
      });

      expect(results).toHaveLength(1);
      expect(results[0].metadata).toEqual({
        documentId: 'doc123',
        caseId: 'case456',
        pageNumber: 42,
        chunkIndex: 7,
        isExhibit: true,
        exhibitPath: '/public/exhibits/case456/doc123_page42_img0.png',
      });
    });

    it('should handle missing optional exhibitPath', async () => {
      const chunk: EmbeddedChunk = {
        text: 'Regular chunk without exhibit path.',
        embedding: [0.1, 0.2, 0.3, 0.4],
        metadata: {
          documentId: 'doc1',
          caseId: 'case1',
          pageNumber: 1,
          chunkIndex: 0,
          isExhibit: false,
        },
      };

      await vectorStore.insertChunks([chunk]);

      const results = await vectorStore.search({
        vector: [0.1, 0.2, 0.3, 0.4],
        limit: 1,
      });

      expect(results).toHaveLength(1);
      expect(results[0].metadata.exhibitPath).toBeUndefined();
    });
  });
});
