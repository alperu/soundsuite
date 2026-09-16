/** @jest-environment node */
/**
 * OpenRouter rerank requests must be bounded per request, not only per
 * document.
 *
 * Deep Search's merge step sent all 150 pool documents in one call; Fireworks
 * (the only provider serving qwen3-reranker-8b) answered invalid_request_error,
 * surfaced through OpenRouter as a 503, while ≤45-document interactive reranks
 * on the same model succeeded all day. Eight sub-query reranks failing in
 * parallel then tripped the client's five-failure circuit breaker, taking
 * reranking away from every path for the cooldown.
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/db/config', () => ({ getConfig: jest.fn() }));
jest.mock('@/lib/openrouter/client', () => ({ rerankDocuments: jest.fn(), recordSpend: jest.fn() }));
jest.mock('@/lib/openrouter/models', () => ({ findRerankModel: jest.fn() }));

import { batchDocumentsForRerank } from '../reranker';

const doc = (chars: number) => 'x'.repeat(chars);

describe('batchDocumentsForRerank', () => {
  it('keeps a small set in one batch, preserving order', () => {
    const b = batchDocumentsForRerank([doc(10), doc(20), doc(30)], 40, 110_000);
    expect(b).toEqual([{ indices: [0, 1, 2], chars: 60 }]);
  });

  it('splits 150 short documents by the document ceiling — the Deep Search case', () => {
    const b = batchDocumentsForRerank(Array.from({ length: 150 }, () => doc(500)), 40, 110_000);
    expect(b.map((x) => x.indices.length)).toEqual([40, 40, 40, 30]);
    // Every index appears exactly once, in order.
    expect(b.flatMap((x) => x.indices)).toEqual(Array.from({ length: 150 }, (_, i) => i));
  });

  it('splits by the char ceiling before the document ceiling is reached', () => {
    // 10 docs × 18k chars (the per-document max) = 180k > 110k.
    const b = batchDocumentsForRerank(Array.from({ length: 10 }, () => doc(18_000)), 40, 110_000);
    expect(b.map((x) => x.indices.length)).toEqual([6, 4]);
    for (const x of b) expect(x.chars).toBeLessThanOrEqual(110_000);
  });

  it('gives an oversized single document its own batch rather than dropping it', () => {
    const b = batchDocumentsForRerank([doc(10), doc(200_000), doc(10)], 40, 110_000);
    expect(b.map((x) => x.indices)).toEqual([[0], [1], [2]]);
  });

  it('returns no batches for no documents', () => {
    expect(batchDocumentsForRerank([], 40, 110_000)).toEqual([]);
  });
});
