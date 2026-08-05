import { ExhibitExtractor } from '../exhibit-extractor';
import { PDFParser, ExtractedImage } from '../pdf-parser';
import { IOCREngine, OCRResult } from '../ocr-engine';
import * as fs from 'fs/promises';

jest.mock('../pdf-parser');
jest.mock('fs/promises');
jest.mock('../image-preprocessor', () => ({
  preprocessImage: jest.fn((buf: Buffer) => Promise.resolve(buf)),
  buildImageFilename: jest.fn((docId: string, pageNumber: number, imgIdx: number) =>
    `${docId}_page${pageNumber}_img${imgIdx}.png`
  ),
}));

const CASE_ID = 'case-1';
const DOC_ID = 'doc-1';
const FILE_PATH = '/path/to/test.pdf';

function makeImages(count: number): ExtractedImage[] {
  return Array.from({ length: count }, (_, i) => ({
    pageNumber: i + 1,
    imageIndex: 0,
    buffer: Buffer.alloc(6_000, i),
    width: 800,
    height: 600,
  }));
}

/** Mock OCR engine that records the maximum number of in-flight recognize calls */
class ConcurrencyTrackingOcrEngine implements IOCREngine {
  inFlight = 0;
  maxInFlight = 0;
  calls = 0;
  constructor(private failPages: Set<number> = new Set()) {}

  async recognizeImage(_buffer: Buffer): Promise<OCRResult> {
    this.calls++;
    const call = this.calls;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    // Yield so parallel tasks overlap
    await new Promise((r) => setTimeout(r, 10));
    this.inFlight--;
    if (this.failPages.has(call)) {
      throw new Error(`OCR failed for call ${call}`);
    }
    return { text: `text-${call}`, confidence: 0.9 };
  }

  async terminate(): Promise<void> {}
}

function makeExtractor(engine: IOCREngine): ExhibitExtractor {
  const extractor = new ExhibitExtractor('public', undefined, engine);
  const mockParser = (extractor as any).pdfParser as jest.Mocked<PDFParser>;
  mockParser.extractImages = jest.fn().mockResolvedValue(makeImages(8));
  return extractor;
}

describe('ExhibitExtractor concurrency and failure accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fs.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fs.writeFile as jest.Mock).mockResolvedValue(undefined);
  });

  // No poppler/boundary/motion options → legacy path, which uses ocrConcurrency for its single queue
  it('respects ocrConcurrency: 1 — never more than one OCR call in flight', async () => {
    const engine = new ConcurrencyTrackingOcrEngine();
    const extractor = makeExtractor(engine);

    const result = await extractor.extractExhibits(FILE_PATH, CASE_ID, DOC_ID, undefined, undefined, {
      ocrConcurrency: 1,
    });

    expect(result.totalCount).toBe(8);
    expect(engine.maxInFlight).toBe(1);
  });

  it('runs OCR in parallel with ocrConcurrency: 4', async () => {
    const engine = new ConcurrencyTrackingOcrEngine();
    const extractor = makeExtractor(engine);

    const result = await extractor.extractExhibits(FILE_PATH, CASE_ID, DOC_ID, undefined, undefined, {
      ocrConcurrency: 4,
    });

    expect(result.totalCount).toBe(8);
    expect(engine.maxInFlight).toBeGreaterThan(1);
    expect(engine.maxInFlight).toBeLessThanOrEqual(4);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', NaN],
    ['null', null],
    ['huge (clamped to 8)', 99],
  ])('does not throw for invalid concurrency value: %s', async (_label, value) => {
    const engine = new ConcurrencyTrackingOcrEngine();
    const extractor = makeExtractor(engine);

    const result = await extractor.extractExhibits(FILE_PATH, CASE_ID, DOC_ID, undefined, undefined, {
      ocrConcurrency: value as unknown as number,
    });

    expect(result.totalCount).toBe(8);
    expect(engine.maxInFlight).toBeLessThanOrEqual(8);
  });

  it('counts OCR failures in ocrFailedCount and keeps the exhibits with empty text', async () => {
    const engine = new ConcurrencyTrackingOcrEngine(new Set([2, 5]));
    const extractor = makeExtractor(engine);

    const result = await extractor.extractExhibits(FILE_PATH, CASE_ID, DOC_ID, undefined, undefined, {
      ocrConcurrency: 1,
    });

    // Failed exhibits are still indexed (image preserved) but flagged in the count
    expect(result.totalCount).toBe(8);
    expect(result.ocrFailedCount).toBe(2);
    const empty = result.exhibits.filter((e) => e.extractedText === '' && e.confidence === 0);
    expect(empty).toHaveLength(2);
  });

  it('reports ocrFailedCount: 0 when every page succeeds', async () => {
    const engine = new ConcurrencyTrackingOcrEngine();
    const extractor = makeExtractor(engine);

    const result = await extractor.extractExhibits(FILE_PATH, CASE_ID, DOC_ID);

    expect(result.ocrFailedCount).toBe(0);
  });
});
