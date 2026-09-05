/** @jest-environment node */

/**
 * `parseResearchParams` — the local profile's request contract (REPORT-v4
 * N-2): retrieval knobs accepted at the top level as well as under
 * `retrieval`, steering fields ignored-and-reported, everything else rejected.
 * Synthetic fixtures only; the preset lookup is mocked.
 */

const findFirstMock = jest.fn();
jest.mock('../../../db/prisma', () => ({ prisma: { searchPreset: { findFirst: (...a: unknown[]) => findFirstMock(...a) } } }));

import { parseResearchParams, parseRetrievalSettings } from '../research-params';

beforeEach(() => {
  jest.clearAllMocks();
  findFirstMock.mockResolvedValue(null);
});

describe('parseRetrievalSettings', () => {
  it('accepts the v3 timeout knobs and the new chunk cap', () => {
    expect(parseRetrievalSettings({
      rerankPoolSize: 40, limitPerSubQuery: 7, rlmMaxRounds: 3,
      maxEvidence: 10, maxCharsPerChunk: 500,
      decomposeTimeoutMs: 20_000, outlineTimeoutMs: 25_000,
    })).toEqual({
      rerankPoolSize: 40, limitPerSubQuery: 7, rlmMaxRounds: 3,
      maxEvidence: 10, maxCharsPerChunk: 500,
      decomposeTimeoutMs: 20_000, outlineTimeoutMs: 25_000,
    });
  });

  it('drops non-positive and non-numeric values', () => {
    expect(parseRetrievalSettings({ maxEvidence: 0, maxCharsPerChunk: '900', outlineTimeoutMs: -1 })).toBeUndefined();
  });
});

describe('parseResearchParams', () => {
  it('accepts maxEvidence / maxCharsPerChunk at the top level', async () => {
    const { options } = await parseResearchParams({ maxEvidence: 12, maxCharsPerChunk: 600 });
    expect(options.retrieval).toEqual({ maxEvidence: 12, maxCharsPerChunk: 600 });
  });

  it('lets a top-level knob win over the same knob under retrieval', async () => {
    const { options } = await parseResearchParams({ maxEvidence: 12, retrieval: { maxEvidence: 80, limitPerSubQuery: 7 } });
    expect(options.retrieval).toEqual({ maxEvidence: 12, limitPerSubQuery: 7 });
  });

  it('still ignores (not rejects) steering fields and reports them', async () => {
    const { options, ignored } = await parseResearchParams({ provider: 'anthropic', model: 'claude-x', thinking: true, mode: 'deep' });
    expect(ignored).toEqual(['provider', 'model', 'thinking']);
    expect(options.mode).toBe('deep');
  });

  it('rejects an unknown top-level key, naming it', async () => {
    await expect(parseResearchParams({ maxResults: 10 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringContaining('"maxResults"'),
    });
  });

  it('tells the caller where a misplaced retrieval knob belongs', async () => {
    await expect(parseResearchParams({ rerankPoolSize: 40 })).rejects.toMatchObject({
      message: expect.stringContaining('put it under "retrieval"'),
    });
  });

  it('suggests the right spelling for a case-typo', async () => {
    await expect(parseResearchParams({ CaseId: 'case-1' })).rejects.toMatchObject({
      message: expect.stringContaining('did you mean "caseId"?'),
    });
  });

  it('accepts the full documented surface without complaint', async () => {
    const { options, ignored } = await parseResearchParams({
      query: 'what did the order require',
      profile: 'local',
      caseId: 'case-1',
      mode: 'fast',
      whereClauses: ["filing_type = 'motion'"],
      history: [{ role: 'user', content: 'earlier turn' }],
      retrieval: { maxEvidence: 5 },
      maxCharsPerChunk: 400,
    });
    expect(ignored).toEqual([]);
    expect(options).toMatchObject({
      caseId: 'case-1',
      mode: 'fast',
      whereClauses: ["filing_type = 'motion'"],
      retrieval: { maxEvidence: 5, maxCharsPerChunk: 400 },
    });
  });

  it('an undefined-valued unknown key is not an error', async () => {
    const { ignored } = await parseResearchParams({ somethingElse: undefined });
    expect(ignored).toEqual([]);
  });

  it('takes the retrieval section of an inline preset, top level still winning', async () => {
    const { options, ignored } = await parseResearchParams({
      preset: { retrieval: { maxEvidence: 80, rerankPoolSize: 40 }, provider: 'openai' },
      maxEvidence: 15,
    });
    expect(ignored).toEqual(['preset.provider']);
    expect(options.retrieval).toEqual({ maxEvidence: 15, rerankPoolSize: 40 });
  });
});
