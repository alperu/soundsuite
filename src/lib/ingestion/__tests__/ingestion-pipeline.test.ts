/**
 * Unit tests for IngestionPipeline
 * 
 * Tests the orchestration of document processing through all stages:
 * - Status transitions (QUEUED → PROCESSING → INDEXED)
 * - Error handling and rollback
 * - JobLog creation
 * - Integration with all components
 */

// Shared mock functions so all OCREngine instances (including pool workers) share behavior
const sharedRecognizeImage = jest.fn();
const sharedOcrTerminate = jest.fn();

// Mock fs/promises for preflight stat calls
jest.mock('fs/promises', () => ({
  stat: jest.fn().mockResolvedValue({ size: 1024 * 1024 }), // 1MB default
  readFile: jest.fn(),
  writeFile: jest.fn(),
  mkdir: jest.fn(),
}));

// Mock all dependencies BEFORE importing
jest.mock('../pdf-parser', () => ({
  PDFParser: jest.fn().mockImplementation(() => ({
    extractText: jest.fn(),
    extractImages: jest.fn(),
    extractPageImages: jest.fn().mockResolvedValue([]),
    getPageCount: jest.fn().mockResolvedValue(10),
    pageHasImages: jest.fn().mockResolvedValue(true),
    renderPageToImage: jest.fn(),
    getOcrCandidateImage: jest.fn().mockResolvedValue(null),
    loadDocument: jest.fn().mockResolvedValue({}),
    releaseDocument: jest.fn().mockResolvedValue(undefined),
  })),
  isImageOcrWorthy: jest.fn().mockReturnValue(true),
}));

jest.mock('../ocr-engine', () => {
  const mockEngine = () => ({
    recognizeImage: sharedRecognizeImage,
    recognizePage: jest.fn(),
    terminate: sharedOcrTerminate,
  });
  return {
    OCREngine: jest.fn().mockImplementation(mockEngine),
    CachedOCREngine: jest.fn().mockImplementation((inner: any) => ({
      recognizeImage: inner?.recognizeImage ?? sharedRecognizeImage,
      terminate: inner?.terminate ?? sharedOcrTerminate,
      clearCache: jest.fn(),
      getCache: jest.fn().mockReturnValue(new Map()),
    })),
  };
});

jest.mock('../text-chunker', () => ({
  TextChunker: jest.fn().mockImplementation(() => ({
    chunkPages: jest.fn(),
    chunkExhibitText: jest.fn(),
    dispose: jest.fn(),
  })),
}));

jest.mock('../document-summarizer', () => ({
  DocumentSummarizer: jest.fn().mockImplementation(() => ({
    generateSummary: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../vector/vector-store', () => ({
  VectorStore: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    insertChunks: jest.fn(),
    search: jest.fn(),
    deleteByDocument: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock('../image-preprocessor', () => ({
  preprocessImage: jest.fn((buf: Buffer) => Promise.resolve(buf)),
  batchPreprocessImages: jest.fn().mockResolvedValue([]),
  clearDocumentExhibits: jest.fn().mockResolvedValue(0),
  buildImageFilename: jest.fn(() => 'test.png'),
}));

jest.mock('../exhibit-extractor', () => ({
  ExhibitExtractor: jest.fn().mockImplementation(() => ({
    extractExhibits: jest.fn().mockResolvedValue({ exhibits: [], totalCount: 0 }),
    terminate: jest.fn(),
  })),
  detectExhibitBoundaries: jest.fn().mockReturnValue([]),
  isPageInExhibitRange: jest.fn().mockReturnValue(false),
}));

import { IngestionPipeline, IngestionResult } from '../ingestion-pipeline';
import { PDFParser, PageText } from '../pdf-parser';
import { OCREngine } from '../ocr-engine';
import { TextChunker, Chunk, ITextChunker } from '../text-chunker';
import { EmbeddingProvider } from '../embedding-provider';
import { VectorStore } from '../../vector/vector-store';
import { PrismaClient } from '@prisma/client';

describe('IngestionPipeline', () => {
  let pipeline: IngestionPipeline;
  let mockPdfParser: jest.Mocked<PDFParser>;
  let mockOcrEngine: jest.Mocked<OCREngine>;
  let mockTextChunker: jest.Mocked<ITextChunker>;
  let mockEmbeddingProvider: jest.Mocked<EmbeddingProvider>;
  let mockVectorStore: jest.Mocked<VectorStore>;
  let mockDatabase: jest.Mocked<PrismaClient>;

  beforeEach(() => {
    // Create mock instances
    mockPdfParser = new PDFParser() as jest.Mocked<PDFParser>;
    mockOcrEngine = new OCREngine() as jest.Mocked<OCREngine>;
    mockTextChunker = new TextChunker() as unknown as jest.Mocked<ITextChunker>;
    mockEmbeddingProvider = {
      embed: jest.fn(),
      getDimensions: jest.fn().mockReturnValue(384),
      getAvailableModels: jest.fn().mockReturnValue(['test-model']),
      getModelName: jest.fn().mockReturnValue('test-model'),
    } as any;
    mockVectorStore = new VectorStore({ dbPath: 'test', tableName: 'test' }) as jest.Mocked<VectorStore>;
    
    // Mock Prisma client
    mockDatabase = {
      document: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      jobLog: {
        create: jest.fn(),
        update: jest.fn(),
      },
      config: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    } as any;

    // Create pipeline instance
    pipeline = new IngestionPipeline(
      mockPdfParser,
      mockOcrEngine,
      mockTextChunker,
      mockEmbeddingProvider,
      mockVectorStore,
      mockDatabase
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('processDocument', () => {
    const documentId = 'doc-123';
    const caseId = 'case-456';
    const filePath = '/path/to/test.pdf';

    beforeEach(() => {
      // Setup default mock responses
      mockDatabase.document.findUnique.mockResolvedValue({
        id: documentId,
        caseId,
        case: { id: caseId, name: 'Test Case', path: '/test' },
        filePath,
        fileName: 'test.pdf',
        hash: 'hash123',
        status: 'QUEUED',
        errorMessage: null,
        pageCount: null,
        detectedExhibits: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      mockDatabase.jobLog.create.mockResolvedValue({
        id: 'job-123',
        startedAt: new Date(),
        completedAt: null,
        documentsQueued: 1,
        documentsProcessed: 0,
        documentsFailed: 0,
        errorSummary: null,
      } as any);

      mockDatabase.document.update.mockResolvedValue({} as any);
      mockDatabase.jobLog.update.mockResolvedValue({} as any);
    });

    it('should successfully process a document through all stages', async () => {
      // Setup mock data
      const mockPages: PageText[] = [
        { pageNumber: 1, text: 'Page 1 content', textDensity: 100 },
        { pageNumber: 2, text: 'Page 2 content', textDensity: 100 },
      ];

      const mockChunks: Chunk[] = [
        {
          text: 'Page 1 content',
          metadata: {
            documentId,
            caseId,
            pageNumber: 1,
            chunkIndex: 0,
            isExhibit: false,
          },
        },
      ];

      const mockEmbeddings = [[0.1, 0.2, 0.3]];

      // Setup mocks
      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      mockPdfParser.extractImages = jest.fn().mockResolvedValue([]);
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue(mockChunks);
      mockEmbeddingProvider.embed.mockResolvedValue(mockEmbeddings);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      // Execute
      const result = await pipeline.processDocument(documentId, filePath);

      // Verify result
      expect(result.success).toBe(true);
      expect(result.pageCount).toBe(2);
      expect(result.chunkCount).toBe(1);

      // Verify status transitions
      expect(mockDatabase.document.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: { status: 'PROCESSING' },
      });

      expect(mockDatabase.document.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: {
          status: 'INDEXED',
          errorMessage: null,
          embeddingModel: 'test-model',
        },
      });

      // Verify JobLog was created and updated
      expect(mockDatabase.jobLog.create).toHaveBeenCalled();
      expect(mockDatabase.jobLog.update).toHaveBeenCalledWith({
        where: { id: 'job-123' },
        data: expect.objectContaining({
          documentsProcessed: 1,
        }),
      });
    });

    it('should update page count after text extraction', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: 'Page 1', textDensity: 100 },
        { pageNumber: 2, text: 'Page 2', textDensity: 100 },
        { pageNumber: 3, text: 'Page 3', textDensity: 100 },
      ];

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      mockPdfParser.extractImages = jest.fn().mockResolvedValue([]);
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      await pipeline.processDocument(documentId, filePath);

      expect(mockDatabase.document.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: { pageCount: 3 },
      });
    });

    it('should handle errors and set ERROR status', async () => {
      const errorMessage = 'PDF parsing failed';
      mockPdfParser.extractText = jest.fn().mockRejectedValue(new Error(errorMessage));
      mockVectorStore.deleteByDocument = jest.fn().mockResolvedValue(undefined);

      const result = await pipeline.processDocument(documentId, filePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain(errorMessage);

      // Verify ERROR status was set
      expect(mockDatabase.document.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: {
          status: 'ERROR',
          errorMessage: expect.stringContaining(errorMessage),
        },
      });

      // Verify JobLog was updated with failure
      expect(mockDatabase.jobLog.update).toHaveBeenCalledWith({
        where: { id: 'job-123' },
        data: expect.objectContaining({
          documentsFailed: 1,
          errorSummary: expect.stringContaining(errorMessage),
        }),
      });
    });

    it('should rollback vector store data on failure', async () => {
      mockPdfParser.extractText = jest.fn().mockRejectedValue(new Error('Test error'));
      mockVectorStore.deleteByDocument = jest.fn().mockResolvedValue(undefined);

      await pipeline.processDocument(documentId, filePath);

      expect(mockVectorStore.deleteByDocument).toHaveBeenCalledWith(documentId);
    });

    it('should handle rollback errors gracefully', async () => {
      mockPdfParser.extractText = jest.fn().mockRejectedValue(new Error('Test error'));
      mockVectorStore.deleteByDocument = jest.fn().mockRejectedValue(new Error('Rollback failed'));

      const result = await pipeline.processDocument(documentId, filePath);

      // Should still return error result even if rollback fails
      expect(result.success).toBe(false);
      expect(result.error).toContain('Test error');
    });

    it('should process exhibits and update exhibit count', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: 'Page 1', textDensity: 100 },
      ];

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      mockPdfParser.extractImages = jest.fn().mockResolvedValue([
        {
          pageNumber: 1,
          imageIndex: 0,
          buffer: Buffer.from('test'),
          width: 100,
          height: 100,
        },
      ]);
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      await pipeline.processDocument(documentId, filePath);

      // Verify exhibit count was updated
      expect(mockDatabase.document.update).toHaveBeenCalledWith({
        where: { id: documentId },
        data: expect.objectContaining({
          detectedExhibits: expect.any(Number),
        }),
      });
    });

    it('should handle document not found error', async () => {
      mockDatabase.document.findUnique.mockResolvedValue(null);

      const result = await pipeline.processDocument(documentId, filePath);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should create JobLog record at start of processing', async () => {
      mockPdfParser.extractText = jest.fn().mockResolvedValue([]);
      mockPdfParser.extractImages = jest.fn().mockResolvedValue([]);
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      await pipeline.processDocument(documentId, filePath);

      expect(mockDatabase.jobLog.create).toHaveBeenCalledWith({
        data: {
          documentsQueued: 1,
          documentsProcessed: 0,
          documentsFailed: 0,
        },
      });
    });
  });

  describe('OCR fallback', () => {
    const documentId = 'doc-123';
    const caseId = 'case-456';
    const filePath = '/path/to/test.pdf';

    beforeEach(() => {
      mockDatabase.document.findUnique.mockResolvedValue({
        id: documentId,
        caseId,
        case: { id: caseId, name: 'Test Case', path: '/test' },
        filePath,
        fileName: 'test.pdf',
        hash: 'hash123',
        status: 'QUEUED',
        errorMessage: null,
        pageCount: null,
        detectedExhibits: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      mockDatabase.jobLog.create.mockResolvedValue({
        id: 'job-123',
        startedAt: new Date(),
        completedAt: null,
        documentsQueued: 1,
        documentsProcessed: 0,
        documentsFailed: 0,
        errorSummary: null,
      } as any);

      mockDatabase.document.update.mockResolvedValue({} as any);
      mockDatabase.jobLog.update.mockResolvedValue({} as any);
    });

    it('should apply OCR fallback for pages with renderFailed flag', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: 'Good page', textDensity: 100 },
        { pageNumber: 2, text: '', textDensity: 0, renderFailed: true },
      ];

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      (mockPdfParser as any).getOcrCandidateImage = jest.fn().mockResolvedValue({
        buffer: Buffer.from('mock-png'),
        imageIndex: 0,
      });
      sharedRecognizeImage.mockResolvedValue({
        text: 'OCR recovered text from JPEG2000 page',
        confidence: 85,
      });
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      const result = await pipeline.processDocument(documentId, filePath);

      expect(result.success).toBe(true);
      expect(result.ocrFallbackPages).toBe(1);
      expect((mockPdfParser as any).getOcrCandidateImage).toHaveBeenCalledWith(filePath, 2);
      expect(sharedRecognizeImage).toHaveBeenCalled();
    });

    it('should apply OCR fallback for low-density pages', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: 'Hi', textDensity: 2 }, // Below threshold (50)
        { pageNumber: 2, text: 'This is a normal page with enough text', textDensity: 200 },
      ];

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      (mockPdfParser as any).getOcrCandidateImage = jest.fn().mockResolvedValue({
        buffer: Buffer.from('mock-png'),
        imageIndex: 0,
      });
      sharedRecognizeImage.mockResolvedValue({
        text: 'Full text recovered by OCR',
        confidence: 90,
      });
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      const result = await pipeline.processDocument(documentId, filePath);

      expect(result.success).toBe(true);
      expect(result.ocrFallbackPages).toBe(1);
      // Only page 1 should get OCR candidate
      expect((mockPdfParser as any).getOcrCandidateImage).toHaveBeenCalledWith(filePath, 1);
      expect((mockPdfParser as any).getOcrCandidateImage).not.toHaveBeenCalledWith(filePath, 2);
    });

    it('should skip OCR when getOcrCandidateImage returns null (no viable images)', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: '', textDensity: 0, renderFailed: true },
      ];

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      (mockPdfParser as any).getOcrCandidateImage = jest.fn().mockResolvedValue(null);
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      const result = await pipeline.processDocument(documentId, filePath);

      expect(result.success).toBe(true);
      expect(result.ocrFallbackPages).toBe(0);
      // recognizeImage should never be called since no candidate
      expect(sharedRecognizeImage).not.toHaveBeenCalled();
    });

    it('should continue processing if OCR fallback fails', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: '', textDensity: 0, renderFailed: true },
      ];

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      (mockPdfParser as any).getOcrCandidateImage = jest.fn().mockRejectedValue(new Error('Render failed'));
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      const result = await pipeline.processDocument(documentId, filePath);

      // Should still succeed overall even if OCR fails for one page
      expect(result.success).toBe(true);
      expect(result.ocrFallbackPages).toBe(0);
    });

    it('should handle OCR returning empty text and skip already-tried image in Tier-2', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: '', textDensity: 0, renderFailed: true },
      ];

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      (mockPdfParser as any).getOcrCandidateImage = jest.fn().mockResolvedValue({
        buffer: Buffer.from('mock-png'),
        imageIndex: 0,
      });
      // Tier-1 returns empty, Tier-2 images should skip imageIndex 0
      (mockPdfParser as any).extractPageImages = jest.fn().mockResolvedValue([
        { pageNumber: 1, imageIndex: 0, buffer: Buffer.alloc(2000), width: 200, height: 200 },
        { pageNumber: 1, imageIndex: 1, buffer: Buffer.alloc(2000), width: 300, height: 300 },
      ]);
      sharedRecognizeImage
        .mockResolvedValueOnce({ text: '', confidence: 30 })   // Tier-1 empty
        .mockResolvedValueOnce({ text: 'Tier-2 text', confidence: 70 }); // Tier-2 imageIndex 1
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue([]);
      mockEmbeddingProvider.embed.mockResolvedValue([]);
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      const result = await pipeline.processDocument(documentId, filePath);

      expect(result.success).toBe(true);
      expect(result.ocrFallbackPages).toBe(1);
      // recognizeImage called twice: Tier-1 (imageIndex 0) + Tier-2 (imageIndex 1)
      expect(sharedRecognizeImage).toHaveBeenCalledTimes(2);
    });
  });

  describe('batched embeddings', () => {
    const documentId = 'doc-123';
    const caseId = 'case-456';
    const filePath = '/path/to/test.pdf';

    beforeEach(() => {
      mockDatabase.document.findUnique.mockResolvedValue({
        id: documentId,
        caseId,
        case: { id: caseId, name: 'Test Case', path: '/test' },
        filePath,
        fileName: 'test.pdf',
        hash: 'hash123',
        status: 'QUEUED',
        errorMessage: null,
        pageCount: null,
        detectedExhibits: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      mockDatabase.jobLog.create.mockResolvedValue({
        id: 'job-123',
        startedAt: new Date(),
        completedAt: null,
        documentsQueued: 1,
        documentsProcessed: 0,
        documentsFailed: 0,
        errorSummary: null,
      } as any);

      mockDatabase.document.update.mockResolvedValue({} as any);
      mockDatabase.jobLog.update.mockResolvedValue({} as any);
    });

    it('should batch embedding generation for many chunks', async () => {
      const mockPages: PageText[] = [
        { pageNumber: 1, text: 'Page 1', textDensity: 100 },
      ];

      // Create 150 chunks (more than default batch size of 100)
      const manyChunks: Chunk[] = Array.from({ length: 150 }, (_, i) => ({
        text: `Chunk ${i}`,
        metadata: {
          documentId,
          caseId,
          pageNumber: 1,
          chunkIndex: i,
          isExhibit: false,
        },
      }));

      mockPdfParser.extractText = jest.fn().mockResolvedValue(mockPages);
      mockTextChunker.chunkPages = jest.fn().mockResolvedValue(manyChunks);
      mockEmbeddingProvider.embed.mockImplementation(async (texts: string[]) => {
        return texts.map(() => [0.1, 0.2, 0.3]);
      });
      mockVectorStore.insertChunks = jest.fn().mockResolvedValue(undefined);

      const result = await pipeline.processDocument(documentId, filePath);

      expect(result.success).toBe(true);
      expect(result.chunkCount).toBe(150);

      // embed should be called in batches (default batch size 20 → 150/20 = 8 calls)
      expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(8);

      // insertChunks should also be called in batches
      expect(mockVectorStore.insertChunks).toHaveBeenCalledTimes(8);
    });
  });

  describe('terminate', () => {
    it('should cleanup all resources', async () => {
      mockOcrEngine.terminate = jest.fn().mockResolvedValue(undefined);
      mockTextChunker.dispose = jest.fn();

      await pipeline.terminate();

      expect(mockOcrEngine.terminate).toHaveBeenCalled();
      expect(mockTextChunker.dispose).toHaveBeenCalled();
    });
  });
});
