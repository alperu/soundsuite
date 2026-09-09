/** @jest-environment node */
/**
 * `searchMode` / `recordStatus` must reach BOTH `query_case_knowledge` payload
 * sites, not just the first.
 *
 * `research_evidence` builds two independent payloads: the phase-1 fan-out in
 * `executeParallelSearches`, and a second one inside `runRlmEvidenceRounds`'
 * `executeTool` that the RLM agent drives during `deep-rlm`. A parameter
 * honoured in phase 1 and dropped in the RLM rounds is this repo's recurring
 * half-threading defect, so the second assertion here is the one that matters
 * (docs/tasks/30 Part 1, Edit 5).
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy).
 */

/**
 * Drive one `query_case_knowledge` tool call through the RLM loop, then stop.
 * This is the seam that lets the real `executeTool` build its real payload.
 */
const runRlmWithTools = jest.fn();
jest.mock('../../ai/stream-rlm', () => ({
  runRlmWithTools: (...args: unknown[]) => (runRlmWithTools as any)(...args),
  RLM_MODEL_ID: 'test-rlm',
}));
jest.mock('@/lib/db/config', () => ({ getConfig: jest.fn().mockResolvedValue({ rerankPoolSize: 150 }) }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { executeParallelSearches, runRlmEvidenceRounds } from '../deep-search';

/** A registry double that records the params of every tool call. */
function makeRegistry() {
  const execute = jest.fn().mockResolvedValue({ success: true, data: { results: [] } });
  return { registry: { execute } as any, execute };
}

/** Params of the first `query_case_knowledge` call the registry saw. */
function qckParams(execute: jest.Mock) {
  const call = execute.mock.calls.find((c) => c[0] === 'query_case_knowledge');
  if (!call) throw new Error('query_case_knowledge was never called');
  return call[1] as Record<string, unknown>;
}

describe('phase-1 fan-out (executeParallelSearches)', () => {
  it('threads searchMode and recordStatus into the payload', async () => {
    const { registry, execute } = makeRegistry();
    await executeParallelSearches(['mediation'], 'case-1', registry, undefined, undefined, 50, undefined, {
      searchMode: 'keyword',
      recordStatus: 'filed',
    });
    expect(qckParams(execute)).toMatchObject({ searchMode: 'keyword', recordStatus: 'filed' });
  });

  it('defaults to hybrid and omits recordStatus when the caller passes nothing', async () => {
    const { registry, execute } = makeRegistry();
    // The dashboard deep-search caller passes only five arguments.
    await executeParallelSearches(['mediation'], 'case-1', registry, undefined, undefined);
    const params = qckParams(execute);
    expect(params.searchMode).toBe('hybrid');
    // Not defaulted to 'any' — query_case_knowledge already defaults it, and
    // sending it would bloat the params of every existing call.
    expect(params).not.toHaveProperty('recordStatus');
  });

  it('passes searchMode through even when it makes embedding failures fatal', async () => {
    const { registry, execute } = makeRegistry();
    await executeParallelSearches(['mediation'], 'case-1', registry, undefined, undefined, 50, undefined, {
      searchMode: 'vector',
    });
    expect(qckParams(execute).searchMode).toBe('vector');
  });
});

describe('RLM evidence rounds — the half-threading catcher', () => {
  /**
   * Make the mocked RLM loop invoke the REAL `executeTool` with one
   * `query_case_knowledge` call, so the payload under assertion is the one
   * `runRlmEvidenceRounds` actually builds.
   */
  function driveOneToolCall() {
    runRlmWithTools.mockImplementation(async function* (opts: any) {
      yield { type: 'start', host: 'http://rlm.invalid:8100', model: 'test-rlm' };
      yield { type: 'tool-call', name: 'query_case_knowledge', args: { query: 'follow-up' } };
      await opts.executeTool('query_case_knowledge', { query: 'follow-up' });
      yield { type: 'done', text: '' };
    });
  }

  const decomposition = { subQueries: ['mediation'], strategy: 'test' } as any;

  it('threads searchMode and recordStatus into the RLM round payload', async () => {
    driveOneToolCall();
    const { registry, execute } = makeRegistry();
    await runRlmEvidenceRounds('a query', decomposition, [], registry, {
      searchMode: 'keyword',
      recordStatus: 'draft',
    });
    // If Edit 5 were skipped, this payload would still say 'hybrid' and carry
    // no recordStatus while phase 1 honoured both.
    expect(qckParams(execute)).toMatchObject({ searchMode: 'keyword', recordStatus: 'draft' });
  });

  it('defaults to hybrid and omits recordStatus when unset', async () => {
    driveOneToolCall();
    const { registry, execute } = makeRegistry();
    await runRlmEvidenceRounds('a query', decomposition, [], registry, {});
    const params = qckParams(execute);
    expect(params.searchMode).toBe('hybrid');
    expect(params).not.toHaveProperty('recordStatus');
  });

  it('agrees with phase 1 on the same options — neither site wins', async () => {
    driveOneToolCall();
    const a = makeRegistry();
    const b = makeRegistry();
    const opts = { searchMode: 'vector' as const, recordStatus: 'filed' as const };

    await executeParallelSearches(['mediation'], undefined, a.registry, undefined, undefined, 50, undefined, opts);
    await runRlmEvidenceRounds('a query', decomposition, [], b.registry, opts);

    const phase1 = qckParams(a.execute);
    const rlm = qckParams(b.execute);
    expect(rlm.searchMode).toBe(phase1.searchMode);
    expect(rlm.recordStatus).toBe(phase1.recordStatus);
  });
});
