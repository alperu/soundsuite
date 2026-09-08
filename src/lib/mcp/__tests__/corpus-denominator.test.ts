/**
 * @jest-environment node
 *
 * The denominator under every proven-absence claim (task 23 items 5–6).
 *
 * The rule these tests exist to enforce, stated once: **the word "proven" never
 * appears without its subject.** `"the absence is proven"` is banned outright.
 * A coverage threshold was rejected in principle — an absence is proven of the
 * corpus only at complete coverage, so any threshold below 1.0 creates a cliff
 * where the wording turns confident while the claim is still false. The clause
 * therefore has the same shape at 2.3% and at 100%; only the numbers move.
 *
 * Synthetic ids and counts only. No case data.
 */

import {
  getCorpusDenominator,
  provenAbsenceClause,
  clearCorpusDenominatorCache,
  type CorpusDenominator,
} from '../corpus-denominator';

const den = (over: Partial<CorpusDenominator> = {}): CorpusDenominator => ({
  documentsIndexed: 96,
  documentsTotal: 864,
  indexedChunks: 35890,
  coverage: 0.111,
  scope: 'corpus',
  asOf: '2024-01-01T00:00:00.000Z',
  ...over,
});

function makeContext(database: Record<string, any>): any {
  return {
    vectorStore: {},
    embeddingProvider: {},
    database,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    profile: 'local',
  };
}

describe('provenAbsenceClause — the wording rule', () => {
  const ALL_SHAPES: Array<[string, CorpusDenominator | null]> = [
    ['partial coverage', den()],
    ['complete coverage', den({ documentsIndexed: 864, coverage: 1 })],
    ['chunks unknown', den({ indexedChunks: null })],
    ['single case', den({ scope: 'case', documentsIndexed: 6, documentsTotal: 258, indexedChunks: 380, coverage: 0.023 })],
    ['multi case', den({ scope: 'cases' })],
    ['nothing known', null],
    ['empty scope', den({ documentsTotal: 0, documentsIndexed: 0, coverage: null })],
  ];

  it.each(ALL_SHAPES)('never emits the banned bare form: %s', (_label, d) => {
    const s = provenAbsenceClause(d);
    expect(s).not.toMatch(/the absence is proven/i);
    expect(s).not.toMatch(/not merely unreached/i);
  });

  it.each(ALL_SHAPES)('always attaches a subject to "proven": %s', (_label, d) => {
    // "proven" is only ever followed by what it was proven about.
    expect(provenAbsenceClause(d)).toMatch(/proven absent from|proven from/i);
  });

  it('names both the chunk count and the document denominator at partial coverage', () => {
    const s = provenAbsenceClause(den());
    expect(s).toContain('35,890 indexed chunks');
    expect(s).toContain('96 of 864 documents');
    expect(s).toContain('11.1% indexed');
  });

  it('reads as a corpus-wide proof at complete coverage, with no rule firing', () => {
    const s = provenAbsenceClause(den({ documentsIndexed: 864, coverage: 1 }));
    expect(s).toContain('all 35,890 indexed chunks');
    expect(s).toContain('all 864 documents');
    // No percentage and no "X of Y" — at full coverage those add nothing.
    expect(s).not.toMatch(/\d+ of \d+ documents/);
    expect(s).not.toMatch(/% indexed/);
  });

  it('scopes the noun to what was actually searched', () => {
    expect(provenAbsenceClause(den({ scope: 'corpus' }))).toContain('the corpus');
    expect(provenAbsenceClause(den({ scope: 'case' }))).toContain('this case');
    expect(provenAbsenceClause(den({ scope: 'cases' }))).toContain('these cases');
  });

  it('keeps the document denominator when the chunk count is unknown', () => {
    const s = provenAbsenceClause(den({ indexedChunks: null }));
    expect(s).toContain('96 of 864 documents');
    // The phrase stays, but no chunk NUMBER is invented to fill the gap.
    expect(s).toContain('the indexed chunks of');
    expect(s).not.toMatch(/[\d,]+ indexed chunks/);
  });

  it('reads a missing denominator as a gap, not as an unqualified proof', () => {
    const s = provenAbsenceClause(null);
    expect(s).toMatch(/could not be determined/i);
    // It must not be mistakable for a completeness claim.
    expect(s).not.toMatch(/\ball\b/i);
  });

  it('does not divide by an empty scope', () => {
    const s = provenAbsenceClause(den({ documentsTotal: 0, documentsIndexed: 0, coverage: null }));
    expect(s).not.toMatch(/NaN|Infinity/);
  });

  it('distinguishes a sparse scope from a dense one in the emitted text', () => {
    const sparse = provenAbsenceClause(
      den({ scope: 'case', documentsIndexed: 6, documentsTotal: 258, indexedChunks: 380, coverage: 0.023 }),
    );
    const dense = provenAbsenceClause(
      den({ scope: 'case', documentsIndexed: 24, documentsTotal: 54, indexedChunks: 10719, coverage: 0.444 }),
    );
    expect(sparse).toContain('2.3% indexed');
    expect(dense).toContain('44.4% indexed');
    expect(sparse).not.toEqual(dense);
  });
});

describe('getCorpusDenominator', () => {
  const saved = process.env.LANCEDB_PATH;
  beforeEach(() => {
    clearCorpusDenominatorCache();
    // Force the vector count to fail so these assertions are about the Prisma
    // side only, and are not hostage to whether LanceDB loads under jest.
    process.env.LANCEDB_PATH = '/nonexistent/corpus-denominator-test/lancedb';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LANCEDB_PATH;
    else process.env.LANCEDB_PATH = saved;
  });

  const groups = [
    { status: 'DISCOVERED', _count: { _all: 768 } },
    { status: 'INDEXED', _count: { _all: 96 } },
  ];

  it('counts every observed status toward the denominator, not just the conventional four', async () => {
    const groupBy = jest.fn().mockResolvedValue(groups);
    const d = await getCorpusDenominator(makeContext({ document: { groupBy } }));

    // DISCOVERED is outside QUEUED/PROCESSING/INDEXED/ERROR. Counting only the
    // four would drop 768 of 864 documents from the denominator.
    expect(d!.documentsTotal).toBe(864);
    expect(d!.documentsIndexed).toBe(96);
    expect(d!.coverage).toBe(0.111);
  });

  it('scopes the query when case ids are supplied', async () => {
    const groupBy = jest.fn().mockResolvedValue([{ status: 'INDEXED', _count: { _all: 6 } }]);
    const d = await getCorpusDenominator(makeContext({ document: { groupBy } }), ['case-bbb']);

    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { caseId: { in: ['case-bbb'] } } }));
    expect(d!.scope).toBe('case');
  });

  it('labels a multi-case scope distinctly from a single one', async () => {
    const groupBy = jest.fn().mockResolvedValue(groups);
    const d = await getCorpusDenominator(makeContext({ document: { groupBy } }), ['a', 'b']);
    expect(d!.scope).toBe('cases');
  });

  it('returns null rather than throwing when the database is unavailable', async () => {
    const groupBy = jest.fn().mockRejectedValue(new Error('db down'));
    const d = await getCorpusDenominator(makeContext({ document: { groupBy } }));

    expect(d).toBeNull();
    // And the clause still refuses to make an unqualified claim.
    expect(provenAbsenceClause(d)).toMatch(/could not be determined/i);
  });

  it('caches within the paging window so a scan does not re-read per page', async () => {
    const groupBy = jest.fn().mockResolvedValue(groups);
    const ctx = makeContext({ document: { groupBy } });

    await getCorpusDenominator(ctx);
    await getCorpusDenominator(ctx);
    await getCorpusDenominator(ctx);

    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('caches per scope, so a scoped scan never inherits the corpus figure', async () => {
    const groupBy = jest
      .fn()
      .mockResolvedValueOnce(groups)
      .mockResolvedValueOnce([{ status: 'INDEXED', _count: { _all: 6 } }]);
    const ctx = makeContext({ document: { groupBy } });

    const corpus = await getCorpusDenominator(ctx);
    const scoped = await getCorpusDenominator(ctx, ['case-bbb']);

    expect(corpus!.documentsTotal).toBe(864);
    expect(scoped!.documentsTotal).toBe(6);
    expect(groupBy).toHaveBeenCalledTimes(2);
  });

  it('reports chunks as null, never 0, when the vector table cannot be read', async () => {
    const groupBy = jest.fn().mockResolvedValue(groups);
    const d = await getCorpusDenominator(makeContext({ document: { groupBy } }));

    expect(d!.indexedChunks).toBeNull();
    expect(d!.indexedChunks).not.toBe(0);
  });
});
