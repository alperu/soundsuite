import { CachedOCREngine, IOCREngine, ITaskOCREngine, OcrTask, OCRResult, asTaskEngine } from '../ocr-engine';

class FakeTaskEngine implements ITaskOCREngine {
  calls: Array<{ task: OcrTask }> = [];
  async recognizeImage(buf: Buffer): Promise<OCRResult> {
    return this.recognizeTask(buf, 'ocr');
  }
  async recognizeTask(_buf: Buffer, task: OcrTask): Promise<OCRResult> {
    this.calls.push({ task });
    return { text: `result-for-${task}`, confidence: 1 };
  }
  supportsTask(): boolean { return true; }
  async terminate(): Promise<void> {}
}

class FakePlainEngine implements IOCREngine {
  calls = 0;
  async recognizeImage(): Promise<OCRResult> {
    this.calls++;
    return { text: 'plain', confidence: 1 };
  }
  async terminate(): Promise<void> {}
}

describe('CachedOCREngine task-aware caching', () => {
  const img = Buffer.from('same-image-bytes');

  it('does NOT collide the same image across different tasks', async () => {
    const inner = new FakeTaskEngine();
    const cached = new CachedOCREngine(inner);

    const ocr = await cached.recognizeTask(img, 'ocr');
    const table = await cached.recognizeTask(img, 'table');

    expect(ocr.text).toBe('result-for-ocr');
    expect(table.text).toBe('result-for-table'); // pre-fix this returned the ocr result
    expect(inner.calls.map(c => c.task)).toEqual(['ocr', 'table']);
  });

  it('caches per task (second identical call hits cache)', async () => {
    const inner = new FakeTaskEngine();
    const cached = new CachedOCREngine(inner);

    await cached.recognizeTask(img, 'table');
    await cached.recognizeTask(img, 'table');
    await cached.recognizeImage(img); // = 'ocr' task, separate entry
    await cached.recognizeImage(img);

    expect(inner.calls.map(c => c.task)).toEqual(['table', 'ocr']);
  });

  it('recognizeTask(ocr) and recognizeImage share one cache entry', async () => {
    const inner = new FakeTaskEngine();
    const cached = new CachedOCREngine(inner);

    await cached.recognizeImage(img);
    await cached.recognizeTask(img, 'ocr');

    expect(inner.calls).toHaveLength(1);
  });

  it('plain inner engine: ocr passes through, other tasks throw', async () => {
    const inner = new FakePlainEngine();
    const cached = new CachedOCREngine(inner);

    await expect(cached.recognizeTask(img, 'ocr')).resolves.toEqual({ text: 'plain', confidence: 1 });
    await expect(cached.recognizeTask(img, 'table')).rejects.toThrow(/does not support/);
    expect(cached.supportsTask('ocr')).toBe(true);
    expect(cached.supportsTask('table')).toBe(false);
  });

  it('asTaskEngine feature-detects correctly', () => {
    expect(asTaskEngine(new FakeTaskEngine())).not.toBeNull();
    expect(asTaskEngine(new FakePlainEngine())).toBeNull();
    expect(asTaskEngine(new CachedOCREngine(new FakePlainEngine()))).not.toBeNull();
  });
});
