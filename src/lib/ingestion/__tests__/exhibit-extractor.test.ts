import { ExhibitExtractor, detectExhibitBoundaries, isPageInExhibitRange, ExhibitBoundary } from '../exhibit-extractor';
import { PDFParser } from '../pdf-parser';
import { PageText } from '../pdf-parser';
import { OCREngine, IOCREngine } from '../ocr-engine';
import * as fs from 'fs/promises';
import * as path from 'path';

// Mock the dependencies
jest.mock('../pdf-parser');
jest.mock('../ocr-engine');
jest.mock('fs/promises');
jest.mock('../image-preprocessor', () => ({
  preprocessImage: jest.fn((buf: Buffer) => Promise.resolve(buf)),
  buildImageFilename: jest.fn((docId: string, pageNumber: number, imgIdx: number) =>
    `${docId}_page${pageNumber}_img${imgIdx}.png`
  ),
}));

/** Create a buffer of at least 6 KB so it passes the MIN_EXHIBIT_BYTES filter */
function largeBuffer(seed: string): Buffer {
  return Buffer.alloc(6_000, seed);
}

describe('ExhibitExtractor', () => {
  let extractor: ExhibitExtractor;
  let mockPdfParser: jest.Mocked<PDFParser>;
  let mockOcrEngine: jest.Mocked<OCREngine>;

  const testCaseId = 'test-case-123';
  const testDocumentId = 'test-doc-456';
  const testFilePath = '/path/to/test.pdf';

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Create a mock OCR engine to pass to the constructor
    const MockOCREngine = OCREngine as jest.MockedClass<typeof OCREngine>;
    const ocrInstance = new MockOCREngine();

    // Create extractor instance with required OCR engine
    extractor = new ExhibitExtractor('public', undefined, ocrInstance);

    // Get mocked instances
    mockPdfParser = (extractor as any).pdfParser;
    mockOcrEngine = (extractor as any).ocrEngine;

    // Mock fs.mkdir to succeed
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await extractor.terminate();
  });

  describe('extractExhibits', () => {
    it('should extract exhibits and save them with correct naming convention', async () => {
      // Mock extracted images (large enough to pass filters)
      const mockImages = [
        {
          pageNumber: 1,
          imageIndex: 0,
          buffer: largeBuffer('a'),
          width: 800,
          height: 600,
        },
        {
          pageNumber: 3,
          imageIndex: 1,
          buffer: largeBuffer('b'),
          width: 1024,
          height: 768,
        },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);

      // Mock OCR results
      mockOcrEngine.recognizeImage
        .mockResolvedValueOnce({
          text: 'Exhibit text from page 1',
          confidence: 85,
        })
        .mockResolvedValueOnce({
          text: 'Exhibit text from page 3',
          confidence: 92,
        });

      // Extract exhibits
      const result = await extractor.extractExhibits(
        testFilePath,
        testCaseId,
        testDocumentId
      );

      // Verify directory creation
      expect(fs.mkdir).toHaveBeenCalledWith(
        path.join('public', 'exhibits', testCaseId),
        { recursive: true }
      );

      // Verify file writes with correct naming
      expect(fs.writeFile).toHaveBeenCalledTimes(2);
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join('public', 'exhibits', testCaseId, `${testDocumentId}_page1_img0.png`),
        mockImages[0].buffer
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        path.join('public', 'exhibits', testCaseId, `${testDocumentId}_page3_img1.png`),
        mockImages[1].buffer
      );

      // Verify OCR was called for each image
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledTimes(2);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledWith(mockImages[0].buffer);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledWith(mockImages[1].buffer);

      // Verify result structure
      expect(result.totalCount).toBe(2);
      expect(result.exhibits).toHaveLength(2);

      // Verify first exhibit metadata
      expect(result.exhibits[0]).toEqual({
        pageNumber: 1,
        imagePath: `/exhibits/${testCaseId}/${testDocumentId}_page1_img0.png`,
        extractedText: 'Exhibit text from page 1',
        confidence: 85,
      });

      // Verify second exhibit metadata
      expect(result.exhibits[1]).toEqual({
        pageNumber: 3,
        imagePath: `/exhibits/${testCaseId}/${testDocumentId}_page3_img1.png`,
        extractedText: 'Exhibit text from page 3',
        confidence: 92,
      });
    });

    it('should handle PDFs with no images', async () => {
      mockPdfParser.extractImages.mockResolvedValue([]);

      const result = await extractor.extractExhibits(
        testFilePath,
        testCaseId,
        testDocumentId
      );

      expect(result.totalCount).toBe(0);
      expect(result.exhibits).toHaveLength(0);
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
      expect(mockOcrEngine.recognizeImage).not.toHaveBeenCalled();
    });

    it('should handle OCR with low confidence', async () => {
      const mockImages = [
        {
          pageNumber: 1,
          imageIndex: 0,
          buffer: largeBuffer('a'),
          width: 800,
          height: 600,
        },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({
        text: '',
        confidence: 45, // Below 60% threshold
      });

      const result = await extractor.extractExhibits(
        testFilePath,
        testCaseId,
        testDocumentId
      );

      expect(result.totalCount).toBe(1);
      expect(result.exhibits[0].extractedText).toBe('');
      expect(result.exhibits[0].confidence).toBe(45);
    });

    it('should continue processing other exhibits if one fails', async () => {
      const mockImages = [
        {
          pageNumber: 1,
          imageIndex: 0,
          buffer: largeBuffer('a'),
          width: 800,
          height: 600,
        },
        {
          pageNumber: 2,
          imageIndex: 1,
          buffer: largeBuffer('b'),
          width: 1024,
          height: 768,
        },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);

      // First OCR fails, second succeeds
      mockOcrEngine.recognizeImage
        .mockRejectedValueOnce(new Error('OCR failed'))
        .mockResolvedValueOnce({
          text: 'Exhibit text from page 2',
          confidence: 88,
        });

      const result = await extractor.extractExhibits(
        testFilePath,
        testCaseId,
        testDocumentId
      );

      // Should have processed the second exhibit successfully
      expect(result.totalCount).toBe(1);
      expect(result.exhibits).toHaveLength(1);
      expect(result.exhibits[0].pageNumber).toBe(2);
    });

    it('should store exhibit metadata with all required fields', async () => {
      const mockImages = [
        {
          pageNumber: 5,
          imageIndex: 2,
          buffer: largeBuffer('x'),
          width: 1920,
          height: 1080,
        },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({
        text: 'Test exhibit text',
        confidence: 95,
      });

      const result = await extractor.extractExhibits(
        testFilePath,
        testCaseId,
        testDocumentId
      );

      const exhibit = result.exhibits[0];

      // Verify all required metadata fields are present
      expect(exhibit).toHaveProperty('pageNumber');
      expect(exhibit).toHaveProperty('imagePath');
      expect(exhibit).toHaveProperty('extractedText');
      expect(exhibit).toHaveProperty('confidence');

      // Verify values
      expect(exhibit.pageNumber).toBe(5);
      expect(exhibit.imagePath).toBe(`/exhibits/${testCaseId}/${testDocumentId}_page5_img2.png`);
      expect(exhibit.extractedText).toBe('Test exhibit text');
      expect(exhibit.confidence).toBe(95);
    });
  });

  describe('image filtering', () => {
    it('should filter out images smaller than 150px in either dimension', async () => {
      const mockImages = [
        // Too narrow
        { pageNumber: 1, imageIndex: 0, buffer: largeBuffer('a'), width: 100, height: 600 },
        // Too short
        { pageNumber: 1, imageIndex: 1, buffer: largeBuffer('b'), width: 800, height: 50 },
        // Valid
        { pageNumber: 1, imageIndex: 2, buffer: largeBuffer('c'), width: 800, height: 600 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      const result = await extractor.extractExhibits(testFilePath, testCaseId, testDocumentId);

      expect(result.totalCount).toBe(1);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledTimes(1);
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('should filter out images with buffer smaller than 5KB', async () => {
      const mockImages = [
        // Tiny buffer (< 5000 bytes)
        { pageNumber: 1, imageIndex: 0, buffer: Buffer.alloc(100), width: 800, height: 600 },
        // Valid buffer
        { pageNumber: 1, imageIndex: 1, buffer: largeBuffer('b'), width: 800, height: 600 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      const result = await extractor.extractExhibits(testFilePath, testCaseId, testDocumentId);

      expect(result.totalCount).toBe(1);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledTimes(1);
    });

    it('should filter out images with area below minimum threshold', async () => {
      const mockImages = [
        // 160x160 = 25,600 area — below MIN_EXHIBIT_AREA of 40,000
        { pageNumber: 1, imageIndex: 0, buffer: largeBuffer('a'), width: 160, height: 160 },
        // 250x250 = 62,500 area — above threshold
        { pageNumber: 1, imageIndex: 1, buffer: largeBuffer('b'), width: 250, height: 250 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      const result = await extractor.extractExhibits(testFilePath, testCaseId, testDocumentId);

      expect(result.totalCount).toBe(1);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate images with identical buffers', async () => {
      const sharedBuffer = largeBuffer('same');
      const mockImages = [
        { pageNumber: 1, imageIndex: 0, buffer: sharedBuffer, width: 800, height: 600 },
        { pageNumber: 2, imageIndex: 0, buffer: sharedBuffer, width: 800, height: 600 },
        { pageNumber: 3, imageIndex: 0, buffer: sharedBuffer, width: 800, height: 600 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'letterhead', confidence: 95 });

      const result = await extractor.extractExhibits(testFilePath, testCaseId, testDocumentId);

      // Only the first occurrence should be kept
      expect(result.totalCount).toBe(1);
      expect(result.exhibits[0].pageNumber).toBe(1);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledTimes(1);
      expect(fs.writeFile).toHaveBeenCalledTimes(1);
    });

    it('should keep distinct large images that pass all filters', async () => {
      const mockImages = [
        { pageNumber: 1, imageIndex: 0, buffer: largeBuffer('a'), width: 800, height: 600 },
        { pageNumber: 2, imageIndex: 0, buffer: largeBuffer('b'), width: 1024, height: 768 },
        { pageNumber: 3, imageIndex: 0, buffer: largeBuffer('c'), width: 1920, height: 1080 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'exhibit', confidence: 90 });

      const result = await extractor.extractExhibits(testFilePath, testCaseId, testDocumentId);

      expect(result.totalCount).toBe(3);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledTimes(3);
      expect(fs.writeFile).toHaveBeenCalledTimes(3);
    });

    it('should return empty result when all images are filtered out', async () => {
      const mockImages = [
        // All too small
        { pageNumber: 1, imageIndex: 0, buffer: Buffer.alloc(100), width: 32, height: 32 },
        { pageNumber: 2, imageIndex: 0, buffer: Buffer.alloc(200), width: 16, height: 16 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);

      const result = await extractor.extractExhibits(testFilePath, testCaseId, testDocumentId);

      expect(result.totalCount).toBe(0);
      expect(result.exhibits).toHaveLength(0);
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(mockOcrEngine.recognizeImage).not.toHaveBeenCalled();
    });
  });

  describe('boundary-aware filtering', () => {
    it('should filter out images outside exhibit boundaries', async () => {
      const mockImages = [
        // Page 1: cover page (outside exhibit range)
        { pageNumber: 1, imageIndex: 0, buffer: largeBuffer('cover'), width: 800, height: 600 },
        // Page 5: inside Exhibit A range
        { pageNumber: 5, imageIndex: 0, buffer: largeBuffer('exhibitA'), width: 800, height: 600 },
        // Page 10: inside Exhibit B range
        { pageNumber: 10, imageIndex: 0, buffer: largeBuffer('exhibitB'), width: 800, height: 600 },
        // Page 15: outside any exhibit range
        { pageNumber: 15, imageIndex: 0, buffer: largeBuffer('outro'), width: 800, height: 600 },
      ];

      const boundaries: ExhibitBoundary[] = [
        { label: 'Exhibit A', startPage: 4, endPage: 7 },
        { label: 'Exhibit B', startPage: 8, endPage: 12 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      const result = await extractor.extractExhibits(
        testFilePath, testCaseId, testDocumentId, boundaries
      );

      // Only pages 5 and 10 are inside exhibit ranges
      expect(result.totalCount).toBe(2);
      expect(result.exhibits[0].pageNumber).toBe(5);
      expect(result.exhibits[1].pageNumber).toBe(10);
      expect(mockOcrEngine.recognizeImage).toHaveBeenCalledTimes(2);
    });

    it('should label exhibits from boundaries', async () => {
      const mockImages = [
        { pageNumber: 5, imageIndex: 0, buffer: largeBuffer('a'), width: 800, height: 600 },
        { pageNumber: 10, imageIndex: 0, buffer: largeBuffer('b'), width: 800, height: 600 },
      ];

      const boundaries: ExhibitBoundary[] = [
        { label: 'Exhibit A', startPage: 4, endPage: 7 },
        { label: 'Exhibit B', startPage: 8, endPage: 12 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      const result = await extractor.extractExhibits(
        testFilePath, testCaseId, testDocumentId, boundaries
      );

      expect(result.exhibits[0].exhibitLabel).toBe('Exhibit A');
      expect(result.exhibits[1].exhibitLabel).toBe('Exhibit B');
    });

    it('should fall back to size-only filtering when no boundaries provided', async () => {
      const mockImages = [
        { pageNumber: 1, imageIndex: 0, buffer: largeBuffer('a'), width: 800, height: 600 },
        { pageNumber: 5, imageIndex: 0, buffer: largeBuffer('b'), width: 800, height: 600 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      // No boundaries passed → all size-passing images kept
      const result = await extractor.extractExhibits(
        testFilePath, testCaseId, testDocumentId
      );

      expect(result.totalCount).toBe(2);
    });

    it('should fall back to size-only filtering when boundaries array is empty', async () => {
      const mockImages = [
        { pageNumber: 1, imageIndex: 0, buffer: largeBuffer('a'), width: 800, height: 600 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      const result = await extractor.extractExhibits(
        testFilePath, testCaseId, testDocumentId, []
      );

      expect(result.totalCount).toBe(1);
    });

    it('should still apply size filters even within exhibit boundaries', async () => {
      const mockImages = [
        // Inside exhibit range but too small → filtered by size
        { pageNumber: 5, imageIndex: 0, buffer: Buffer.alloc(100), width: 32, height: 32 },
        // Inside exhibit range and large enough
        { pageNumber: 5, imageIndex: 1, buffer: largeBuffer('a'), width: 800, height: 600 },
      ];

      const boundaries: ExhibitBoundary[] = [
        { label: 'Exhibit A', startPage: 4, endPage: 7 },
      ];

      mockPdfParser.extractImages.mockResolvedValue(mockImages);
      mockOcrEngine.recognizeImage.mockResolvedValue({ text: 'text', confidence: 90 });

      const result = await extractor.extractExhibits(
        testFilePath, testCaseId, testDocumentId, boundaries
      );

      expect(result.totalCount).toBe(1);
      expect(result.exhibits[0].pageNumber).toBe(5);
    });
  });

  describe('terminate', () => {
    it('should cleanup OCR engine resources', async () => {
      await extractor.terminate();

      expect(mockOcrEngine.terminate).toHaveBeenCalled();
    });
  });
});

describe('detectExhibitBoundaries', () => {
  it('should detect EXHIBIT headers with letter identifiers', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'Introduction to the case', textDensity: 100 },
      { pageNumber: 2, text: 'EXHIBIT A\nSome content follows', textDensity: 50 },
      { pageNumber: 3, text: 'Content of exhibit A page 2', textDensity: 200 },
      { pageNumber: 4, text: 'EXHIBIT B\nAnother exhibit', textDensity: 50 },
      { pageNumber: 5, text: 'Conclusion', textDensity: 100 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toEqual({ label: 'Exhibit A', startPage: 2, endPage: 3 });
    expect(boundaries[1]).toEqual({ label: 'Exhibit B', startPage: 4, endPage: 5 });
  });

  it('should detect EXHIBIT headers with numeric identifiers', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'EXHIBIT 1\nFirst exhibit', textDensity: 50 },
      { pageNumber: 2, text: 'Page 2 of exhibit 1', textDensity: 200 },
      { pageNumber: 3, text: 'EXHIBIT 2\nSecond exhibit', textDensity: 50 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]).toEqual({ label: 'Exhibit 1', startPage: 1, endPage: 2 });
    expect(boundaries[1]).toEqual({ label: 'Exhibit 2', startPage: 3, endPage: 3 });
  });

  it('should detect "Exhibit No." format', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'Exhibit No. 3\nContent', textDensity: 50 },
      { pageNumber: 2, text: 'More content', textDensity: 200 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].label).toBe('Exhibit 3');
    expect(boundaries[0].startPage).toBe(1);
    expect(boundaries[0].endPage).toBe(2);
  });

  it('should detect APPENDIX headers', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'Main document', textDensity: 200 },
      { pageNumber: 2, text: 'APPENDIX A\nAppendix content', textDensity: 50 },
      { pageNumber: 3, text: 'Appendix A continued', textDensity: 200 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toEqual({ label: 'Appendix A', startPage: 2, endPage: 3 });
  });

  it('should detect ATTACHMENT headers', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'ATTACHMENT 1\nFirst attachment', textDensity: 50 },
      { pageNumber: 2, text: 'ATTACHMENT 2\nSecond attachment', textDensity: 50 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].label).toBe('Attachment 1');
    expect(boundaries[1].label).toBe('Attachment 2');
  });

  it('should handle case-insensitive headers', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'exhibit a\nContent', textDensity: 50 },
      { pageNumber: 2, text: 'Exhibit B\nContent', textDensity: 50 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(2);
  });

  it('should handle header with leading whitespace', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: '   EXHIBIT A\nCentered header', textDensity: 50 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].label).toBe('Exhibit A');
  });

  it('should return empty array when no headers found', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'Regular document text', textDensity: 200 },
      { pageNumber: 2, text: 'More regular text', textDensity: 200 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(0);
  });

  it('should return empty array for empty pages input', () => {
    expect(detectExhibitBoundaries([])).toHaveLength(0);
  });

  it('should handle multi-letter exhibit identifiers (AA, AB)', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'EXHIBIT AA\nContent', textDensity: 50 },
      { pageNumber: 2, text: 'EXHIBIT AB\nContent', textDensity: 50 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    expect(boundaries).toHaveLength(2);
    expect(boundaries[0].label).toBe('Exhibit AA');
    expect(boundaries[1].label).toBe('Exhibit AB');
  });

  it('should only match one header per page even if multiple patterns match', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: 'EXHIBIT A\nAPPENDIX B', textDensity: 50 },
      { pageNumber: 2, text: 'Content', textDensity: 200 },
    ];

    const boundaries = detectExhibitBoundaries(pages);

    // Should only match EXHIBIT A on page 1 (first pattern wins)
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].startPage).toBe(1);
  });
});

describe('isPageInExhibitRange', () => {
  const boundaries: ExhibitBoundary[] = [
    { label: 'Exhibit A', startPage: 3, endPage: 5 },
    { label: 'Exhibit B', startPage: 8, endPage: 12 },
  ];

  it('should return true for pages within a boundary', () => {
    expect(isPageInExhibitRange(3, boundaries)).toBe(true);
    expect(isPageInExhibitRange(4, boundaries)).toBe(true);
    expect(isPageInExhibitRange(5, boundaries)).toBe(true);
    expect(isPageInExhibitRange(8, boundaries)).toBe(true);
    expect(isPageInExhibitRange(10, boundaries)).toBe(true);
    expect(isPageInExhibitRange(12, boundaries)).toBe(true);
  });

  it('should return false for pages outside all boundaries', () => {
    expect(isPageInExhibitRange(1, boundaries)).toBe(false);
    expect(isPageInExhibitRange(2, boundaries)).toBe(false);
    expect(isPageInExhibitRange(6, boundaries)).toBe(false);
    expect(isPageInExhibitRange(7, boundaries)).toBe(false);
    expect(isPageInExhibitRange(13, boundaries)).toBe(false);
  });

  it('should return false for empty boundaries', () => {
    expect(isPageInExhibitRange(5, [])).toBe(false);
  });
});
