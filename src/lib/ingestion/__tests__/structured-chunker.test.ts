import { StructuredChunker, truncateMiddle } from '../structured-chunker';
import type { Chunk, Exhibit, ITextChunker, PageText, SacContext } from '../text-chunker';
import type { DocparseBlock } from '../docparse-types';

class FakeInner implements ITextChunker {
  pagesCalls: PageText[][] = [];
  async chunkPages(pages: PageText[], documentId: string, caseId: string): Promise<Chunk[]> {
    this.pagesCalls.push(pages);
    return pages.map((p, i) => ({
      text: `INNER:${p.pageNumber}`,
      metadata: { documentId, caseId, pageNumber: p.pageNumber, chunkIndex: i, isExhibit: false },
    }));
  }
  async chunkExhibitText(text: string): Promise<Chunk[]> {
    return [{ text: `INNER-EX:${text}`, metadata: { documentId: 'd', caseId: 'c', pageNumber: 1, chunkIndex: 0, isExhibit: true } }];
  }
  dispose(): void {}
}

const block = (type: DocparseBlock['type'], text: string, order: number): DocparseBlock =>
  ({ type, text, bbox: [0, 0, 100, 100], order });

const page = (pageNumber: number, blocks?: DocparseBlock[]): PageText =>
  ({ pageNumber, text: 'raw page text', ...(blocks ? { blocks } : {}) });

const SAC: SacContext = { caseName: 'In re Doe', filingType: 'motion' };

describe('StructuredChunker', () => {
  it('delegates ENTIRELY when no page has blocks (byte-identical path)', async () => {
    const inner = new FakeInner();
    const chunker = new StructuredChunker(inner);
    const pages = [page(1), page(2)];
    const chunks = await chunker.chunkPages(pages, 'd', 'c', SAC);
    expect(chunks.map(c => c.text)).toEqual(['INNER:1', 'INNER:2']);
    expect(inner.pagesCalls[0]).toBe(pages);
  });

  it('chunks structured pages with heading prefix and furniture excluded', async () => {
    const chunker = new StructuredChunker(new FakeInner());
    const pages = [page(1, [
      block('page_header', 'Filed 1/01/2026 District Clerk', 0),
      block('heading', 'ORDERS ABOUT CONDUCT', 1),
      block('paragraph', 'All parties are ordered to behave.', 2),
      block('page_number', 'Page 1 of 2', 3),
    ])];
    const chunks = await chunker.chunkPages(pages, 'd', 'c', SAC);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('[Case: In re Doe | Filing: motion]\n\nORDERS ABOUT CONDUCT\nAll parties are ordered to behave.');
    expect(chunks[0].text).not.toContain('District Clerk');
    expect(chunks[0].text).not.toContain('Page 1 of 2');
  });

  it('bounds the summary and budgets the prefix against the body', async () => {
    const chunker = new StructuredChunker(new FakeInner());
    const bigSummary = 'S'.repeat(600);
    const longPara = 'A sentence about the case. '.repeat(80); // ~2160 chars
    const pages = [page(1, [block('paragraph', longPara.trim(), 0)])];
    const chunks = await chunker.chunkPages(pages, 'd', 'c', { caseName: 'X', documentSummary: bigSummary });
    // summary truncated
    expect(chunks[0].text.length).toBeLessThanOrEqual(1000 + 20); // prefix+body ≈ PROSE_MAX
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1020);
    }
    expect(chunks.length).toBeGreaterThan(1); // long para split
  });

  it('keeps small tables atomic and splits big tables with header repeat', async () => {
    const chunker = new StructuredChunker(new FakeInner());
    const smallTable = 'Date | Amount\n2024-01-01 | $100\n2024-02-01 | $110';
    const bigRows = Array.from({ length: 120 }, (_, i) => `2024-01-${String(i % 28 + 1).padStart(2, '0')} | Mortgage payment number ${i} | $${1450 + i}.00`);
    const bigTable = ['Date | Description | Amount', ...bigRows].join('\n');
    const pages = [page(1, [
      block('heading', 'Damages Schedule', 0),
      block('table', smallTable, 1),
      block('table', bigTable, 2),
    ])];
    const chunks = await chunker.chunkPages(pages, 'd', 'c');
    expect(chunks[0].text).toBe('Damages Schedule\n' + smallTable);
    const bigFragments = chunks.slice(1);
    expect(bigFragments.length).toBeGreaterThan(1);
    for (const f of bigFragments) {
      expect(f.text).toContain('Date | Description | Amount'); // header repeated
      expect(f.text.length).toBeLessThanOrEqual(2048 + 100);
    }
    // no rows lost
    const joined = bigFragments.map(f => f.text).join('\n');
    for (const r of [bigRows[0], bigRows[59], bigRows[119]]) expect(joined).toContain(r);
  });

  it('merges structured and delegated pages in page order with unique chunkIndex', async () => {
    const inner = new FakeInner();
    const chunker = new StructuredChunker(inner);
    const pages = [
      page(1), // unstructured → inner
      page(2, [block('paragraph', 'structured content on page two', 0)]),
      page(3), // unstructured → inner
    ];
    const chunks = await chunker.chunkPages(pages, 'd', 'c');
    expect(chunks.map(c => c.metadata.pageNumber)).toEqual([1, 2, 3]);
    expect(chunks.map(c => c.metadata.chunkIndex)).toEqual([0, 1, 2]);
    expect(inner.pagesCalls[0].map(p => p.pageNumber)).toEqual([1, 3]);
  });

  it('heading resets per following content; heading never duplicated in body', async () => {
    const chunker = new StructuredChunker(new FakeInner());
    const pages = [page(1, [
      block('heading', 'I. INTRODUCTION', 0),
      block('paragraph', 'Intro text.', 1),
      block('heading', 'II. ARGUMENT', 2),
      block('paragraph', 'Argument text.', 3),
    ])];
    const chunks = await chunker.chunkPages(pages, 'd', 'c');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('I. INTRODUCTION\nIntro text.');
    expect(chunks[1].text).toBe('II. ARGUMENT\nArgument text.');
    expect(chunks[0].text.match(/I\. INTRODUCTION/g)).toHaveLength(1);
  });

  it('delegates exhibit chunking and dispose to the inner chunker', async () => {
    const chunker = new StructuredChunker(new FakeInner());
    const ex: Exhibit = { documentId: 'd', caseId: 'c', pageNumber: 1, imagePath: '/x.png', ocrText: 'x' };
    const chunks = await chunker.chunkExhibitText('exhibit text', ex);
    expect(chunks[0].text).toBe('INNER-EX:exhibit text');
    expect(() => chunker.dispose()).not.toThrow();
  });

  it('truncateMiddle keeps both ends on word boundaries', () => {
    const long = 'ORDERS ABOUT PROPERTY AND USE OF MONEY DURING DIVORCE CASES FILED IN THE DISTRICT COURTS OF TRAVIS COUNTY TEXAS UNDER THE STANDING ORDER PROVISIONS APPLICABLE TO FAMILY LAW MATTERS GENERALLY';
    const t = truncateMiddle(long, 96);
    expect(t.length).toBeLessThanOrEqual(96 + 3);
    expect(t).toContain('ORDERS ABOUT');
    expect(t).toContain('…');
    expect(truncateMiddle('short', 96)).toBe('short');
  });
});
