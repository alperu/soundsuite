/** @jest-environment node */

/**
 * `research_*` tools over the real job store; the evidence engine and the
 * registry are mocked. Synthetic data only.
 */

const gatherEvidenceMock = jest.fn();
const resolveResearchModeMock = jest.fn();
jest.mock('../../search/gather-evidence', () => ({
  gatherEvidence: (...a: unknown[]) => gatherEvidenceMock(...a),
  resolveResearchMode: (...a: unknown[]) => resolveResearchModeMock(...a),
}));

const fakeRegistry = { execute: jest.fn() };
jest.mock('../get-tool-registry', () => ({
  getToolRegistry: jest.fn().mockResolvedValue(fakeRegistry),
}));

const ollamaAvailableMock = jest.fn().mockResolvedValue(true);
jest.mock('../shared-dependencies', () => ({
  ollamaAvailable: (...a: unknown[]) => ollamaAvailableMock(...a),
}));

import { getResearchTools } from '../tools/research-tools';
import { _resetJobsForTests } from '../research-jobs';
import type { ToolExecutionContext, ToolConfigEntry } from '../tool-types';
import type { EvidenceItem, EvidenceResult, GatherEvidenceOptions } from '../research-types';

const tools = Object.fromEntries(getResearchTools().map((t) => [t.getMetadata().name, t]));
const context = {
  profile: 'local',
  sessionId: 'session-1',
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
} as unknown as ToolExecutionContext;
const config: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

const flush = () => new Promise<void>((r) => setImmediate(r));

function item(i: number): EvidenceItem {
  return { id: `ev_${i}`, documentId: 'doc-1', text: `synthetic passage ${i}`, score: 0.9 - i / 100, hits: 1, source: 'retrieval' };
}

function evidenceResult(query: string, evidence: EvidenceItem[]): EvidenceResult {
  return {
    query,
    routing: { requested: 'deep', mode: 'deep', reason: 'requested', confidence: 1 },
    subQueries: [query],
    evidence,
    outline: { sections: [{ title: 'T', evidenceIds: evidence.map((e) => e.id) }], gaps: [] },
    stats: { retrievals: evidence.length, chunksFused: evidence.length, rerankPool: evidence.length, ms: 1, phases: {} },
    profile: 'local',
    localOnly: true,
    modelsUsed: { decompose: 'ollama/m', rerank: 'r', rlm: 'none', outline: 'ollama/m' },
  };
}

/** A gatherEvidence whose evidence delivery and completion are driven by the test. */
function controlledGather() {
  let opts!: GatherEvidenceOptions;
  let finish!: (r: EvidenceResult) => void;
  let fail!: (e: unknown) => void;
  let ready!: () => void;
  const started = new Promise<void>((r) => { ready = r; });
  gatherEvidenceMock.mockImplementation((_q: string, _reg: unknown, o: GatherEvidenceOptions) => {
    opts = o;
    ready();
    return new Promise<EvidenceResult>((res, rej) => { finish = res; fail = rej; });
  });
  return { started, opts: () => opts, finish: (r: EvidenceResult) => finish(r), fail: (e: unknown) => fail(e) };
}

beforeEach(() => {
  jest.clearAllMocks();
  ollamaAvailableMock.mockResolvedValue(true);
  resolveResearchModeMock.mockImplementation((q: string, mode?: string) => ({
    requested: mode ?? 'auto', mode: mode && mode !== 'auto' ? mode : 'deep', reason: 'test', confidence: 1,
  }));
});
afterEach(() => _resetJobsForTests());

describe('tool set', () => {
  it('exposes the five research tools to both profiles with the local LLM dependency on the starters', () => {
    expect(Object.keys(tools).sort()).toEqual(['research_cancel', 'research_evidence', 'research_result', 'research_start', 'research_status']);
    for (const t of Object.values(tools)) {
      expect(t.getMetadata().profiles).toEqual(['local', 'routed']);
      expect(t.getMetadata().category).toBe('search');
    }
    expect(tools.research_evidence.getDependencies().map((d) => d.key)).toEqual(['localLlm']);
    expect(tools.research_start.getDependencies().map((d) => d.key)).toEqual(['localLlm']);
    expect(tools.research_status.getDependencies()).toEqual([]);
    expect(tools.research_evidence.getMetadata().description).toMatch(/never writes a report/i);
  });
});

describe('research_evidence', () => {
  it('runs synchronously for non-RLM tiers, local-only, reporting ignored steering fields', async () => {
    gatherEvidenceMock.mockImplementation(async (q: string, _r: unknown, o: GatherEvidenceOptions & { ignored?: string[] }) =>
      ({ ...evidenceResult(q, [item(0)]), routing: { requested: 'deep', mode: 'deep', reason: 'r', confidence: 1, ignored: o.ignored } }));
    const res = await tools.research_evidence.execute(
      { query: 'what did the order say', mode: 'deep', provider: 'anthropic', preset: { routing: { deep: {} }, retrieval: { maxEvidence: 5 } } },
      context, config,
    );
    expect(res.success).toBe(true);
    expect(res.data.evidence).toHaveLength(1);
    expect(res.data.routing.ignored).toEqual(['provider', 'preset.routing']);
    const [, registry, opts] = gatherEvidenceMock.mock.calls[0];
    expect(registry).toBe(fakeRegistry);
    expect(opts).toMatchObject({ localOnly: true, profile: 'local', mode: 'deep', retrieval: { maxEvidence: 5 }, sessionId: 'session-1' });
    expect(opts.provider).toBeUndefined();
  });

  it('promotes deep-rlm to a job', async () => {
    const g = controlledGather();
    const res = await tools.research_evidence.execute({ query: 'trace how the motion evolved', mode: 'deep-rlm' }, context, config);
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ promoted: true, kind: 'research', status: 'queued' });
    expect(res.data.hint).toMatch(/research_status/);
    await g.started;
    expect(g.opts()).toMatchObject({ localOnly: true, mode: 'deep-rlm' });
    const status = await tools.research_status.execute({ jobId: res.data.jobId }, context, config);
    expect(status.data.status).toBe('running');
    g.finish(evidenceResult('trace how the motion evolved', []));
  });

  it('rejects an empty query and an unknown mode', async () => {
    const a = await tools.research_evidence.execute({ query: '  ' } as any, context, config);
    expect(a).toMatchObject({ success: false, errorCode: 'INVALID_PARAMS' });
    const b = await tools.research_evidence.execute({ query: 'q', mode: 'turbo' }, context, config);
    expect(b).toMatchObject({ success: false, errorCode: 'INVALID_PARAMS' });
    expect(gatherEvidenceMock).not.toHaveBeenCalled();
  });
});

describe('research_start / research_status / research_result', () => {
  it('delivers evidence with a monotonic cursor across two polls, then the result', async () => {
    const g = controlledGather();
    const start = await tools.research_start.execute({ query: 'q' }, context, config);
    expect(start.success).toBe(true);
    expect(start.data).toMatchObject({ kind: 'research', status: 'queued' });
    const jobId = start.data.jobId as string;
    await g.started;

    g.opts().onProgress?.({ phase: 'rerank', message: 'rerank 10 → 4' });
    g.opts().onEvidence?.([item(0), item(1)]);
    const s1 = await tools.research_status.execute({ jobId }, context, config);
    expect(s1.data).toMatchObject({ status: 'running', phase: 'rerank', cursor: 2, newEvidenceCount: 2 });

    const running = await tools.research_result.execute({ jobId }, context, config);
    expect(running).toMatchObject({ success: false, errorCode: 'JOB_RUNNING' });

    g.opts().onEvidence?.([item(2)]);
    const s2 = await tools.research_status.execute({ jobId, cursor: s1.data.cursor }, context, config);
    expect(s2.data.cursor).toBe(3);
    expect(s2.data.evidence.map((e: EvidenceItem) => e.id)).toEqual(['ev_2']);
    expect(s2.data.cursor).toBeGreaterThan(s1.data.cursor);

    const final = evidenceResult('q', [item(0), item(1), item(2)]);
    final.rlm = { rounds: 1, toolCalls: 2, notes: ['rlm round 1: query_case_knowledge("x") → 3 excerpts'] };
    g.finish(final);
    await flush();

    const s3 = await tools.research_status.execute({ jobId, cursor: 3 }, context, config);
    expect(s3.data).toMatchObject({ status: 'done', cursor: 3, newEvidenceCount: 0 });
    expect(s3.data.outline).toEqual(final.outline);
    expect(s3.data.rlmNotes).toEqual(final.rlm.notes);
    expect(s3.data.partialReport).toBeUndefined();

    const result = await tools.research_result.execute({ jobId }, context, config);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(final);
  });

  it('reports unknown jobs and failed jobs distinctly', async () => {
    const nf = await tools.research_status.execute({ jobId: 'nope' }, context, config);
    expect(nf).toMatchObject({ success: false, errorCode: 'JOB_NOT_FOUND' });

    const g = controlledGather();
    const start = await tools.research_start.execute({ query: 'q' }, context, config);
    await g.started;
    g.fail(new Error('reranker exploded'));
    await flush();
    const res = await tools.research_result.execute({ jobId: start.data.jobId }, context, config);
    expect(res).toMatchObject({ success: false, errorCode: 'JOB_FAILED' });
    expect(res.error).toContain('reranker exploded');
  });
});

describe('research_cancel', () => {
  it('aborts the running gather and marks the job cancelled', async () => {
    const g = controlledGather();
    const start = await tools.research_start.execute({ query: 'q' }, context, config);
    const jobId = start.data.jobId as string;
    await g.started;
    g.opts().onEvidence?.([item(0)]);

    const c = await tools.research_cancel.execute({ jobId }, context, config);
    expect(c.data).toEqual({ jobId, cancelled: true, status: 'cancelled' });
    expect(g.opts().signal?.aborted).toBe(true);

    // Evidence delivered before the cancel stays readable; a late completion is ignored.
    g.finish(evidenceResult('q', [item(0), item(1)]));
    await flush();
    const s = await tools.research_status.execute({ jobId }, context, config);
    expect(s.data).toMatchObject({ status: 'cancelled', cursor: 1 });

    const again = await tools.research_cancel.execute({ jobId }, context, config);
    expect(again.data.cancelled).toBe(false);
  });
});
