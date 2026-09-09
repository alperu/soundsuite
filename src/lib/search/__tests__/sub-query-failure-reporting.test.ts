/** @jest-environment node */
/**
 * A failed sub-query and a sub-query that honestly matched nothing must not
 * look the same.
 *
 * Both yield `sources: []`. Before docs/tasks/30's follow-up they were
 * indistinguishable all the way out to `research_evidence`, so a
 * `searchMode: 'vector'` run against a down embedding role returned a
 * successful, empty result that read exactly like "the corpus has nothing".
 *
 * The tolerance is deliberate and must stay: one failing sub-query does not
 * abort the fan-out. Only the silence was the defect.
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy).
 */

jest.mock('@/lib/db/config', () => ({ getConfig: jest.fn().mockResolvedValue({ rerankPoolSize: 150 }) }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { executeParallelSearches } from '../deep-search';

/** A registry whose `query_case_knowledge` behaves per sub-query. */
function registryWith(byQuery: Record<string, any>) {
  return {
    execute: jest.fn(async (_tool: string, params: any) => byQuery[params.query]),
  } as any;
}

const ok = (results: any[] = []) => ({ success: true, data: { results } });
const failed = (errorCode: string, error: string) => ({ success: false, errorCode, error });

const hit = { text: 'a chunk', document: 'motion.pdf', page: 1, score: 0.9 };

describe('executeParallelSearches marks failures, not empties', () => {
  it('leaves `error` unset when a sub-query honestly matched nothing', async () => {
    const registry = registryWith({ 'sub one': ok([]) });
    const [r] = await executeParallelSearches(['sub one'], undefined, registry);
    expect(r.sources).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('sets `error` with the code and message when the tool failed', async () => {
    const registry = registryWith({
      'sub one': failed('EMBEDDING_UNAVAILABLE', 'connection refused (http://embed.invalid:11434)'),
    });
    const [r] = await executeParallelSearches(['sub one'], undefined, registry);
    expect(r.sources).toEqual([]);
    expect(r.error).toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
    expect(r.error!.message).toContain('http://embed.invalid:11434');
  });

  it('reports a NON-embedding failure too — no special-casing', async () => {
    const registry = registryWith({ 'sub one': failed('EXECUTION_ERROR', 'the tool failed while executing') });
    const [r] = await executeParallelSearches(['sub one'], undefined, registry);
    expect(r.error).toMatchObject({ code: 'EXECUTION_ERROR' });
  });

  it('reports a thrown error, carrying its code when it has one', async () => {
    const registry = {
      execute: jest.fn().mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    } as any;
    const [r] = await executeParallelSearches(['sub one'], undefined, registry);
    expect(r.error).toMatchObject({ code: 'ECONNRESET', message: 'socket hang up' });
  });

  it('flags a malformed success (no results array) as a failure, not an empty', async () => {
    const registry = registryWith({ 'sub one': { success: true, data: {} } });
    const [r] = await executeParallelSearches(['sub one'], undefined, registry);
    expect(r.error).toMatchObject({ code: 'MALFORMED_RESULT' });
  });

  it('does NOT abort the fan-out — healthy sub-queries still return evidence', async () => {
    const registry = registryWith({
      'sub one': failed('EMBEDDING_UNAVAILABLE', 'embed down'),
      'sub two': ok([hit]),
      'sub three': ok([]),
    });
    const results = await executeParallelSearches(['sub one', 'sub two', 'sub three'], undefined, registry);

    // The tolerance is the point: one failure must not cost the other results.
    expect(results.find((r) => r.subQuery === 'sub two')!.sources).toHaveLength(1);
    // Exactly one failure, and the honest empty is not counted as one.
    expect(results.filter((r) => r.error)).toHaveLength(1);
    expect(results.find((r) => r.subQuery === 'sub three')!.error).toBeUndefined();
  });
});
