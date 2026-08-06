import { OllamaOCREngine } from '../ollama-ocr-engine';

// Assigned fresh in beforeEach — module-level capture of global.fetch is
// unreliable across setup-file ordering.
let mockFetch: jest.Mock;

const HOST = 'http://ocr-host:11434';
const MODEL = 'test-vision-model';

/** Successful /api/tags preflight response listing the configured model */
function tagsResponse() {
  return {
    ok: true,
    json: () => Promise.resolve({ models: [{ name: `${MODEL}:latest` }] }),
  };
}

/** Successful /api/generate response */
function generateResponse(text: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ response: text }),
  };
}

/** Route fetch calls: preflight (/api/tags) always succeeds; /api/generate uses the provided implementation */
function routeFetch(generateImpl: () => Promise<any> | any) {
  mockFetch.mockImplementation((url: string) => {
    if (String(url).includes('/api/tags')) return Promise.resolve(tagsResponse());
    return Promise.resolve(generateImpl());
  });
}

function timeoutError(): DOMException {
  return new DOMException('The operation timed out.', 'TimeoutError');
}

describe('OllamaOCREngine', () => {
  const buffer = Buffer.from('fake-image-data');

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('returns OCR text on first-attempt success', async () => {
    routeFetch(() => generateResponse('extracted text'));
    const engine = new OllamaOCREngine({ host: HOST, model: MODEL });

    const result = await engine.recognizeImage(buffer);

    expect(result.text).toBe('extracted text');
    expect(result.confidence).toBe(1.0);
    // 1 preflight + 1 generate
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries with backoff in [3000,4000] then [6000,7000] ms and succeeds on the third attempt', async () => {
    jest.useFakeTimers();
    let generateCalls = 0;
    routeFetch(() => {
      generateCalls++;
      if (generateCalls < 3) throw new Error('Ollama returned 500: boom');
      return generateResponse('third time lucky');
    });
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const engine = new OllamaOCREngine({ host: HOST, model: MODEL });

    const promise = engine.recognizeImage(buffer);
    // Drain both retry delays (upper bound covers max jitter)
    await jest.advanceTimersByTimeAsync(4000);
    await jest.advanceTimersByTimeAsync(7000);
    const result = await promise;

    expect(result.text).toBe('third time lucky');
    expect(generateCalls).toBe(3);

    // The two retry delays: base 3s and 6s, each plus [0,1000) jitter.
    // (Filter out the per-attempt abort timers, which are >= timeoutMs.)
    const delays = setTimeoutSpy.mock.calls
      .map((c) => c[1] as number)
      .filter((ms) => ms >= 3000 && ms < 8000);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(3000);
    expect(delays[0]).toBeLessThan(4000);
    expect(delays[1]).toBeGreaterThanOrEqual(6000);
    expect(delays[1]).toBeLessThan(7000);
  });

  it('fails after 3 attempts and reports a client-side timeout distinctly', async () => {
    jest.useFakeTimers();
    let generateCalls = 0;
    routeFetch(() => {
      generateCalls++;
      throw timeoutError();
    });
    const engine = new OllamaOCREngine({ host: HOST, model: MODEL, timeoutMs: 45_000 });

    const promise = engine.recognizeImage(buffer);
    const assertion = expect(promise).rejects.toThrow(/client-side timeout after 45000ms/);
    await jest.advanceTimersByTimeAsync(4000);
    await jest.advanceTimersByTimeAsync(7000);
    await assertion;

    expect(generateCalls).toBe(3);
  });

  it('does not remap host errors to the timeout message', async () => {
    jest.useFakeTimers();
    routeFetch(() => {
      throw new Error('Ollama returned 503: overloaded');
    });
    const engine = new OllamaOCREngine({ host: HOST, model: MODEL });

    const promise = engine.recognizeImage(buffer);
    const assertion = expect(promise).rejects.toThrow(/503: overloaded/);
    await jest.advanceTimersByTimeAsync(4000);
    await jest.advanceTimersByTimeAsync(7000);
    await assertion;
  });

  describe('timeoutMs config', () => {
    it.each([
      ['default', undefined, 90_000],
      ['explicit', 45_000, 45_000],
      ['zero falls back to default', 0, 90_000],
      ['negative falls back to default', -5, 90_000],
      ['NaN falls back to default', NaN, 90_000],
    ])('%s', (_label, input, expected) => {
      const engine = new OllamaOCREngine({ host: HOST, model: MODEL, timeoutMs: input as number | undefined });
      expect((engine as any).timeoutMs).toBe(expected);
    });
  });

  describe('degenerate-output guard', () => {
    const FOX = 'The quick brown fox jumps over the lazy dog.';

    it('discards repetition-loop output (returns empty text, confidence 0)', async () => {
      routeFetch(() => generateResponse((FOX + '\n\n').repeat(200)));
      const engine = new OllamaOCREngine({ host: HOST, model: MODEL });

      const result = await engine.recognizeImage(buffer);

      expect(result.text).toBe('');
      expect(result.confidence).toBe(0);
    });

    it('keeps legitimate long output', async () => {
      const legit = Array.from({ length: 60 }, (_, i) =>
        `${i + 1}. The respondent filed a motion regarding docket entry ${i * 7} on a distinct date.`).join('\n');
      routeFetch(() => generateResponse(legit));
      const engine = new OllamaOCREngine({ host: HOST, model: MODEL });

      const result = await engine.recognizeImage(buffer);

      expect(result.text).toBe(legit);
      expect(result.confidence).toBe(1.0);
    });
  });

  describe('task selection (fixed-task recognizer)', () => {
    const PADDLE = 'AuditAid/PaddleOCR-VL-1.6-0.9B';
    const paddleTags = () => ({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: `${PADDLE}:latest` }] }),
    });

    function captureGenerate(responseText: string) {
      const bodies: any[] = [];
      mockFetch.mockImplementation((url: string, init?: any) => {
        if (String(url).includes('/api/tags')) return Promise.resolve(paddleTags());
        bodies.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ response: responseText }) });
      });
      return bodies;
    }

    it('sends the task prompt and per-task num_predict for table recognition', async () => {
      const table = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>';
      const bodies = captureGenerate(table);
      const engine = new OllamaOCREngine({ host: HOST, model: PADDLE });

      const result = await engine.recognizeTask(buffer, 'table');

      expect(bodies[0].prompt).toBe('Table Recognition:');
      expect(bodies[0].options.num_predict).toBe(16384);
      expect(result.text).toBe(table);
    });

    it('recognizeImage is equivalent to task ocr', async () => {
      const bodies = captureGenerate('plain page text');
      const engine = new OllamaOCREngine({ host: HOST, model: PADDLE });

      await engine.recognizeImage(buffer);

      expect(bodies[0].prompt).toBe('OCR:');
      expect(bodies[0].options.num_predict).toBe(8192);
    });

    it('supportsTask: paddle yes, instruction model ocr-only', () => {
      const paddle = new OllamaOCREngine({ host: HOST, model: PADDLE });
      const chat = new OllamaOCREngine({ host: HOST, model: 'minicpm-v' });
      expect(paddle.supportsTask('table')).toBe(true);
      expect(paddle.supportsTask('seal')).toBe(true);
      expect(chat.supportsTask('ocr')).toBe(true);
      expect(chat.supportsTask('table')).toBe(false);
    });

    it('rejects unsupported tasks without any network call', async () => {
      const chat = new OllamaOCREngine({ host: HOST, model: 'minicpm-v' });
      await expect(chat.recognizeTask(buffer, 'table')).rejects.toThrow(/does not support/);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it('throws OcrNotReadyError without calling /api/generate when the model is not pulled', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/api/tags')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) });
      }
      throw new Error('generate should not be called');
    });
    const engine = new OllamaOCREngine({ host: HOST, model: MODEL });

    await expect(engine.recognizeImage(buffer)).rejects.toThrow(/not pulled/);
    const generateCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/api/generate'));
    expect(generateCalls).toHaveLength(0);
  });
});
