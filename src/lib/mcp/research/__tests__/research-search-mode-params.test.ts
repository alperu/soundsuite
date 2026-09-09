/** @jest-environment node */
/**
 * `searchMode` / `recordStatus` on `research_evidence` (docs/tasks/30 Part 1).
 *
 * They must be HONOURED, not steered-and-ignored, and they must reject a bad
 * value rather than silently defaulting — a knob that quietly had no effect is
 * the defect class this repo keeps hitting. They also must not ride
 * `retrieval`, whose parser coerces every key with `positiveInt` and would
 * drop an enum string without a word.
 *
 * Synthetic fixtures only; the preset lookup is mocked.
 */

const findFirstMock = jest.fn();
jest.mock('../../../db/prisma', () => ({ prisma: { searchPreset: { findFirst: (...a: unknown[]) => findFirstMock(...a) } } }));

import { parseResearchParams, parseRetrievalSettings } from '../research-params';

beforeEach(() => {
  jest.clearAllMocks();
  findFirstMock.mockResolvedValue(null);
});

const base = { query: 'mediation' };

describe('searchMode / recordStatus are honoured top-level params', () => {
  it('carries both into options', async () => {
    const { options } = await parseResearchParams({ ...base, searchMode: 'keyword', recordStatus: 'filed' });
    expect(options.searchMode).toBe('keyword');
    expect(options.recordStatus).toBe('filed');
  });

  it.each(['vector', 'hybrid', 'keyword'])('accepts searchMode "%s"', async (mode) => {
    const { options } = await parseResearchParams({ ...base, searchMode: mode });
    expect(options.searchMode).toBe(mode);
  });

  it.each(['filed', 'draft', 'any'])('accepts recordStatus "%s"', async (status) => {
    const { options } = await parseResearchParams({ ...base, recordStatus: status });
    expect(options.recordStatus).toBe(status);
  });

  it('does NOT report them as ignored — they are not steering keys', async () => {
    const { ignored } = await parseResearchParams({ ...base, searchMode: 'keyword', recordStatus: 'filed' });
    expect(ignored).not.toContain('searchMode');
    expect(ignored).not.toContain('recordStatus');
  });

  it('omits both when the caller does not send them', async () => {
    const { options } = await parseResearchParams(base);
    expect(options).not.toHaveProperty('searchMode');
    expect(options).not.toHaveProperty('recordStatus');
  });
});

describe('bad values are rejected, not silently defaulted', () => {
  it('rejects an unknown searchMode naming the field and the allowed set', async () => {
    await expect(parseResearchParams({ ...base, searchMode: 'semantic' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(parseResearchParams({ ...base, searchMode: 'semantic' })).rejects.toThrow(/searchMode must be one of/);
  });

  it('rejects an unknown recordStatus', async () => {
    await expect(parseResearchParams({ ...base, recordStatus: 'pending' })).rejects.toThrow(
      /recordStatus must be one of/,
    );
  });

  it('rejects a non-string value rather than coercing it', async () => {
    await expect(parseResearchParams({ ...base, searchMode: 1 })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});

describe('they do not ride the retrieval object', () => {
  it('parseRetrievalSettings drops them — which is why they are top-level', () => {
    // `positiveInt` over every RETRIEVAL_KEY would swallow an enum string with
    // no error at all. This asserts the reason for the placement decision.
    expect(parseRetrievalSettings({ searchMode: 'keyword', recordStatus: 'filed' } as any)).toBeUndefined();
  });
});
