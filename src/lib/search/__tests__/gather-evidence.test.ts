/** @jest-environment node */

/**
 * Local evidence engine (docs/tasks/06-mcp-two-profiles.md, item 2).
 * Every pipeline stage is mocked; fixtures are synthetic.
 */

const decomposeQueryMock = jest.fn();
const buildChipSpecsMock = jest.fn();
const executeParallelSearchesMock = jest.fn();
const executePatternSearchMock = jest.fn();
const executePerChipPatternSearchesMock = jest.fn();
const deduplicateAndMergeMock = jest.fn();
const runRlmEvidenceRoundsMock = jest.fn();

jest.mock('../deep-search', () => ({
  decomposeQuery: (...a: unknown[]) => decomposeQueryMock(...a),
  buildChipSpecs: (...a: unknown[]) => buildChipSpecsMock(...a),
  executeParallelSearches: (...a: unknown[]) => executeParallelSearchesMock(...a),
  executePatternSearch: (...a: unknown[]) => executePatternSearchMock(...a),
  executePerChipPatternSearches: (...a: unknown[]) => executePerChipPatternSearchesMock(...a),
  deduplicateAndMerge: (...a: unknown[]) => deduplicateAndMergeMock(...a),
  runRlmEvidenceRounds: (...a: unknown[]) => runRlmEvidenceRoundsMock(...a),
  buildRlmInheritedWhereClauses: () => undefined,
}));

const buildEvidenceOutlineMock = jest.fn();
jest.mock('../evidence-outline', () => ({
  buildEvidenceOutline: (...a: unknown[]) => buildEvidenceOutlineMock(...a),
}));

jest.mock('../../db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({ ollamaCompletionModel: 'test-local-model', rerankModel: 'test-reranker' }),
}));

jest.mock('../../mcp/tools/ai-helper', () => ({
  DEFAULT_MODELS: { ollama: 'default-ollama' },
  getAvailableProvider: jest.fn().mockResolvedValue({ provider: 'ollama', model: 'auto-model' }),
}));

jest.mock('../../ai/stream-rlm', () => ({ RLM_MODEL_ID: 'test-rlm' }));

jest.mock('../../mcp/routing-defaults', () => ({
  LOCAL_ROUTING: {
    fast: { provider: 'ollama' },
    deep: { provider: 'ollama' },
    'deep-report': { provider: 'ollama', multiPass: true },
    'deep-rlm': { provider: 'ollama', useRlm: true, rlmMaxRounds: 2 },
  },
}));

import { gatherEvidence, resolveResearchMode } from '../gather-evidence';
import type { DeepSearchSource } from '../deep-search';
import type { EvidenceItem } from '../../mcp/research-types';

const registry = {} as any;

function src(text: string, page = 1, extra: Partial<DeepSearchSource> = {}): DeepSearchSource {
  return {
    text,
    document: 'motion.pdf',
    page,
    score: 0.5,
    documentId: 'doc-1',
    matchedSubQueries: ['sub'],
    ...extra,
  };
}

const A = src('synthetic passage about a scheduling order', 3);
const B = src('synthetic passage about a continuance request', 7);
const C = src('synthetic passage about a fee affidavit', 9);

function setupHappyPath() {
  buildChipSpecsMock.mockReturnValue(null);
  decomposeQueryMock.mockResolvedValue({ subQueries: ['q', 'sub one', 'sub two'], intent: 'i' });
  executeParallelSearchesMock.mockResolvedValue([{ subQuery: 'q', sources: [A, B] }]);
  executePatternSearchMock.mockResolvedValue({ subQuery: '[pattern search]', sources: [] });
  deduplicateAndMergeMock.mockImplementation(async (results: Array<{ sources: DeepSearchSource[] }>) => {
    const sources = results.flatMap((r) => r.sources).map((s) => ({ ...s }));
    return { sources, stats: { totalRetrieved: sources.length, uniqueAfterDedup: sources.length, finalAfterRerank: sources.length, rerankPool: sources.length } };
  });
  runRlmEvidenceRoundsMock.mockImplementation(async (_q: string, _d: unknown, _s: unknown, _r: unknown, opts: any) => {
    // Round 1 rediscovers A (duplicate) and finds C (new).
    opts.onRound?.({ round: 1, sources: [{ ...A, matchedSubQueries: ['[rlm] x'] }, C], note: 'rlm round 1: query_case_knowledge("x") → 2 excerpts', toolCalls: 1 });
    return { finalText: 'done', extraSources: [C], roundOf: [1], host: 'sidecar', model: 'test-rlm', rounds: 1, toolCalls: 1, notes: ['rlm round 1: …'] };
  });
  buildEvidenceOutlineMock.mockResolvedValue({ sections: [], gaps: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupHappyPath();
});

describe('resolveResearchMode', () => {
  it('honours an explicit tier and routes auto through the query router', () => {
    expect(resolveResearchMode('anything', 'fast')).toMatchObject({ requested: 'fast', mode: 'fast', confidence: 1 });
    const auto = resolveResearchMode('compare the scheduling order versus the continuance across all filings');
    expect(auto.requested).toBe('auto');
    expect(['fast', 'deep', 'deep-report', 'deep-rlm']).toContain(auto.mode);
    expect(auto.reason).toBeTruthy();
  });
});

describe('gatherEvidence', () => {
  it('(a) fast mode skips decomposition and the outline', async () => {
    const r = await gatherEvidence('when was the hearing', registry, { profile: 'local', localOnly: true, mode: 'fast' });
    expect(decomposeQueryMock).not.toHaveBeenCalled();
    expect(buildEvidenceOutlineMock).not.toHaveBeenCalled();
    expect(r.subQueries).toEqual(['when was the hearing']);
    expect(r.outline).toBeUndefined();
    expect(r.routing).toMatchObject({ requested: 'fast', mode: 'fast' });
    expect(r.modelsUsed).toMatchObject({ decompose: 'none', rerank: 'test-reranker', rlm: 'none', outline: 'none' });
    expect(r.profile).toBe('local');
    expect(r.localOnly).toBe(true);
    expect(r.evidence).toHaveLength(2);
  });

  it('(b) evidence ids are stable across runs and deduped across RLM rounds', async () => {
    const opts = { profile: 'local' as const, localOnly: true, mode: 'deep-rlm' as const };
    const r1 = await gatherEvidence('q', registry, opts);
    const r2 = await gatherEvidence('q', registry, opts);
    const ids1 = r1.evidence.map((e) => e.id);
    expect(new Set(ids1).size).toBe(ids1.length);
    expect(ids1).toEqual(r2.evidence.map((e) => e.id));
    // A was found twice (initial + RLM), C only by RLM → 3 items, C tagged with its round.
    expect(r1.evidence).toHaveLength(3);
    const c = r1.evidence.find((e) => e.text === C.text)!;
    expect(c.source).toBe('rlm-round-1');
    expect(c.rlmNote).toContain('rlm round 1');
    expect(r1.evidence.filter((e) => e.source === 'retrieval')).toHaveLength(2);
    expect(r1.rlm).toEqual({ rounds: 1, toolCalls: 1, notes: ['rlm round 1: …'] });
    expect(r1.modelsUsed.rlm).toBe('test-rlm');
  });

  it('(c) onEvidence fires incrementally: after rerank and once per RLM round', async () => {
    const batches: EvidenceItem[][] = [];
    const phases: string[] = [];
    await gatherEvidence('q', registry, {
      profile: 'local', localOnly: true, mode: 'deep-rlm',
      onEvidence: (items) => batches.push(items),
      onProgress: (p) => phases.push(p.phase),
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(2);
    expect(batches[1]).toHaveLength(1);
    expect(batches[1][0].source).toBe('rlm-round-1');
    for (const ph of ['routing', 'decompose', 'retrieve', 'pattern', 'fuse', 'rerank', 'rlm', 'outline']) {
      expect(phases).toContain(ph);
    }
  });

  it('(d) localOnly refuses a cloud provider before any retrieval runs', async () => {
    await expect(
      gatherEvidence('q', registry, { profile: 'local', localOnly: true, provider: 'anthropic', model: 'claude-x' }),
    ).rejects.toMatchObject({ code: 'POLICY_VIOLATION' });
    expect(executeParallelSearchesMock).not.toHaveBeenCalled();
    expect(decomposeQueryMock).not.toHaveBeenCalled();
  });

  it('(d′) localOnly pins decompose and outline to Ollama with a concrete model', async () => {
    await gatherEvidence('q', registry, { profile: 'local', localOnly: true, mode: 'deep' });
    expect(decomposeQueryMock).toHaveBeenCalledWith('q', expect.objectContaining({ provider: 'ollama', model: 'test-local-model' }));
    expect(buildEvidenceOutlineMock).toHaveBeenCalledWith(
      'q', ['q', 'sub one', 'sub two'], expect.any(Array),
      expect.objectContaining({ provider: 'ollama', model: 'test-local-model', profile: 'local' }),
    );
  });

  it('(e) reports the fields the local profile ignored', async () => {
    const r = await gatherEvidence('q', registry, { profile: 'local', localOnly: true, mode: 'deep', ignored: ['provider', 'preset.routing'] });
    expect(r.routing.ignored).toEqual(['provider', 'preset.routing']);
    const r2 = await gatherEvidence('q', registry, { profile: 'local', localOnly: true, mode: 'deep' });
    expect(r2.routing.ignored).toBeUndefined();
  });

  it('(f) an abort signal stops the pipeline between phases', async () => {
    const controller = new AbortController();
    executeParallelSearchesMock.mockImplementation(async () => {
      controller.abort();
      return [{ subQuery: 'q', sources: [A] }];
    });
    await expect(
      gatherEvidence('q', registry, { profile: 'local', localOnly: true, mode: 'deep', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(executePatternSearchMock).not.toHaveBeenCalled();
    expect(deduplicateAndMergeMock).not.toHaveBeenCalled();
  });

  it('(g) deep-rlm defaults to 2 RLM rounds and honours the retrieval override', async () => {
    await gatherEvidence('q', registry, { profile: 'local', localOnly: true, mode: 'deep-rlm' });
    expect(runRlmEvidenceRoundsMock).toHaveBeenLastCalledWith('q', expect.anything(), expect.any(Array), registry, expect.objectContaining({ maxRounds: 2 }));
    await gatherEvidence('q', registry, { profile: 'local', localOnly: true, mode: 'deep-rlm', retrieval: { rlmMaxRounds: 5 } });
    expect(runRlmEvidenceRoundsMock).toHaveBeenLastCalledWith('q', expect.anything(), expect.any(Array), registry, expect.objectContaining({ maxRounds: 5 }));
  });

  it('honours limitPerSubQuery, rerankPoolSize and maxEvidence', async () => {
    const r = await gatherEvidence('q', registry, {
      profile: 'local', localOnly: true, mode: 'deep',
      retrieval: { limitPerSubQuery: 7, rerankPoolSize: 40, maxEvidence: 1 },
    });
    expect(executeParallelSearchesMock).toHaveBeenCalledWith(expect.anything(), undefined, registry, expect.any(Function), undefined, 7);
    expect(deduplicateAndMergeMock).toHaveBeenCalledWith(expect.anything(), 'q', expect.any(Function), { rerankPoolSize: 40 });
    expect(r.evidence).toHaveLength(1);
    expect(r.stats.rerankPool).toBe(2);
    expect(r.stats.chunksFused).toBe(2);
    expect(typeof r.stats.phases.retrieve).toBe('number');
  });

  it('degrades to reranked evidence when the RLM sidecar is unavailable', async () => {
    runRlmEvidenceRoundsMock.mockRejectedValue(new Error('No sidecar with ss-rlm running'));
    const r = await gatherEvidence('q', registry, { profile: 'local', localOnly: true, mode: 'deep-rlm' });
    expect(r.evidence).toHaveLength(2);
    expect(r.rlm).toMatchObject({ rounds: 0, toolCalls: 0 });
    expect(r.rlm!.notes[0]).toContain('rlm unavailable');
    expect(r.modelsUsed.rlm).toBe('none');
  });
});
