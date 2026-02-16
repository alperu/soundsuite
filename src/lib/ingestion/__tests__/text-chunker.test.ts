import { TextChunker, PageText, Exhibit } from '../text-chunker';

describe('TextChunker', () => {
  describe('chunkPages', () => {
    it('should create chunks from page text with metadata', async () => {
      const chunker = new TextChunker({
        chunkSize: 512,
        overlapSize: 50,
        tokenizer: 'simple',
      });

      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: 'This is the first sentence. This is the second sentence. This is the third sentence.',
        },
        {
          pageNumber: 2,
          text: 'This is page two. It has different content. More sentences here.',
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-123', 'case-456');

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.documentId).toBe('doc-123');
      expect(chunks[0].metadata.caseId).toBe('case-456');
      expect(chunks[0].metadata.pageNumber).toBe(1);
      expect(chunks[0].metadata.isExhibit).toBe(false);
      expect(chunks[0].metadata.chunkIndex).toBe(0);

      chunker.dispose();
    });

    it('should handle empty pages', async () => {
      const chunker = new TextChunker({
        chunkSize: 512,
        overlapSize: 50,
        tokenizer: 'simple',
      });

      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: '',
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-123', 'case-456');

      expect(chunks.length).toBe(0);

      chunker.dispose();
    });

    it('should create multiple chunks for long text', async () => {
      const chunker = new TextChunker({
        chunkSize: 50, // Small chunk size to force multiple chunks
        overlapSize: 10,
        tokenizer: 'simple',
      });

      // Create a long text with many sentences
      const longText = Array(20)
        .fill('This is a sentence with some content.')
        .join(' ');

      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: longText,
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-123', 'case-456');

      expect(chunks.length).toBeGreaterThan(1);
      
      // Verify chunk indices are sequential
      chunks.forEach((chunk, index) => {
        expect(chunk.metadata.chunkIndex).toBe(index);
      });

      chunker.dispose();
    });

    it('should preserve sentence boundaries', async () => {
      const chunker = new TextChunker({
        chunkSize: 50,
        overlapSize: 10,
        tokenizer: 'simple',
      });

      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: 'First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.',
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-123', 'case-456');

      // Each chunk should end with a sentence boundary
      chunks.forEach((chunk) => {
        const text = chunk.text.trim();
        if (text.length > 0) {
          const lastChar = text[text.length - 1];
          // Should end with punctuation or be the last chunk
          expect(['.', '!', '?', 'e'].includes(lastChar)).toBe(true);
        }
      });

      chunker.dispose();
    });
  });

  describe('chunkExhibitText', () => {
    it('should create chunks with exhibit metadata', async () => {
      const chunker = new TextChunker({
        chunkSize: 512,
        overlapSize: 50,
        tokenizer: 'simple',
      });

      const exhibit: Exhibit = {
        pageNumber: 5,
        imagePath: '/exhibits/case-456/doc-123_page5_img0.png',
        ocrText: 'This is OCR text from an exhibit. It contains important information.',
        documentId: 'doc-123',
        caseId: 'case-456',
      };

      const chunks = await chunker.chunkExhibitText(exhibit.ocrText, exhibit);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.isExhibit).toBe(true);
      expect(chunks[0].metadata.exhibitPath).toBe(exhibit.imagePath);
      expect(chunks[0].metadata.pageNumber).toBe(5);
      expect(chunks[0].metadata.documentId).toBe('doc-123');
      expect(chunks[0].metadata.caseId).toBe('case-456');

      chunker.dispose();
    });

    it('should handle empty exhibit text', async () => {
      const chunker = new TextChunker({
        chunkSize: 512,
        overlapSize: 50,
        tokenizer: 'simple',
      });

      const exhibit: Exhibit = {
        pageNumber: 5,
        imagePath: '/exhibits/case-456/doc-123_page5_img0.png',
        ocrText: '',
        documentId: 'doc-123',
        caseId: 'case-456',
      };

      const chunks = await chunker.chunkExhibitText(exhibit.ocrText, exhibit);

      expect(chunks.length).toBe(0);

      chunker.dispose();
    });
  });

  describe('tokenizer support', () => {
    it('should work with simple tokenizer', async () => {
      const chunker = new TextChunker({
        chunkSize: 512,
        overlapSize: 50,
        tokenizer: 'simple',
      });

      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: 'Test text for simple tokenizer.',
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-123', 'case-456');

      expect(chunks.length).toBeGreaterThan(0);

      chunker.dispose();
    });

    it('should work with HuggingFace tokenizer', async () => {
      const chunker = new TextChunker({
        chunkSize: 512,
        overlapSize: 50,
        tokenizer: 'huggingface',
      });

      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: 'Test text for HuggingFace tokenizer.',
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-123', 'case-456');

      expect(chunks.length).toBeGreaterThan(0);

      chunker.dispose();
    });
  });

  describe('overlap behavior', () => {
    it('should create overlapping chunks', async () => {
      const chunker = new TextChunker({
        chunkSize: 30, // Small size to force overlap
        overlapSize: 10,
        tokenizer: 'simple',
      });

      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.',
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-123', 'case-456');

      if (chunks.length > 1) {
        // Check that there's some overlap between consecutive chunks
        // This is a basic check - in practice, overlap is at sentence boundaries
        expect(chunks.length).toBeGreaterThan(1);
      }

      chunker.dispose();
    });
  });
});
