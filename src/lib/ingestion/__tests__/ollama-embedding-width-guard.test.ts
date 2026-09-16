/** @jest-environment node */
/**
 * An Ollama host must not be allowed to return a width the requested model
 * does not produce.
 *
 * The incident this guards: `qwen3-embedding:4b` (2560) was requested, a fleet
 * host returned 1024, ~31k chunks were written at 1024, and every document was
 * stamped `ollama/qwen3-embedding:4b` because getModelName() reports the
 * CONFIGURED model rather than whatever actually served the request. The index
 * looked correctly labelled while holding a different model's vectors, and
 * search failed with "query=2560, stored=1024" long after the cause was gone.
 *
 * preflight() only checks the tag exists on the host, so it cannot catch a
 * mis-tagged pull. The returned width can.
 */

const embed = jest.fn();

jest.mock('ollama', () => ({
  Ollama: class {
    embed = (...a: unknown[]) => embed(...a);
  },
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/gpu/fleet-router', () => ({ resolveEndpoint: jest.fn() }), { virtual: true });

import { OllamaEmbeddingProvider, dimensionsForOllamaModel } from '../ollama-embedding-provider';

const HOST = 'http://ollama.invalid:11434';

function vectors(count: number, width: number): number[][] {
  return Array.from({ length: count }, () => new Array(width).fill(0.01));
}

/** preflight() hits /api/tags over fetch; make it always succeed. */
function stubPreflightOk() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      models: [
        { name: 'qwen3-embedding:4b' },
        { name: 'qwen3-embedding:4b-fp16' },
        { name: 'qwen3-embedding:0.6b' },
        { name: 'some-custom-model' },
      ],
    }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  embed.mockReset();
  stubPreflightOk();
});

describe('dimensionsForOllamaModel — the widths the guard relies on', () => {
  it('knows 4b is 2560 and 0.6b is 1024 (measured against a live host)', () => {
    expect(dimensionsForOllamaModel('qwen3-embedding:4b')).toBe(2560);
    expect(dimensionsForOllamaModel('qwen3-embedding:0.6b')).toBe(1024);
  });

  it('resolves precision-suffixed tags to the same width', () => {
    // `qwen3-embedding:4b-fp16` is the tag to pull when matching OpenRouter's
    // serving precision. Precision changes the numbers a little, never the
    // width — so the guard must not reject it as an unknown model.
    expect(dimensionsForOllamaModel('qwen3-embedding:4b-fp16')).toBe(2560);
  });
});

describe('OllamaEmbeddingProvider — returned-width guard', () => {
  it('rejects a 1024 response when 4b (2560) was requested — the actual incident', async () => {
    const p = new OllamaEmbeddingProvider({ host: HOST, model: 'qwen3-embedding:4b' });
    embed.mockResolvedValue({ embeddings: vectors(2, 1024) });

    await expect(p.embed(['a', 'b'])).rejects.toThrow(/1024-dim vectors for model "qwen3-embedding:4b"[\s\S]*2560/);
  });

  it('names the host, so the offending fleet member is identifiable', async () => {
    const p = new OllamaEmbeddingProvider({ host: HOST, model: 'qwen3-embedding:4b' });
    embed.mockResolvedValue({ embeddings: vectors(1, 1024) });

    await expect(p.embed(['a'])).rejects.toThrow(HOST);
  });

  it('accepts the correct width', async () => {
    const p = new OllamaEmbeddingProvider({ host: HOST, model: 'qwen3-embedding:4b' });
    embed.mockResolvedValue({ embeddings: vectors(2, 2560) });

    const out = await p.embed(['a', 'b']);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(2560);
  });

  it('accepts 2560 for the fp16 tag, and still rejects 1024 from it', async () => {
    const p = new OllamaEmbeddingProvider({ host: HOST, model: 'qwen3-embedding:4b-fp16' });

    embed.mockResolvedValue({ embeddings: vectors(1, 2560) });
    expect((await p.embed(['a']))[0]).toHaveLength(2560);

    embed.mockResolvedValue({ embeddings: vectors(1, 1024) });
    await expect(p.embed(['a'])).rejects.toThrow(/1024-dim[\s\S]*2560/);
  });

  it('accepts 1024 when 0.6b is what was actually requested', async () => {
    const p = new OllamaEmbeddingProvider({ host: HOST, model: 'qwen3-embedding:0.6b' });
    embed.mockResolvedValue({ embeddings: vectors(1, 1024) });

    expect((await p.embed(['a']))[0]).toHaveLength(1024);
  });

  it('leaves an unknown model alone — no width is known, so none is enforced', async () => {
    // The 384 fallback is a guess, not knowledge; enforcing it would break
    // every model missing from the table.
    const p = new OllamaEmbeddingProvider({ host: HOST, model: 'some-custom-model' });
    embed.mockResolvedValue({ embeddings: vectors(1, 777) });

    expect((await p.embed(['a']))[0]).toHaveLength(777);
  });
});
