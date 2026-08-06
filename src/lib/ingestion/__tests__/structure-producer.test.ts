import { produceStructuredPages } from '../structure-producer';
import type { DocparsePageResult } from '../docparse-types';
import type { ITaskOCREngine, OcrTask, OCRResult } from '../ocr-engine';
import type { PageText } from '../pdf-parser';

const OTSL = '<fcel>Date<fcel>Amount<nl><fcel>2024-01-01<fcel>$100<nl><fcel>2024-02-01<fcel>$110<nl>';

function fakeExtract(blocksPerPage: Record<number, DocparsePageResult['blocks']>) {
  return async (_fp: string, pageNums: number[]): Promise<DocparsePageResult[]> =>
    pageNums.filter(n => blocksPerPage[n]).map(n => ({ pageNumber: n, blocks: blocksPerPage[n], producer: 'pdf' as const }));
}

function fakeCrop(ok = true) {
  const calls: any[] = [];
  const fn = async (fp: string, pageNum: number, bbox: [number, number, number, number]) => {
    calls.push({ pageNum, bbox });
    return ok ? { buffer: Buffer.from('png'), bboxPt: bbox, widthPx: 400, heightPx: 300 } : null;
  };
  return { fn, calls };
}

class FakeEngine implements ITaskOCREngine {
  constructor(private tableText: string, private supports = true) {}
  tasks: OcrTask[] = [];
  async recognizeImage(): Promise<OCRResult> { return { text: 'flat', confidence: 1 }; }
  async recognizeTask(_b: Buffer, task: OcrTask): Promise<OCRResult> {
    this.tasks.push(task);
    return { text: this.tableText, confidence: 1 };
  }
  supportsTask(): boolean { return this.supports; }
  async terminate(): Promise<void> {}
}

const page = (pageNumber: number, textDensity: number, text = 'some page text'): PageText =>
  ({ pageNumber, text, textDensity });

describe('produceStructuredPages', () => {
  const TABLE_BLOCK = { type: 'table' as const, text: 'Date Amount\n2024-01-01 $100', bbox: [72, 100, 500, 300] as [number, number, number, number], order: 1 };
  const PARA_BLOCK = { type: 'paragraph' as const, text: 'Some prose.', bbox: [72, 50, 500, 90] as [number, number, number, number], order: 0 };

  it('attaches pdf blocks to born-digital pages and escalates tables via OTSL', async () => {
    const pages = [page(1, 500)];
    const crop = fakeCrop();
    const engine = new FakeEngine(OTSL);
    const counters = await produceStructuredPages({
      filePath: '/x.pdf', pages, ocrThreshold: 50, ocrEngine: engine,
      cropFn: crop.fn as any, extractFn: fakeExtract({ 1: [PARA_BLOCK, { ...TABLE_BLOCK }] }),
    });

    expect(counters).toEqual({ pdfBlockPages: 1, ocrFlatPages: 0, tableRegionsAttempted: 1, tableRegionsAccepted: 1 });
    const table = pages[0].blocks!.find(b => b.type === 'table')!;
    expect(table.html).toContain('<table>');
    expect(table.markdown).toContain('| Date | Amount |');
    expect(table.text).toBe('Date | Amount\n2024-01-01 | $100\n2024-02-01 | $110');
    expect(engine.tasks).toEqual(['table']);
  });

  it('keeps plain text when escalation is gate-rejected (empty text)', async () => {
    const pages = [page(1, 500)];
    const engine = new FakeEngine(''); // engine gate rejected → empty
    const counters = await produceStructuredPages({
      filePath: '/x.pdf', pages, ocrThreshold: 50, ocrEngine: engine,
      cropFn: fakeCrop().fn as any, extractFn: fakeExtract({ 1: [{ ...TABLE_BLOCK }] }),
    });
    expect(counters.tableRegionsAttempted).toBe(1);
    expect(counters.tableRegionsAccepted).toBe(0);
    const table = pages[0].blocks![0];
    expect(table.text).toBe(TABLE_BLOCK.text);
    expect(table.html).toBeUndefined();
  });

  it('skips escalation when engine lacks table support', async () => {
    const pages = [page(1, 500)];
    const engine = new FakeEngine(OTSL, false);
    const counters = await produceStructuredPages({
      filePath: '/x.pdf', pages, ocrThreshold: 50, ocrEngine: engine,
      cropFn: fakeCrop().fn as any, extractFn: fakeExtract({ 1: [{ ...TABLE_BLOCK }] }),
    });
    expect(counters.tableRegionsAttempted).toBe(0);
    expect(engine.tasks).toEqual([]);
  });

  it('scanned pages get one flat ocr block', async () => {
    const pages = [page(3, 5, 'ocr text from a scan')];
    const counters = await produceStructuredPages({
      filePath: '/x.pdf', pages, ocrThreshold: 50, ocrEngine: null,
      extractFn: fakeExtract({}),
    });
    expect(counters.ocrFlatPages).toBe(1);
    expect(pages[0].blocks).toEqual([{ type: 'paragraph', text: 'ocr text from a scan', bbox: null, order: 0 }]);
  });

  it('failed crop keeps plain text, extraction failure leaves pages unstructured', async () => {
    const pages = [page(1, 500)];
    const engine = new FakeEngine(OTSL);
    const c1 = await produceStructuredPages({
      filePath: '/x.pdf', pages, ocrThreshold: 50, ocrEngine: engine,
      cropFn: fakeCrop(false).fn as any, extractFn: fakeExtract({ 1: [{ ...TABLE_BLOCK }] }),
    });
    expect(c1.tableRegionsAccepted).toBe(0);
    expect(pages[0].blocks![0].text).toBe(TABLE_BLOCK.text);

    const pages2 = [page(1, 500)];
    const c2 = await produceStructuredPages({
      filePath: '/x.pdf', pages: pages2, ocrThreshold: 50, ocrEngine: engine,
      extractFn: async () => { throw new Error('boom'); },
    });
    expect(c2.pdfBlockPages).toBe(0);
    expect(pages2[0].blocks).toBeUndefined();
  });
});
