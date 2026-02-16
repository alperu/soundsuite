import { PDFParser, PDFParserConfig, isImageOcrWorthy, MIN_OCR_WIDTH, MIN_OCR_HEIGHT, MIN_OCR_AREA, MIN_OCR_BYTES } from '../pdf-parser';
import * as fs from 'fs/promises';

// Mock pdfdown — all methods return promises (async NAPI variants)
const mockTextPerPageAsync = jest.fn();
const mockImagesPerPageAsync = jest.fn();
const mockMetadataAsync = jest.fn();
const mockDocumentAsync = jest.fn();

jest.mock('@d0paminedriven/pdfdown', () => ({
  PdfDown: jest.fn().mockImplementation(() => ({
    textPerPageAsync: mockTextPerPageAsync,
    imagesPerPageAsync: mockImagesPerPageAsync,
    metadataAsync: mockMetadataAsync,
    documentAsync: mockDocumentAsync,
  })),
}));

jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('mock-pdf-data')),
}));

describe('PDFParser', () => {
  let parser: PDFParser;

  beforeEach(() => {
    jest.clearAllMocks();
    parser = new PDFParser();

    // Default mocks — all return promises
    mockTextPerPageAsync.mockResolvedValue([
      { page: 1, text: 'Hello World' },
      { page: 2, text: 'Page two' },
      { page: 3, text: 'Page three' },
    ]);
    mockImagesPerPageAsync.mockResolvedValue([]);
    mockMetadataAsync.mockResolvedValue({ pageCount: 3 });
    mockDocumentAsync.mockResolvedValue({ imagePages: [] });
  });

  describe('extractText', () => {
    it('should extract text from all pages', async () => {
      const pages = await parser.extractText('/test/file.pdf');

      expect(pages).toHaveLength(3);
      expect(pages[0]).toEqual({
        pageNumber: 1,
        text: 'Hello World',
        textDensity: 11,
      });
      expect(pages[1]).toEqual({
        pageNumber: 2,
        text: 'Page two',
        textDensity: 8,
      });
    });

    it('should invoke progress callback after each batch', async () => {
      const onProgress = jest.fn();
      // Use batch size of 2 so we get 2 batches for 3 pages
      const smallBatchParser = new PDFParser({ batchSize: 2 });

      await smallBatchParser.extractText('/test/file.pdf', onProgress);

      // Batch 1: pages 1-2, batch 2: page 3
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenCalledWith(2, 3);
      expect(onProgress).toHaveBeenCalledWith(3, 3);
    });

    it('should handle pages with empty text', async () => {
      mockTextPerPageAsync.mockResolvedValue([
        { page: 1, text: 'Page 1 text' },
        { page: 2, text: '' },
        { page: 3, text: 'Page 3 text' },
      ]);

      const pages = await parser.extractText('/test/file.pdf');

      expect(pages).toHaveLength(3);
      expect(pages[0].text).toBe('Page 1 text');
      expect(pages[1].text).toBe('');
      expect(pages[1].textDensity).toBe(0);
      expect(pages[2].text).toBe('Page 3 text');
    });

    it('should use custom batch size', async () => {
      const customParser = new PDFParser({ batchSize: 1 });
      const onProgress = jest.fn();

      await customParser.extractText('/test/file.pdf', onProgress);

      // One batch per page
      expect(onProgress).toHaveBeenCalledTimes(3);
    });
  });

  describe('renderPageToImage', () => {
    it('should return an image buffer for a page with images', async () => {
      const pngData = Buffer.alloc(2000, 0xab); // Large enough to pass OCR-worthy filter
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 612, height: 792, data: pngData },
      ]);

      const imageBuffer = await parser.renderPageToImage('/test/file.pdf', 1);

      expect(imageBuffer).toBe(pngData);
      expect(Buffer.isBuffer(imageBuffer)).toBe(true);
    });

    it('should return blank PNG for pages without images', async () => {
      mockImagesPerPageAsync.mockResolvedValue([]);

      const imageBuffer = await parser.renderPageToImage('/test/file.pdf', 1);

      expect(imageBuffer).toBeDefined();
      expect(Buffer.isBuffer(imageBuffer)).toBe(true);
      // Should be a valid PNG (starts with PNG signature)
      expect(imageBuffer[0]).toBe(0x89);
      expect(imageBuffer[1]).toBe(0x50); // 'P'
      expect(imageBuffer[2]).toBe(0x4e); // 'N'
      expect(imageBuffer[3]).toBe(0x47); // 'G'
    });

    it('should throw for out-of-range page numbers', async () => {
      await expect(parser.renderPageToImage('/test/file.pdf', 0)).rejects.toThrow('out of range');
      await expect(parser.renderPageToImage('/test/file.pdf', 4)).rejects.toThrow('out of range');
    });
  });

  describe('extractImages', () => {
    it('should extract images from the PDF', async () => {
      const pngData = Buffer.from('fake-png');
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 100, height: 100, data: pngData },
        { page: 2, imageIndex: 0, width: 200, height: 200, data: pngData },
      ]);

      const images = await parser.extractImages('/test/file.pdf');

      expect(images).toHaveLength(2);
      expect(images[0]).toEqual({
        pageNumber: 1,
        imageIndex: 0,
        buffer: pngData,
        width: 100,
        height: 100,
      });
    });

    it('should invoke progress callback', async () => {
      mockImagesPerPageAsync.mockResolvedValue([]);
      const onProgress = jest.fn();
      const smallBatchParser = new PDFParser({ batchSize: 2 });

      await smallBatchParser.extractImages('/test/file.pdf', onProgress);

      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('should return empty array when no images found', async () => {
      mockImagesPerPageAsync.mockResolvedValue([]);

      const images = await parser.extractImages('/test/file.pdf');
      expect(images).toHaveLength(0);
    });
  });

  describe('getPageCount', () => {
    it('should return the number of pages', async () => {
      const count = await parser.getPageCount('/test/file.pdf');

      expect(count).toBe(3);
    });
  });

  describe('pageHasImages', () => {
    it('should return true when page has images', async () => {
      mockDocumentAsync.mockResolvedValue({ imagePages: [1, 3] });

      expect(await parser.pageHasImages('/test/file.pdf', 1)).toBe(true);
      expect(await parser.pageHasImages('/test/file.pdf', 3)).toBe(true);
    });

    it('should return false when page has no images', async () => {
      mockDocumentAsync.mockResolvedValue({ imagePages: [1, 3] });

      expect(await parser.pageHasImages('/test/file.pdf', 2)).toBe(false);
    });

    it('should throw for out-of-range page numbers', async () => {
      await expect(parser.pageHasImages('/test/file.pdf', 0)).rejects.toThrow('out of range');
      await expect(parser.pageHasImages('/test/file.pdf', 4)).rejects.toThrow('out of range');
    });
  });

  describe('document caching', () => {
    it('should cache documents for reuse', async () => {
      await parser.loadDocument('/test/file.pdf');
      await parser.extractText('/test/file.pdf');

      // fs.readFile should only be called once (for loadDocument)
      // extractText uses cache
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should release documents from cache', async () => {
      await parser.loadDocument('/test/file.pdf');
      await parser.releaseDocument('/test/file.pdf');

      // After release, next call should read from disk again
      await parser.extractText('/test/file.pdf');
      expect(fs.readFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('image caching', () => {
    it('should call imagesPerPageAsync only once across multiple renderPageToImage calls', async () => {
      const pngData = Buffer.alloc(2000, 0xff); // >MIN_OCR_BYTES
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 200, height: 200, data: pngData },
        { page: 2, imageIndex: 0, width: 200, height: 200, data: pngData },
      ]);

      // Load doc into cache first
      await parser.loadDocument('/test/file.pdf');

      await parser.renderPageToImage('/test/file.pdf', 1);
      await parser.renderPageToImage('/test/file.pdf', 2);
      await parser.renderPageToImage('/test/file.pdf', 1);

      // imagesPerPageAsync should only be called once (cached after first call)
      expect(mockImagesPerPageAsync).toHaveBeenCalledTimes(1);
    });

    it('should call imagesPerPageAsync only once across extractImages and extractPageImages', async () => {
      const pngData = Buffer.from('fake-png');
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 100, height: 100, data: pngData },
      ]);

      await parser.loadDocument('/test/file.pdf');
      await parser.extractImages('/test/file.pdf');
      await parser.extractPageImages('/test/file.pdf', 1);

      expect(mockImagesPerPageAsync).toHaveBeenCalledTimes(1);
    });

    it('should clear image cache when document is released', async () => {
      const pngData = Buffer.alloc(2000, 0xff);
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 200, height: 200, data: pngData },
      ]);

      await parser.loadDocument('/test/file.pdf');
      await parser.renderPageToImage('/test/file.pdf', 1);
      expect(mockImagesPerPageAsync).toHaveBeenCalledTimes(1);

      // Release and reload
      await parser.releaseDocument('/test/file.pdf');
      await parser.loadDocument('/test/file.pdf');
      await parser.renderPageToImage('/test/file.pdf', 1);

      // Should be called again after cache was cleared
      expect(mockImagesPerPageAsync).toHaveBeenCalledTimes(2);
    });
  });

  describe('renderPageToImage filtering', () => {
    it('should skip tiny images and return blank PNG', async () => {
      // 1x1 image with tiny buffer
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 1, height: 1, data: Buffer.from('x') },
      ]);

      const result = await parser.renderPageToImage('/test/file.pdf', 1);
      // Should be the blank PNG (starts with PNG signature)
      expect(result[0]).toBe(0x89);
      expect(result[1]).toBe(0x50);
    });

    it('should return a large-enough image over a tiny one', async () => {
      const tinyData = Buffer.from('x');
      const goodData = Buffer.alloc(2000, 0xff);
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 1, height: 1, data: tinyData },
        { page: 1, imageIndex: 1, width: 200, height: 200, data: goodData },
      ]);

      const result = await parser.renderPageToImage('/test/file.pdf', 1);
      expect(result).toBe(goodData);
    });
  });

  describe('getOcrCandidateImage', () => {
    it('should return the first OCR-worthy image', async () => {
      const goodData = Buffer.alloc(2000, 0xff);
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 50, height: 50, data: Buffer.from('tiny') },
        { page: 1, imageIndex: 1, width: 200, height: 200, data: goodData },
      ]);

      await parser.loadDocument('/test/file.pdf');
      const candidate = await parser.getOcrCandidateImage('/test/file.pdf', 1);

      expect(candidate).not.toBeNull();
      expect(candidate!.imageIndex).toBe(1);
      expect(candidate!.buffer).toBe(goodData);
    });

    it('should return null when no images exist on page', async () => {
      mockImagesPerPageAsync.mockResolvedValue([]);

      await parser.loadDocument('/test/file.pdf');
      const candidate = await parser.getOcrCandidateImage('/test/file.pdf', 1);

      expect(candidate).toBeNull();
    });

    it('should return null when all images are tiny', async () => {
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 1, height: 1, data: Buffer.from('x') },
      ]);

      await parser.loadDocument('/test/file.pdf');
      const candidate = await parser.getOcrCandidateImage('/test/file.pdf', 1);

      expect(candidate).toBeNull();
    });

    it('should fall back to largest non-trivial image', async () => {
      // Below dimension thresholds but buffer > 100 bytes
      const mediumData = Buffer.alloc(500, 0xff);
      mockImagesPerPageAsync.mockResolvedValue([
        { page: 1, imageIndex: 0, width: 50, height: 50, data: mediumData },
      ]);

      await parser.loadDocument('/test/file.pdf');
      const candidate = await parser.getOcrCandidateImage('/test/file.pdf', 1);

      expect(candidate).not.toBeNull();
      expect(candidate!.imageIndex).toBe(0);
    });
  });

  describe('isImageOcrWorthy', () => {
    it('should accept large images', () => {
      expect(isImageOcrWorthy({
        width: 200, height: 200, buffer: Buffer.alloc(2000),
      })).toBe(true);
    });

    it('should reject images below minimum width', () => {
      expect(isImageOcrWorthy({
        width: 50, height: 200, buffer: Buffer.alloc(2000),
      })).toBe(false);
    });

    it('should reject images below minimum height', () => {
      expect(isImageOcrWorthy({
        width: 200, height: 50, buffer: Buffer.alloc(2000),
      })).toBe(false);
    });

    it('should reject images below minimum area', () => {
      // 100x99 = 9900 < 10000
      expect(isImageOcrWorthy({
        width: 100, height: 99, buffer: Buffer.alloc(2000),
      })).toBe(false);
    });

    it('should reject images with tiny buffer', () => {
      expect(isImageOcrWorthy({
        width: 200, height: 200, buffer: Buffer.alloc(500),
      })).toBe(false);
    });
  });

  describe('configuration', () => {
    it('should use default config when none provided', () => {
      const p = new PDFParser();
      expect(p).toBeDefined();
    });

    it('should accept custom config', () => {
      const config: Partial<PDFParserConfig> = {
        batchSize: 25,
        renderScale: 2.0,
      };
      const p = new PDFParser(config);
      expect(p).toBeDefined();
    });
  });
});
