import {
  LegalTextSplitter,
  isSectionHeading,
  isNumberedParagraph,
} from '../legal-text-splitter';
import { PageText, Exhibit } from '../text-chunker';

describe('Legal document structure detection', () => {
  describe('isSectionHeading', () => {
    it('detects SECTION headings', () => {
      expect(isSectionHeading('SECTION 1')).toBe(true);
      expect(isSectionHeading('SECTION 12')).toBe(true);
    });

    it('detects Article headings', () => {
      expect(isSectionHeading('Article II')).toBe(true);
      expect(isSectionHeading('ARTICLE IV')).toBe(true);
    });

    it('detects WHEREAS / WHEREFORE', () => {
      expect(isSectionHeading('WHEREAS')).toBe(true);
      expect(isSectionHeading('WHEREFORE')).toBe(true);
    });

    it('detects legal document markers', () => {
      expect(isSectionHeading('ORDER')).toBe(true);
      expect(isSectionHeading('MOTION')).toBe(true);
      expect(isSectionHeading('NOTICE')).toBe(true);
      expect(isSectionHeading('FINDINGS OF FACT')).toBe(true);
      expect(isSectionHeading('CONCLUSIONS OF LAW')).toBe(true);
    });

    it('detects all-caps lines as headings', () => {
      expect(isSectionHeading('BACKGROUND AND PROCEDURAL HISTORY')).toBe(true);
      expect(isSectionHeading('STATEMENT OF FACTS')).toBe(true);
    });

    it('rejects normal text', () => {
      expect(isSectionHeading('This is a normal sentence.')).toBe(false);
      expect(isSectionHeading('The court finds that...')).toBe(false);
      expect(isSectionHeading('')).toBe(false);
    });
  });

  describe('isNumberedParagraph', () => {
    it('detects "1." style numbering', () => {
      expect(isNumberedParagraph('1. First paragraph')).toBe(true);
      expect(isNumberedParagraph('12. Twelfth paragraph')).toBe(true);
    });

    it('detects "1.1" style numbering', () => {
      expect(isNumberedParagraph('1.1 Sub-paragraph')).toBe(true);
      expect(isNumberedParagraph('3.2.1 Deep nesting')).toBe(true);
    });

    it('detects "(a)" style numbering', () => {
      expect(isNumberedParagraph('(a) First item')).toBe(true);
      expect(isNumberedParagraph('(iv) Roman numeral')).toBe(true);
      expect(isNumberedParagraph('(1) Numeric paren')).toBe(true);
    });

    it('detects "a." style numbering', () => {
      expect(isNumberedParagraph('a. First item')).toBe(true);
    });

    it('rejects non-numbered text', () => {
      expect(isNumberedParagraph('This is normal text.')).toBe(false);
      expect(isNumberedParagraph('')).toBe(false);
    });
  });
});

describe('LegalTextSplitter', () => {
  const makeConfig = () => ({
    chunkSize: 512,
    overlapSize: 50,
    tokenizer: 'simple' as const,
  });

  describe('splitText', () => {
    it('returns empty array for empty text', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      expect(await splitter.splitText('')).toEqual([]);
      expect(await splitter.splitText('   ')).toEqual([]);
      splitter.dispose();
    });

    it('keeps short text as a single chunk', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      const result = await splitter.splitText('Short legal text.');
      expect(result).toHaveLength(1);
      expect(result[0].text).toContain('Short legal text.');
      splitter.dispose();
    });

    it('splits on section headings', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      const text = [
        'FINDINGS OF FACT',
        'The court finds the following facts.',
        '',
        'CONCLUSIONS OF LAW',
        'Based on the findings above, the court concludes.',
      ].join('\n');

      const result = await splitter.splitText(text);
      expect(result.length).toBeGreaterThanOrEqual(2);
      // First chunk should contain FINDINGS OF FACT
      expect(result[0].text).toContain('FINDINGS OF FACT');
      // A later chunk should contain CONCLUSIONS OF LAW
      const conclusionChunk = result.find(r => r.text.includes('CONCLUSIONS OF LAW'));
      expect(conclusionChunk).toBeDefined();
      splitter.dispose();
    });

    it('splits on numbered paragraphs', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      const text = [
        '1. The plaintiff filed a motion.',
        '2. The defendant responded.',
        '3. The court held a hearing.',
      ].join('\n');

      const result = await splitter.splitText(text);
      expect(result.length).toBeGreaterThanOrEqual(1);
      splitter.dispose();
    });

    it('prepends section heading as context to child chunks', async () => {
      const splitter = new LegalTextSplitter({
        chunkSize: 60, // small to force splitting
        overlapSize: 10,
        tokenizer: 'simple',
      });

      const text = [
        'FINDINGS OF FACT',
        '1. ' + 'The court finds important facts. '.repeat(10),
        '2. ' + 'Additional findings are noted. '.repeat(10),
      ].join('\n');

      const result = await splitter.splitText(text);
      // Chunks after the heading should have the heading as context
      const childChunks = result.filter(
        r => r.structureType !== 'section' && r.text.includes('FINDINGS OF FACT')
      );
      expect(childChunks.length).toBeGreaterThan(0);
      splitter.dispose();
    });

    it('assigns correct structure types', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      const text = [
        'ORDER',
        'The court hereby orders the following.',
      ].join('\n');

      const result = await splitter.splitText(text);
      expect(result.length).toBeGreaterThanOrEqual(1);
      // The first block is a section
      expect(result[0].structureType).toBe('section');
      splitter.dispose();
    });
  });

  describe('chunkPages', () => {
    it('produces chunks with legal metadata', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      const pages: PageText[] = [
        { pageNumber: 1, text: 'FINDINGS OF FACT\nThe court finds the following.' },
        { pageNumber: 2, text: '1. First finding.\n2. Second finding.' },
      ];

      const chunks = await splitter.chunkPages(pages, 'doc-1', 'case-1');
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.documentId).toBe('doc-1');
      expect(chunks[0].metadata.caseId).toBe('case-1');
      expect(chunks[0].metadata.pageNumber).toBe(1);
      expect((chunks[0].metadata as any).structureType).toBeDefined();
      splitter.dispose();
    });

    it('assigns sequential chunk indices across pages', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      const pages: PageText[] = [
        { pageNumber: 1, text: 'Page one content.' },
        { pageNumber: 2, text: 'Page two content.' },
      ];

      const chunks = await splitter.chunkPages(pages, 'doc-1', 'case-1');
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].metadata.chunkIndex).toBe(i);
      }
      splitter.dispose();
    });
  });

  describe('chunkExhibitText', () => {
    it('produces exhibit chunks with structure metadata', async () => {
      const splitter = new LegalTextSplitter(makeConfig());
      const exhibit: Exhibit = {
        pageNumber: 3,
        imagePath: '/exhibits/case-1/doc-1_page3_img0.png',
        ocrText: 'Exhibit text from OCR.',
        documentId: 'doc-1',
        caseId: 'case-1',
      };

      const chunks = await splitter.chunkExhibitText(exhibit.ocrText, exhibit);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].metadata.isExhibit).toBe(true);
      expect(chunks[0].metadata.exhibitPath).toBe(exhibit.imagePath);
      expect((chunks[0].metadata as any).structureType).toBeDefined();
      splitter.dispose();
    });
  });
});
