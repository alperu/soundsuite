# Vector Store Module

This module provides the `VectorStore` class for managing document embeddings using LanceDB, a high-performance embedded vector database.

## Features

- **Vector Similarity Search**: Find semantically similar chunks using embedding vectors
- **Hybrid Search**: Combine vector similarity with text pattern matching (regex/FTS)
- **Metadata Filtering**: Filter results by case, document, page, or exhibit type
- **Batch Operations**: Efficiently insert multiple chunks at once
- **Document Cleanup**: Delete all chunks associated with a specific document

## Requirements

This module implements the following requirements from the design document:
- **Requirement 5.4**: Store embeddings in LanceDB with metadata
- **Requirement 6.1**: Initialize LanceDB connection and create table
- **Requirement 6.2**: Support vector similarity search
- **Requirement 6.3**: Support hybrid search (vector + regex/FTS)

## Usage

### Basic Example

```typescript
import { VectorStore } from './vector-store';
import { EmbeddedChunk } from '../ingestion/embedding-provider';

// Initialize the vector store
const vectorStore = new VectorStore({
  dbPath: './data/lancedb',
  tableName: 'legal_chunks',
});

await vectorStore.initialize();

// Insert embedded chunks
const chunks: EmbeddedChunk[] = [
  {
    text: 'The defendant was charged with breach of contract.',
    embedding: [0.1, 0.2, 0.3, ...], // 384, 1536, or 3072 dimensions
    metadata: {
      documentId: 'doc-001',
      caseId: 'case-001',
      pageNumber: 1,
      chunkIndex: 0,
      isExhibit: false,
    },
  },
  // ... more chunks
];

await vectorStore.insertChunks(chunks);

// Perform vector similarity search
const results = await vectorStore.search({
  vector: queryEmbedding,
  limit: 10,
});

// Perform hybrid search (vector + text)
const hybridResults = await vectorStore.search({
  vector: queryEmbedding,
  hybridQuery: 'contract', // Can be regex pattern
  limit: 10,
});

// Filter by case
const caseResults = await vectorStore.search({
  vector: queryEmbedding,
  filter: { caseId: 'case-001' },
  limit: 10,
});

// Filter by exhibit type
const exhibitResults = await vectorStore.search({
  vector: queryEmbedding,
  filter: { isExhibit: true },
  limit: 5,
});

// Delete all chunks for a document
await vectorStore.deleteByDocument('doc-001');

// Clean up
await vectorStore.close();
```

## API Reference

### VectorStore

#### Constructor

```typescript
constructor(config: VectorStoreConfig)
```

Creates a new VectorStore instance.

**Parameters:**
- `config.dbPath`: Path to the LanceDB database directory
- `config.tableName`: Name of the table to use for storing chunks

#### Methods

##### `initialize(): Promise<void>`

Initializes the LanceDB connection and creates/opens the table. Must be called before any other operations.

**Throws:** Error if database connection or table creation fails

##### `insertChunks(chunks: EmbeddedChunk[]): Promise<void>`

Inserts embedded chunks into the vector store.

**Parameters:**
- `chunks`: Array of embedded chunks to insert

**Throws:** Error if table is not initialized or insertion fails

##### `search(query: SearchQuery): Promise<SearchResult[]>`

Performs vector similarity search, text search, or hybrid search.

**Parameters:**
- `query.vector`: Embedding vector for similarity search (optional)
- `query.hybridQuery`: Regex pattern or text for matching (optional)
- `query.filter`: Metadata filters (caseId, documentId, isExhibit, pageNumber)
- `query.limit`: Maximum number of results (default: 10)

**Returns:** Array of search results with metadata and scores

**Throws:** Error if table is not initialized or search fails

##### `deleteByDocument(documentId: string): Promise<void>`

Deletes all chunks associated with a specific document.

**Parameters:**
- `documentId`: The document ID to delete chunks for

**Throws:** Error if table is not initialized or deletion fails

##### `close(): Promise<void>`

Closes the database connection and cleans up resources.

## Schema

### LanceDB Table Schema

```typescript
{
  id: string;              // Unique chunk identifier
  vector: number[];        // Embedding vector (384, 1536, or 3072 dims)
  text: string;            // Chunk text content
  document_id: string;     // Source document ID
  case_id: string;         // Case ID
  page_number: number;     // Page number in document
  chunk_index: number;     // Index of chunk within page
  is_exhibit: boolean;     // Whether chunk is from an exhibit
  exhibit_path: string;    // Path to exhibit image (empty for non-exhibits)
  created_at: number;      // Unix timestamp
}
```

## Search Behavior

### Vector Similarity Search

When only `query.vector` is provided, the vector store performs pure vector similarity search using L2 distance. Results are ordered by similarity score (lower is better).

### Text Search

When only `query.hybridQuery` is provided, the vector store performs text matching using SQL LIKE or regex patterns.

### Hybrid Search

When both `query.vector` and `query.hybridQuery` are provided, the vector store:
1. Performs vector similarity search with a higher limit (3x)
2. Filters results to only include chunks matching the text pattern
3. Returns the top-K results ordered by similarity score

This ensures results are both semantically relevant AND contain the specified text pattern.

## Testing

Run the unit tests:

```bash
npm test -- src/lib/vector/__tests__/vector-store.test.ts
```

The test suite includes:
- Initialization and table creation
- Chunk insertion with various metadata
- Vector similarity search with filtering
- Text search and hybrid search
- Document deletion
- Error handling
- Metadata preservation

## Performance Considerations

- **Batch Insertion**: Insert chunks in batches for better performance
- **Vector Dimensions**: Smaller dimensions (384) are faster but less accurate than larger dimensions (3072)
- **Hybrid Search**: More expensive than pure vector search due to text filtering
- **Index Building**: LanceDB automatically builds indexes for tables with >10k vectors

## Error Handling

All methods throw descriptive errors when:
- VectorStore is not initialized
- Database operations fail
- Invalid query parameters are provided

Always wrap operations in try-catch blocks:

```typescript
try {
  await vectorStore.insertChunks(chunks);
} catch (error) {
  console.error('Failed to insert chunks:', error);
}
```

## Integration with Other Modules

The VectorStore integrates with:
- **EmbeddingProvider**: Receives `EmbeddedChunk` objects with embeddings
- **IngestionPipeline**: Called to store chunks after embedding generation
- **MCP Server**: Used for semantic search queries from AI assistants
- **Dashboard**: Provides search functionality for the web interface
