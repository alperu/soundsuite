/** @jest-environment node */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../db/prisma', () => ({
  prisma: {
    actionLog: { create: jest.fn().mockResolvedValue({ id: 'log-1' }) },
    searchPreset: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  },
}));
jest.mock('../../tools/ai-helper', () => ({
  DEFAULT_MODELS: { ollama: 'qwen2.5:14b', groq: 'g', openai: 'gpt-5.6-terra', anthropic: 'claude-sonnet-5', gemini: 'gm', grok: 'grok-4.5' },
  getAvailableProvider: jest.fn(),
}));
jest.mock('../../routing-defaults', () => ({
  getDefaultRoutingInfo: jest.fn().mockResolvedValue({ routing: {}, source: 'code:ollama-only', notes: [] }),
  getDefaultRouting: jest.fn().mockResolvedValue({
    fast: { provider: 'ollama', model: 'qwen2.5:14b' },
    deep: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true },
    'deep-report': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true, multiPass: true },
    'deep-rlm': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true, useRlm: true, rlmMaxRounds: 4 },
  }),
}));
jest.mock('../../../search/deep-search', () => ({ deepSearch: jest.fn() }));

import { deepSearch, type DeepSearchOptions, type DeepSearchResult } from '../../../search/deep-search';
import { prisma } from '../../../db/prisma';
import { runReport, planReport } from '../run-report';
import { _resetForTests, defineTemp, setActive } from '../../presets/preset-session';
import type { ToolRegistry } from '../../tool-registry';

const mockedDeepSearch = deepSearch as jest.MockedFunction<typeof deepSearch>;
const createLog = (prisma as unknown as { actionLog: { create: jest.Mock } }).actionLog.create;
const registry = {} as ToolRegistry;
const flush = () => new Promise<void>((r) => setImmediate(r));

const QUERY = 'what did the witness say about the fence line';

function source(documentId: string, page: number, text: string) {
  return {
    documentId,
    document: 'motion.pdf',
    page,
    text,
    score: 0.9,
    matchedSubQueries: ['q1'],
  } as unknown as DeepSearchResult['sources'][number];
}

function fakeResult(overrides: Partial<DeepSearchResult> = {}): DeepSearchResult {
  return {
    report: '## Findings\n\nSynthetic report body.',
    sources: [
      source('doc-A', 3, 'synthetic passage one'),
      source('doc-A', 4, 'synthetic passage two'),
      source('doc-B', 1, 'synthetic passage three'),
    ],
    subQueries: ['q1', 'q2'],
    intent: 'synthetic',
    searchStats: { totalRetrieved: 30, uniqueAfterDedup: 20, finalAfterRerank: 3, subQueryCount: 2 },
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    ...overrides,
  };
}

beforeEach(() => {
  mockedDeepSearch.mockReset();
  createLog.mockClear();
  _resetForTests();
});

describe('runReport', () => {
  it('builds a ReportResult with deduped provenance and streams tokens', async () => {
    mockedDeepSearch.mockImplementation(async (_q, _r, opts: DeepSearchOptions = {}) => {
      opts.onProgress?.({ step: 'decomposing', message: 'decomposing' });
      opts.onProgress?.({ step: 'generating', message: 'generating' });
      opts.onToken?.('## Find');
      opts.onToken?.('ings');
      return fakeResult();
    });

    const tokens: string[] = [];
    const phases: string[] = [];
    const result = await runReport(QUERY, registry, {
      profile: 'routed',
      sessionId: 'sess-1',
      mode: 'deep',
      onToken: (t) => tokens.push(t),
      onProgress: (p) => phases.push(p.phase),
    });

    expect(tokens).toEqual(['## Find', 'ings']);
    expect(phases).toEqual(['decomposing', 'generating']);

    expect(result.profile).toBe('routed');
    expect(result.query).toBe(QUERY);
    expect(result.report).toContain('Synthetic report body');
    expect(result.routing).toMatchObject({
      requested: 'deep', mode: 'deep', reason: 'explicit', confidence: 1,
      resolved: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true },
    });
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence[0]).toMatchObject({ documentId: 'doc-A', source: 'retrieval', hits: 1 });
    expect(result.subQueries).toEqual(['q1', 'q2']);
    expect(result.stats).toMatchObject({ retrievals: 30, chunksFused: 20, rerankPool: 3 });
    expect(result.stats.phases).toHaveProperty('decomposing');
    expect(result.cost).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', estimated: true });
    expect(result.cost.inputTokens).toBeGreaterThan(0);
    expect(result.cost.outputTokens).toBeGreaterThan(0);
    expect(result.provenance).toEqual({ documentIdsSent: ['doc-A', 'doc-B'], provider: 'anthropic' });
    expect(result.modelsUsed).toEqual({
      decompose: 'claude-sonnet-5', rerank: 'n/a', rlm: 'n/a', outline: 'n/a', synthesis: 'claude-sonnet-5',
    });

    // deepSearch received the resolved tier settings
    const passed = mockedDeepSearch.mock.calls[0][2]!;
    expect(passed).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true });
    expect(passed.multiPass).toBeUndefined();
  });

  it('writes a provenance row with ids and counts but no query or document text', async () => {
    mockedDeepSearch.mockResolvedValue(fakeResult());
    await runReport(QUERY, registry, { profile: 'routed', sessionId: 'sess-2', mode: 'fast', caseId: 'case-1' });
    await flush();

    expect(createLog).toHaveBeenCalledTimes(1);
    const data = createLog.mock.calls[0][0].data;
    expect(data).toMatchObject({ action: 'mcp-routed-call', logType: 'mcp-routed', status: 'completed', caseId: 'case-1', target: 'anthropic/claude-sonnet-5' });
    const detail = JSON.parse(data.detail);
    expect(detail).toMatchObject({ tier: 'fast', provider: 'anthropic', model: 'claude-sonnet-5', documentIdsSent: ['doc-A', 'doc-B'], documentCount: 2, sessionId: 'sess-2', tokensEstimated: true });
    expect(typeof detail.ms).toBe('number');
    expect(data.detail).not.toContain('fence line');
    expect(data.detail).not.toContain('synthetic passage');
    expect(data.detail).not.toContain('Synthetic report');
  });

  it('honours includeEvidence:false while keeping provenance', async () => {
    mockedDeepSearch.mockResolvedValue(fakeResult());
    const result = await runReport(QUERY, registry, { profile: 'routed', mode: 'fast', includeEvidence: false });
    expect(result.evidence).toEqual([]);
    expect(result.provenance.documentIdsSent).toEqual(['doc-A', 'doc-B']);
  });

  it('applies the session-active temp preset and reports presetUsed', async () => {
    mockedDeepSearch.mockResolvedValue(fakeResult({ model: 'claude-opus-5' }));
    const handle = defineTemp({ version: 2, name: 'opus-deep', routing: { deep: { provider: 'anthropic', model: 'claude-opus-5', effort: 'high' } } });
    await setActive('sess-3', handle);

    const plan = await planReport(QUERY, { sessionId: 'sess-3', mode: 'deep' });
    expect(plan.presetUsed).toBe('opus-deep');
    expect(plan.resolved).toMatchObject({ model: 'claude-opus-5', effort: 'high', thinking: true });

    const result = await runReport(QUERY, registry, { profile: 'routed', sessionId: 'sess-3', mode: 'deep' });
    expect(result.routing.presetUsed).toBe('opus-deep');
    expect(mockedDeepSearch.mock.calls[0][2]).toMatchObject({ model: 'claude-opus-5', effort: 'high' });
  });

  it('refuses a non-routed profile and an empty query', async () => {
    await expect(runReport(QUERY, registry, { profile: 'local' as never })).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    await expect(runReport('   ', registry, { profile: 'routed' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(mockedDeepSearch).not.toHaveBeenCalled();
  });

  it('records an error row and rethrows when the pipeline fails', async () => {
    mockedDeepSearch.mockRejectedValue(new Error('provider down'));
    await expect(runReport(QUERY, registry, { profile: 'routed', mode: 'fast' })).rejects.toThrow('provider down');
    await flush();
    expect(createLog.mock.calls[0][0].data.status).toBe('error');
  });
});
