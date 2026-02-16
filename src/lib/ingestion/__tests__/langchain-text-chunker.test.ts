/**
 * Tests for LangChainTextChunker
 */

// Mock @langchain/textsplitters to avoid TextEncoder issues in jest/jsdom
jest.mock('@langchain/textsplitters', () => ({
  RecursiveCharacterTextSplitter: jest.fn().mockImplementation(({ chunkSize, chunkOverlap }) => ({
    splitText: jest.fn().mockImplementation(async (text: string) => {
      // Simple mock: split text into chunks of chunkSize characters
      if (!text || !text.trim()) return [];
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += (chunkSize - chunkOverlap)) {
        const chunk = text.slice(i, i + chunkSize).trim();
        if (chunk) chunks.push(chunk);
      }
      return chunks.length > 0 ? chunks : [text.trim()];
    }),
  })),
}));

import { LangChainTextChunker } from '../langchain-text-chunker';
import { PageText, Exhibit } from '../text-chunker';

describe('LangChainTextChunker', () => {
  let chunker: LangChainTextChunker;

  beforeEach(() => {
    chunker = new LangChainTextChunker({ chunkSize: 100, overlapSize: 10 });
  });

  afterEach(() => {
    chunker.dispose();
  });

  describe('chunkPages', () => {
    it('should chunk basic text pages', async () => {
      const pages: PageText[] = [
        { pageNumber: 1, text: 'This is a simple test page with some content.' },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.documentId).toBe('doc-1');
      expect(chunks[0].metadata.caseId).toBe('case-1');
      expect(chunks[0].metadata.pageNumber).toBe(1);
      expect(chunks[0].metadata.isExhibit).toBe(false);
    });

    it('should handle empty text', async () => {
      const pages: PageText[] = [
        { pageNumber: 1, text: '' },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');
      expect(chunks.length).toBe(0);
    });

    it('should handle whitespace-only text', async () => {
      const pages: PageText[] = [
        { pageNumber: 1, text: '   \n\n  \t  ' },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');
      expect(chunks.length).toBe(0);
    });

    it('should detect and prepend section headings', async () => {
      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: `SECTION 1
This is the content of section one. It has a few sentences.

SECTION 2
This is the content of section two. It also has some text.`,
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');

      expect(chunks.length).toBeGreaterThan(0);
      const hasSection1 = chunks.some(c => c.text.includes('SECTION 1'));
      const hasSection2 = chunks.some(c => c.text.includes('SECTION 2'));
      expect(hasSection1).toBe(true);
      expect(hasSection2).toBe(true);
    });

    it('should detect legal markers as headings', async () => {
      const pages: PageText[] = [
        {
          pageNumber: 1,
          text: `ORDER
The court hereby orders the following actions.

FINDINGS OF FACT
The court finds the following facts to be true.`,
        },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');

      expect(chunks.length).toBeGreaterThan(0);
      const hasOrder = chunks.some(c => c.text.includes('ORDER'));
      const hasFindings = chunks.some(c => c.text.includes('FINDINGS OF FACT'));
      expect(hasOrder).toBe(true);
      expect(hasFindings).toBe(true);
    });

    it('should prepend document summary (SAC) when provided', async () => {
      const pages: PageText[] = [
        { pageNumber: 1, text: 'Some document content here.' },
      ];

      const summary = 'Motion for Summary Judgment filed by Plaintiff Corp against Defendant LLC.';
      const sacContext = { caseName: 'Smith v. Jones', filingType: 'Motion', documentSummary: summary };
      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1', sacContext);

      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.text).toContain(`Case: Smith v. Jones`);
        expect(chunk.text).toContain(`Filing: Motion`);
        expect(chunk.text).toContain(`Summary: ${summary}`);
      }
    });

    it('should work without document summary', async () => {
      const pages: PageText[] = [
        { pageNumber: 1, text: 'Some document content here.' },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');

      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.text).not.toContain('[Document:');
      }
    });

    it('should assign sequential chunk indices across pages', async () => {
      const pages: PageText[] = [
        { pageNumber: 1, text: 'Page one content.' },
        { pageNumber: 2, text: 'Page two content.' },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');

      const indices = chunks.map(c => c.metadata.chunkIndex);
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBe(indices[i - 1] + 1);
      }
    });

    it('should split long text into multiple chunks', async () => {
      // Create text that exceeds chunk size (100 tokens * 4 chars = 400 chars)
      const longText = Array.from({ length: 20 }, (_, i) =>
        `Paragraph ${i + 1}: This is a longer paragraph with enough text to contribute to exceeding the chunk size limit.`
      ).join('\n\n');

      const pages: PageText[] = [
        { pageNumber: 1, text: longText },
      ];

      const chunks = await chunker.chunkPages(pages, 'doc-1', 'case-1');
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe('chunkExhibitText', () => {
    const exhibit: Exhibit = {
      pageNumber: 5,
      imagePath: '/exhibits/exhibit-1.png',
      ocrText: 'Exhibit text content',
      documentId: 'doc-1',
      caseId: 'case-1',
    };

    it('should chunk exhibit text with correct metadata', async () => {
      const chunks = await chunker.chunkExhibitText('This is exhibit text content.', exhibit);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.documentId).toBe('doc-1');
      expect(chunks[0].metadata.caseId).toBe('case-1');
      expect(chunks[0].metadata.pageNumber).toBe(5);
      expect(chunks[0].metadata.isExhibit).toBe(true);
      expect(chunks[0].metadata.exhibitPath).toBe('/exhibits/exhibit-1.png');
    });

    it('should prepend SAC summary to exhibit chunks', async () => {
      const summary = 'Deposition transcript of witness John Doe.';
      const sacContext = { documentSummary: summary };
      const chunks = await chunker.chunkExhibitText('Exhibit content here.', exhibit, sacContext);

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].text).toContain(`Summary: ${summary}`);
    });

    it('should handle empty exhibit text', async () => {
      const chunks = await chunker.chunkExhibitText('', exhibit);
      expect(chunks.length).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should not throw on dispose', () => {
      expect(() => chunker.dispose()).not.toThrow();
    });
  });
});
