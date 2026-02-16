# Ingestion Pipeline Components

This directory contains the components for the Sound Suite document ingestion pipeline.

## PDFParser

The `PDFParser` class provides functionality to extract text and images from PDF files using `pdfjs-dist` and `sharp`.

### Features

- **Text Extraction**: Extracts text from all pages of a PDF document
- **Text Density Calculation**: Calculates characters per page to determine if OCR is needed (threshold: 50 characters)
- **Image Extraction**: Extracts embedded images from PDF documents
- **Image Processing**: Converts images to PNG format and resizes to max 2048px width
- **Page Count**: Returns the total number of pages in a PDF

### Usage

```typescript
import { PDFParser } from './pdf-parser';

const parser = new PDFParser();

// Get page count
const pageCount = await parser.getPageCount('path/to/document.pdf');

// Extract text from all pages
const pages = await parser.extractText('path/to/document.pdf');
pages.forEach(page => {
  console.log(`Page ${page.pageNumber}: ${page.text.length} characters`);
  console.log(`Text density: ${page.textDensity} characters/page`);
  
  // Check if OCR should be triggered
  if (page.textDensity < 50) {
    console.log('Low text density - OCR recommended');
  }
});

// Extract images
const images = await parser.extractImages('path/to/document.pdf');
images.forEach(image => {
  console.log(`Image ${image.imageIndex} on page ${image.pageNumber}`);
  console.log(`Dimensions: ${image.width}x${image.height}`);
  // image.buffer contains the PNG image data
});
```

### Testing

To manually test the PDFParser with a real PDF file:

```bash
npx ts-node src/lib/ingestion/test-pdf-parser.ts path/to/your/document.pdf
```

This will:
1. Count the pages in the PDF
2. Extract text from all pages and show text density
3. Extract all embedded images
4. Display a summary of the results

### Requirements Satisfied

This implementation satisfies the following requirements from the design document:

- **Requirement 3.1**: Extract text using pdfjs-dist ✓
- **Requirement 3.3**: Store page count in Document record ✓
- **Requirement 3.5**: Preserve page numbers for extracted text ✓
- **Requirement 4.1**: Extract all embedded images ✓

### Implementation Notes

1. **Text Density**: The `textDensity` field represents the number of characters extracted from a page. Pages with < 50 characters should trigger OCR processing (handled by OCREngine, not PDFParser).

2. **Image Extraction**: The current implementation extracts images using PDF.js's operator list. This works for most PDFs but may not capture all image types (e.g., inline images). For production use, consider additional image extraction methods.

3. **Image Processing**: Images are automatically converted to PNG format and resized to a maximum width of 2048px to optimize storage and processing.

4. **Error Handling**: The parser includes basic error handling with console warnings for failed image extractions. In production, these should be logged to a proper logging system.

### Next Steps

The following components need to be implemented to complete the ingestion pipeline:

1. ~~**OCREngine**: Process low-density pages and extracted images~~ ✓ Implemented
2. ~~**ExhibitExtractor**: Extract and process exhibits from PDFs~~ ✓ Implemented
3. **TextChunker**: Split text into 512-token chunks with 50-token overlap
4. **EmbeddingProvider**: Generate vector embeddings for text chunks
5. **VectorStore**: Store embeddings in LanceDB
6. **IngestionPipeline**: Orchestrate all components together

## OCREngine

The `OCREngine` class provides Optical Character Recognition (OCR) functionality to extract text from images and low-density PDF pages using `tesseract.js`.

### Features

- **Image OCR**: Extracts text from image buffers
- **Image Preprocessing**: Applies grayscale conversion and contrast enhancement for better OCR results
- **Confidence Filtering**: Skips results with confidence < 60% (likely not text)
- **Pure JavaScript**: Uses tesseract.js for zero native dependencies
- **Resource Management**: Proper cleanup with terminate() method

### Usage

```typescript
import { OCREngine } from './ocr-engine';
import * as fs from 'fs/promises';

const ocr = new OCREngine({ language: 'eng' });

try {
  // Read an image file
  const imageBuffer = await fs.readFile('path/to/image.png');
  
  // Extract text from the image
  const result = await ocr.recognizeImage(imageBuffer);
  
  console.log(`Extracted text: ${result.text}`);
  console.log(`Confidence: ${result.confidence}%`);
  
  // Check if confidence is acceptable
  if (result.confidence >= 60) {
    console.log('High confidence - text is reliable');
  } else {
    console.log('Low confidence - likely no text in image');
  }
} finally {
  // Always cleanup resources
  await ocr.terminate();
}
```

### Integration with PDFParser

The OCREngine is designed to work with PDFParser for processing low-density pages:

```typescript
import { PDFParser, OCREngine } from './ingestion';

const parser = new PDFParser();
const ocr = new OCREngine({ language: 'eng' });

try {
  // Extract text from PDF
  const pages = await parser.extractText('document.pdf');
  
  // Process low-density pages with OCR
  for (const page of pages) {
    if (page.textDensity < 50) {
      console.log(`Page ${page.pageNumber} has low text density, applying OCR...`);
      
      // Extract images from this page
      const images = await parser.extractImages('document.pdf');
      const pageImages = images.filter(img => img.pageNumber === page.pageNumber);
      
      // Run OCR on each image
      for (const image of pageImages) {
        const ocrResult = await ocr.recognizeImage(image.buffer);
        if (ocrResult.confidence >= 60) {
          console.log(`OCR text: ${ocrResult.text}`);
        }
      }
    }
  }
} finally {
  await ocr.terminate();
}
```

### Configuration

The OCREngine accepts the following configuration options:

```typescript
interface OCRConfig {
  language: string; // Default: 'eng'
  tesseractPath?: string; // Optional custom Tesseract path
}
```

Supported languages include:
- `'eng'` - English (default)
- `'fra'` - French
- `'deu'` - German
- `'spa'` - Spanish
- And many more (see Tesseract.js documentation)

### Image Preprocessing

The OCREngine automatically preprocesses images before OCR to improve accuracy:

1. **Grayscale Conversion**: Converts color images to grayscale
2. **Contrast Enhancement**: Normalizes contrast using sharp's normalize() function

This preprocessing significantly improves OCR accuracy, especially for:
- Low-contrast images
- Colored backgrounds
- Scanned documents with uneven lighting

### Requirements Satisfied

This implementation satisfies the following requirements from the design document:

- **Requirement 3.2**: Apply OCR to pages with low text density (< 50 characters) ✓
- **Requirement 4.3**: Run OCR on extracted exhibit images ✓

### Implementation Notes

1. **Confidence Threshold**: Results with confidence < 60% return empty text. This prevents false positives from images without text.

2. **Worker Initialization**: The Tesseract worker is initialized lazily on first use and reused for subsequent calls. This improves performance for batch processing.

3. **Resource Cleanup**: Always call `terminate()` when done to free memory and cleanup the Tesseract worker.

4. **PDF Page Recognition**: The `recognizePage()` method currently requires PDF rendering integration. Use PDFParser to extract images first, then call `recognizeImage()`.

### Testing

Unit tests are available in `__tests__/ocr-engine.test.ts`:

```bash
npm test -- src/lib/ingestion/__tests__/ocr-engine.test.ts
```

Tests cover:
- Image recognition with preprocessing
- Low confidence handling
- Resource cleanup
- Configuration options

## ExhibitExtractor

The `ExhibitExtractor` class provides functionality to extract exhibits (images) from PDF documents, save them to disk, and run OCR on each exhibit.

### Features

- **Image Extraction**: Extracts all embedded images from PDF documents using PDFParser
- **File Storage**: Saves exhibits to `/public/exhibits/[case_id]/[document_id]_page[N]_img[M].png`
- **OCR Processing**: Runs OCR on each exhibit to extract text
- **Metadata Storage**: Returns metadata including page number, image path, and extracted text
- **Error Resilience**: Continues processing other exhibits if one fails
- **Resource Management**: Proper cleanup with terminate() method

### Usage

```typescript
import { ExhibitExtractor } from './exhibit-extractor';

const extractor = new ExhibitExtractor();

try {
  // Extract exhibits from a PDF
  const result = await extractor.extractExhibits(
    'path/to/document.pdf',
    'case-uuid-123',
    'document-uuid-456'
  );
  
  console.log(`Total exhibits extracted: ${result.totalCount}`);
  
  // Process each exhibit
  result.exhibits.forEach(exhibit => {
    console.log(`Page ${exhibit.pageNumber}: ${exhibit.imagePath}`);
    console.log(`OCR Text: ${exhibit.extractedText}`);
    console.log(`Confidence: ${exhibit.confidence}%`);
  });
} finally {
  // Always cleanup resources
  await extractor.terminate();
}
```

### File Naming Convention

Exhibits are saved with the following naming pattern:
```
/public/exhibits/[case_id]/[document_id]_page[N]_img[M].png
```

Where:
- `[case_id]`: UUID of the case
- `[document_id]`: UUID of the document
- `[N]`: Page number (1-indexed)
- `[M]`: Image index on that page (0-indexed)

Example: `/public/exhibits/abc-123/def-456_page3_img0.png`

### Exhibit Metadata

Each exhibit includes the following metadata:

```typescript
interface ExhibitMetadata {
  pageNumber: number;        // Page where the exhibit was found
  imagePath: string;         // Relative path from public directory
  extractedText: string;     // Text extracted via OCR
  confidence?: number;       // OCR confidence score (0-100)
}
```

### Integration with Ingestion Pipeline

The ExhibitExtractor is designed to be used in the ingestion pipeline:

```typescript
import { ExhibitExtractor } from './ingestion';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const extractor = new ExhibitExtractor();

try {
  // Extract exhibits
  const result = await extractor.extractExhibits(
    filePath,
    document.caseId,
    document.id
  );
  
  // Update document with exhibit count
  await prisma.document.update({
    where: { id: document.id },
    data: { detectedExhibits: result.totalCount }
  });
  
  // Store exhibit metadata in vector database
  // (This will be handled by the VectorStore component)
  
} finally {
  await extractor.terminate();
}
```

### Requirements Satisfied

This implementation satisfies the following requirements from the design document:

- **Requirement 4.1**: Extract all embedded images using sharp ✓
- **Requirement 4.2**: Save exhibits to /public/exhibits/[case_id]/[document_id]_page[N]_img[M].png ✓
- **Requirement 4.3**: Run OCR on each exhibit ✓
- **Requirement 4.5**: Store exhibit metadata (page_number, image_path, extracted_text) ✓

### Testing

To manually test the ExhibitExtractor with a real PDF file:

```bash
npx ts-node src/lib/ingestion/test-exhibit-extractor.ts path/to/document.pdf case-123 doc-456
```

This will:
1. Extract all images from the PDF
2. Save them to `public/exhibits/case-123/`
3. Run OCR on each image
4. Display metadata for all exhibits

Unit tests are available in `__tests__/exhibit-extractor.test.ts`:

```bash
npm test -- src/lib/ingestion/__tests__/exhibit-extractor.test.ts
```

Tests cover:
- Exhibit extraction and file naming
- OCR processing
- Metadata structure
- Error handling
- Resource cleanup


## TextChunker

The `TextChunker` class provides functionality to split text into overlapping chunks for vectorization, supporting multiple tokenization strategies.

### Features

- **Multiple Tokenizers**: Supports GPT (tiktoken), Claude (@anthropic-ai/tokenizer), and simple tokenization
- **Configurable Chunk Size**: Default 512 tokens per chunk
- **Overlap Support**: Default 50-token overlap between consecutive chunks
- **Sentence Boundary Preservation**: Never splits mid-sentence
- **Metadata Tracking**: Includes document ID, case ID, page number, and chunk index
- **Exhibit Support**: Special handling for exhibit OCR text with exhibit-specific metadata
- **Resource Management**: Proper cleanup with dispose() method

### Usage

```typescript
import { TextChunker, PageText } from './text-chunker';

// Create chunker with GPT tokenizer
const chunker = new TextChunker({
  chunkSize: 512,
  overlapSize: 50,
  tokenizer: 'gpt'
});

try {
  // Prepare page text
  const pages: PageText[] = [
    {
      pageNumber: 1,
      text: 'This is the first page. It contains important information...'
    },
    {
      pageNumber: 2,
      text: 'This is the second page. More content here...'
    }
  ];

  // Create chunks
  const chunks = await chunker.chunkPages(
    pages,
    'document-uuid-123',
    'case-uuid-456'
  );

  // Process chunks
  chunks.forEach(chunk => {
    console.log(`Chunk ${chunk.metadata.chunkIndex}:`);
    console.log(`  Page: ${chunk.metadata.pageNumber}`);
    console.log(`  Text: ${chunk.text.substring(0, 100)}...`);
    console.log(`  Is Exhibit: ${chunk.metadata.isExhibit}`);
  });
} finally {
  // Always cleanup resources
  chunker.dispose();
}
```

### Tokenizer Options

The TextChunker supports three tokenization strategies:

#### 1. GPT Tokenizer (tiktoken)
```typescript
const chunker = new TextChunker({
  chunkSize: 512,
  overlapSize: 50,
  tokenizer: 'gpt'
});
```
- Uses OpenAI's tiktoken library
- Accurate token counting for GPT models
- Best for OpenAI embedding providers
- Model: gpt-3.5-turbo encoding

#### 2. Claude Tokenizer (@anthropic-ai/tokenizer)
```typescript
const chunker = new TextChunker({
  chunkSize: 512,
  overlapSize: 50,
  tokenizer: 'claude'
});
```
- Uses Anthropic's official tokenizer
- Accurate token counting for Claude models
- Best for Claude embedding providers

#### 3. Simple Tokenizer
```typescript
const chunker = new TextChunker({
  chunkSize: 512,
  overlapSize: 50,
  tokenizer: 'simple'
});
```
- Approximation: ~4 characters per token
- Fast but less accurate
- Good for testing and development
- No external dependencies

### Chunking Exhibit Text

For exhibit OCR text, use the `chunkExhibitText()` method:

```typescript
import { TextChunker, Exhibit } from './text-chunker';

const chunker = new TextChunker({
  chunkSize: 512,
  overlapSize: 50,
  tokenizer: 'gpt'
});

try {
  const exhibit: Exhibit = {
    pageNumber: 5,
    imagePath: '/exhibits/case-123/doc-456_page5_img0.png',
    ocrText: 'Text extracted from exhibit image...',
    documentId: 'doc-456',
    caseId: 'case-123'
  };

  const chunks = await chunker.chunkExhibitText(
    exhibit.ocrText,
    exhibit
  );

  chunks.forEach(chunk => {
    console.log(`Exhibit chunk: ${chunk.text}`);
    console.log(`  Exhibit path: ${chunk.metadata.exhibitPath}`);
    console.log(`  Is exhibit: ${chunk.metadata.isExhibit}`); // true
  });
} finally {
  chunker.dispose();
}
```

### Chunk Metadata

Each chunk includes comprehensive metadata:

```typescript
interface ChunkMetadata {
  documentId: string;      // UUID of the source document
  caseId: string;          // UUID of the case
  pageNumber: number;      // Page where the text originated
  chunkIndex: number;      // Sequential index across all chunks
  isExhibit: boolean;      // Whether this is from an exhibit
  exhibitPath?: string;    // Path to exhibit image (if isExhibit=true)
}
```

### Overlap Behavior

The TextChunker creates overlapping chunks to ensure context is preserved across chunk boundaries:

```
Chunk 0: [Sentence 1] [Sentence 2] [Sentence 3]
Chunk 1:              [Sentence 2] [Sentence 3] [Sentence 4]
Chunk 2:                           [Sentence 3] [Sentence 4] [Sentence 5]
```

- Overlap is measured in tokens, not sentences
- Sentences from the end of the previous chunk are included in the next chunk
- Overlap size is configurable (default: 50 tokens)
- Ensures semantic continuity for vector search

### Sentence Boundary Preservation

The TextChunker never splits mid-sentence:

- Text is first split into sentences using punctuation (`.`, `!`, `?`)
- Sentences are grouped into chunks up to the token limit
- If adding a sentence would exceed the limit, a new chunk is started
- This preserves semantic meaning and improves search quality

### Integration with Ingestion Pipeline

The TextChunker is designed to work with other ingestion components:

```typescript
import { PDFParser, TextChunker, EmbeddingProvider } from './ingestion';

const parser = new PDFParser();
const chunker = new TextChunker({
  chunkSize: 512,
  overlapSize: 50,
  tokenizer: 'gpt'
});

try {
  // Extract text from PDF
  const pages = await parser.extractText('document.pdf');
  
  // Create chunks
  const chunks = await chunker.chunkPages(
    pages,
    'doc-123',
    'case-456'
  );
  
  // Generate embeddings (next step in pipeline)
  // const embeddings = await embeddingProvider.embed(
  //   chunks.map(c => c.text)
  // );
  
} finally {
  chunker.dispose();
}
```

### Requirements Satisfied

This implementation satisfies the following requirements from the design document:

- **Requirement 5.1**: Split text into 512-token chunks with 50-token overlap ✓
- **Requirement 5.5**: Create separate chunks for exhibit OCR text with metadata flag ✓

### Configuration Options

```typescript
interface ChunkConfig {
  chunkSize: number;        // Tokens per chunk (default: 512)
  overlapSize: number;      // Tokens of overlap (default: 50)
  tokenizer: 'gpt' | 'claude' | 'simple';  // Tokenization strategy
}
```

### Testing

To manually test the TextChunker:

```bash
npx tsx src/lib/ingestion/test-text-chunker.ts
```

This will demonstrate:
1. Basic chunking with GPT tokenizer
2. Exhibit chunking with Claude tokenizer
3. Long text with multiple chunks and overlap

Unit tests are available in `__tests__/text-chunker.test.ts`:

```bash
npm test -- text-chunker
```

Tests cover:
- Chunk creation with metadata
- Empty page handling
- Multiple chunks for long text
- Sentence boundary preservation
- Exhibit text chunking
- All three tokenizer types
- Overlap behavior

### Implementation Notes

1. **Token Counting**: The GPT tokenizer uses tiktoken with gpt-3.5-turbo encoding. For production use with different models, consider making the model configurable.

2. **Sentence Splitting**: The current implementation uses a simple regex-based sentence splitter. For more complex legal documents, consider using a more sophisticated NLP library.

3. **Chunk Size**: The default 512 tokens is optimized for most embedding models. Adjust based on your embedding provider's limits.

4. **Overlap Size**: The default 50 tokens provides good context preservation. Increase for better semantic continuity, decrease for less redundancy.

5. **Resource Cleanup**: Always call `dispose()` when done to free the tiktoken encoder resources.

### Next Steps

The following components need to be implemented to complete the ingestion pipeline:

1. **EmbeddingProvider**: Generate vector embeddings for text chunks
2. **VectorStore**: Store embeddings in LanceDB
3. **IngestionPipeline**: Orchestrate all components together
