# IngestionPipeline

The `IngestionPipeline` class orchestrates the complete document processing workflow for the Sound Suite system. It wires together all ingestion components and manages the document lifecycle from detection to indexing.

## Overview

The IngestionPipeline processes documents through these stages:

1. **Text Extraction**: Extract text from PDF pages using pdfjs-dist
2. **OCR Processing**: Apply OCR to low-density pages (< 50 characters)
3. **Exhibit Extraction**: Extract and save embedded images, run OCR on them
4. **Text Chunking**: Split text into 512-token chunks with 50-token overlap
5. **Embedding Generation**: Generate vector embeddings for all chunks
6. **Vector Indexing**: Store embeddings in LanceDB with metadata

## Document Status Flow

```
QUEUED → PROCESSING → INDEXED
                   ↓
                 ERROR
```

- **QUEUED**: Document detected, waiting for processing
- **PROCESSING**: Document is being processed through the pipeline
- **INDEXED**: Document successfully processed and indexed
- **ERROR**: Processing failed, error message stored

## Usage

### Basic Setup

```typescript
import { IngestionPipeline } from './lib/ingestion';
import { PDFParser } from './lib/ingestion';
import { OCREngine } from './lib/ingestion';
import { TextChunker } from './lib/ingestion';
import { TransformersEmbeddingProvider } from './lib/ingestion';
import { VectorStore } from './lib/vector';
import { prisma } from './lib/db/prisma';

// Initialize components
const pdfParser = new PDFParser();
const ocrEngine = new OCREngine({ language: 'eng' });
const textChunker = new TextChunker({
  chunkSize: 512,
  overlapSize: 50,
  tokenizer: 'gpt',
});
const embeddingProvider = new TransformersEmbeddingProvider({
  provider: 'transformers',
  model: 'Xenova/all-MiniLM-L6-v2',
});
const vectorStore = new VectorStore({
  dbPath: './data/lancedb',
  tableName: 'chunks',
});

// Initialize vector store
await vectorStore.initialize();

// Create pipeline
const pipeline = new IngestionPipeline(
  pdfParser,
  ocrEngine,
  textChunker,
  embeddingProvider,
  vectorStore,
  prisma,
  {
    publicDir: 'public',
    ocrThreshold: 50,
  }
);
```

### Processing a Document

```typescript
// Process a document
const result = await pipeline.processDocument(
  'document-uuid',
  '/path/to/document.pdf'
);

if (result.success) {
  console.log(`Processed ${result.pageCount} pages`);
  console.log(`Extracted ${result.exhibitCount} exhibits`);
  console.log(`Created ${result.chunkCount} chunks`);
} else {
  console.error(`Processing failed: ${result.error}`);
}
```

### Cleanup

```typescript
// When done, cleanup resources
await pipeline.terminate();
await vectorStore.close();
```

## Configuration

### IngestionPipelineConfig

```typescript
interface IngestionPipelineConfig {
  publicDir?: string;      // Directory for saving exhibits (default: 'public')
  ocrThreshold?: number;   // Text density threshold for OCR (default: 50)
}
```

## Error Handling

The pipeline implements robust error handling:

1. **Automatic Rollback**: On failure, partial data is deleted from vector store
2. **Status Updates**: Document status is always updated, even on error
3. **Error Messages**: Descriptive error messages are stored in the database
4. **JobLog Tracking**: Each processing run creates a JobLog record

### Error Recovery

When processing fails:
- Document status is set to `ERROR`
- Error message is stored in `errorMessage` field
- Partial vector data is rolled back
- JobLog is updated with failure details
- Other documents continue processing

## Integration with Job Queue

The IngestionPipeline is typically called by the JobQueue:

```typescript
import { JobQueue } from './services/job-queue';

const jobQueue = new JobQueue(
  {
    maxConcurrency: 2,
    maxRetries: 3,
    retryDelay: 1000,
  },
  pipeline
);

// Enqueue a document for processing
await jobQueue.enqueue('/path/to/document.pdf', 'document-uuid');
```

## Requirements Satisfied

The IngestionPipeline satisfies these requirements:

- **2.4**: Updates Document status to PROCESSING when processing begins
- **2.5**: Updates Document status to INDEXED on successful completion
- **2.6**: Updates Document status to ERROR with message on failure
- **2.7**: Creates JobLog records for each processing run
- **3.4**: Handles text extraction errors and sets ERROR status

## Testing

Run the unit tests:

```bash
npm test -- ingestion-pipeline.test.ts
```

Run the manual test script:

```bash
npx ts-node src/lib/ingestion/test-ingestion-pipeline.ts
```

## Architecture

### Component Dependencies

```
IngestionPipeline
├── PDFParser (text & image extraction)
├── OCREngine (text recognition)
├── ExhibitExtractor (image processing)
├── TextChunker (text segmentation)
├── EmbeddingProvider (vector generation)
├── VectorStore (indexing)
└── PrismaClient (database)
```

### Data Flow

```
PDF File
  ↓
PDFParser → PageText[] + ExtractedImage[]
  ↓
OCREngine → Enhanced PageText[]
  ↓
ExhibitExtractor → ExhibitMetadata[]
  ↓
TextChunker → Chunk[]
  ↓
EmbeddingProvider → EmbeddedChunk[]
  ↓
VectorStore → Indexed
```

## Performance Considerations

- **Batching**: Embeddings are generated in batches for efficiency
- **Streaming**: Large PDFs are processed page-by-page to manage memory
- **Concurrency**: Multiple documents can be processed concurrently via JobQueue
- **Caching**: Embedding provider may cache results to avoid recomputation

## Future Enhancements

- [ ] Implement page rendering for OCR on low-density pages
- [ ] Add progress callbacks for long-running operations
- [ ] Support incremental indexing (update only changed pages)
- [ ] Add document reprocessing capability
- [ ] Implement parallel page processing for large PDFs
