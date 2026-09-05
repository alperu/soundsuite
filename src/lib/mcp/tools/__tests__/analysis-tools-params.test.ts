/** @jest-environment node */
/**
 * SS-3 — parameter validation for the analysis tools.
 *
 * `BaseMCPTool.execute` runs a generic presence check over the tool's declared
 * `inputSchema.required` and then the optional `validateParams` hook, and it
 * normalises a thrown `err.code` into `ToolExecutionResult.errorCode` — so
 * every tool gets `INVALID_PARAMS` from its own advertised schema.
 * `query_case_graph` additionally implements the hook for its conditional
 * requirements (motionId / personId depend on `operation`).
 *
 * All fixtures synthetic (see analysis-tool-harness.ts).
 */

jest.mock('../../../ai/ai-provider', () => ({ completeAI: jest.fn() }));
jest.mock('../../../db/config', () => ({
  getConfig: jest.fn().mockResolvedValue({ ollamaHost: 'http://127.0.0.1:11434' }),
}));
jest.mock('../../../search/reranker', () => ({
  rerank: jest.fn(async (_q: string, results: unknown[], topN: number) => results.slice(0, topN)),
}));
jest.mock('../../../search/graph-expand', () => ({
  amendmentLineage: jest.fn().mockResolvedValue([]),
  motionsByPerson: jest.fn().mockResolvedValue([]),
  relatedMotions: jest.fn().mockResolvedValue([]),
}));

import { completeAI } from '../../../ai/ai-provider';
import { DetectContradictionsTool } from '../detect-contradictions';
import { DetectPrivilegeTool } from '../detect-privilege';
import { AnalyzeCitationsTool } from '../analyze-citations';
import { ExtractObligationsTool } from '../extract-obligations';
import { ReconstructTimelineTool } from '../reconstruct-timeline';
import { ExtractEntitiesTool } from '../extract-entities';
import { TrackClaimEvolutionTool } from '../track-claim-evolution';
import { ExtractArgumentStructureTool } from '../extract-argument-structure';
import { CompareArgumentStructuresTool } from '../compare-argument-structures';
import { AnalyzeToneTool } from '../analyze-tone';
import { QueryCaseGraphTool } from '../query-case-graph';
import { SearchWorkflowsTool } from '../search-workflows';
import type { BaseMCPTool } from '../base-tool';
import { CONFIG, aiResponse, makeHarness } from './analysis-tool-harness';

const ai = completeAI as unknown as jest.Mock;

/** [tool, params that omit a required field, the omitted field]. */
const MISSING: Array<[string, BaseMCPTool<any, any>, Record<string, unknown>, string]> = [
  ['detect_contradictions', new DetectContradictionsTool(), {}, 'caseId'],
  ['detect_privilege', new DetectPrivilegeTool(), {}, 'documentId'],
  ['analyze_citations', new AnalyzeCitationsTool(), {}, 'caseId'],
  ['extract_obligations', new ExtractObligationsTool(), {}, 'documentId'],
  ['reconstruct_timeline', new ReconstructTimelineTool(), {}, 'caseId'],
  ['extract_entities', new ExtractEntitiesTool(), {}, 'documentId'],
  ['track_claim_evolution', new TrackClaimEvolutionTool(), { caseId: 'case-1' }, 'claim'],
  ['extract_argument_structure', new ExtractArgumentStructureTool(), {}, 'documentId'],
  ['compare_argument_structures', new CompareArgumentStructuresTool(), { documentId1: 'doc-1' }, 'documentId2'],
  ['analyze_tone', new AnalyzeToneTool(), {}, 'documentId'],
];

beforeEach(() => {
  ai.mockReset();
  // Any well-formed empty response; the point of these cases is what happens
  // before the model is reached, not what it returns.
  ai.mockResolvedValue(aiResponse('{}'));
});

describe('analysis tools: missing required parameters', () => {
  // `BaseMCPTool.execute` now runs a generic presence check derived from each
  // tool's declared `inputSchema.required` before `validateParams`, so the
  // requirement holds for every tool without a per-tool hook.
  for (const [name, tool, params, field] of MISSING) {
    it(`${name}: REQUIRED — missing "${field}" must fail with INVALID_PARAMS`, async () => {
      const { context } = makeHarness();

      const out = await tool.execute(params, context, CONFIG);

      expect(out.success).toBe(false);
      expect(out.errorCode).toBe('INVALID_PARAMS');
    });
  }

  it('detect_contradictions without caseId never reaches the store or the model', async () => {
    // The harm this prevents: an undefined case scope used to become
    // `{caseId: undefined}` in the vector-store filter, and whatever came back
    // was sent to the LLM and returned as an analysis of a case the caller
    // never named. Validation must run before any retrieval.
    ai.mockResolvedValue(aiResponse(JSON.stringify({ contradictions: [] })));
    const { context, search } = makeHarness();

    const out = await new DetectContradictionsTool().execute({} as any, context, CONFIG);

    expect(out.success).toBe(false);
    expect(out.errorCode).toBe('INVALID_PARAMS');
    expect(search).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });

  it('BaseMCPTool.execute propagates a thrown err.code as errorCode', async () => {
    // The mechanism the missing validation would use, proven against the one
    // tool that does validate.
    const { context } = makeHarness();

    const out = await new QueryCaseGraphTool().execute({} as any, context, CONFIG);

    expect(out.success).toBe(false);
    expect(out.errorCode).toBe('INVALID_PARAMS');
    expect(out.error).toMatch(/operation is required/);
  });
});

describe('query_case_graph: parameter validation (the one tool that has it)', () => {
  const tool = new QueryCaseGraphTool();

  it.each([
    ['no operation', {}, /operation is required/],
    ['amendment-lineage without motionId', { operation: 'amendment-lineage' }, /motionId is required/],
    ['related-motions without motionId', { operation: 'related-motions' }, /motionId is required/],
    ['motions-by-person without personId', { operation: 'motions-by-person' }, /personId is required/],
  ])('rejects %s with INVALID_PARAMS', async (_label, params, pattern) => {
    const { context } = makeHarness();

    const out = await tool.execute(params as any, context, CONFIG);

    expect(out.success).toBe(false);
    expect(out.errorCode).toBe('INVALID_PARAMS');
    expect(out.error).toMatch(pattern as RegExp);
  });

  it('accepts a complete amendment-lineage call', async () => {
    const { context } = makeHarness();

    const out = await tool.execute(
      { operation: 'amendment-lineage', motionId: 'motion-1' } as any,
      context,
      CONFIG,
    );

    expect(out.success).toBe(true);
    expect(out.data).toEqual({ operation: 'amendment-lineage', nodes: [], count: 0 });
  });

  it('never reaches an LLM — it is a graph lookup, not an analysis call', async () => {
    const { context } = makeHarness();

    await tool.execute({ operation: 'motions-by-person', personId: 'person-1' } as any, context, CONFIG);

    expect(ai).not.toHaveBeenCalled();
  });
});

describe('search_workflows: no required parameters', () => {
  const tool = new SearchWorkflowsTool();

  it('runs with no arguments at all', async () => {
    const { context } = makeHarness();

    const out = await tool.execute({}, context, CONFIG);

    expect(out.success).toBe(true);
    expect(out.data).toEqual({ results: [] });
  });

  it('passes caseId and status through to the workflow query', async () => {
    const { context } = makeHarness();

    await tool.execute({ caseId: 'case-1', status: 'draft' }, context, CONFIG);

    const where = (context.database as any).workflow.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ caseId: 'case-1', status: 'draft' });
  });

  it('lower-cases the query before matching and searches both stores', async () => {
    const { context } = makeHarness();

    await tool.execute({ query: 'Motion To Compel' }, context, CONFIG);

    const wfWhere = (context.database as any).workflow.findMany.mock.calls[0][0].where;
    const tplWhere = (context.database as any).workflowTemplate.findMany.mock.calls[0][0].where;
    expect(wfWhere.OR[0].title.contains).toBe('motion to compel');
    expect(tplWhere.OR[0].name.contains).toBe('motion to compel');
  });

  it('never reaches an LLM', async () => {
    const { context } = makeHarness();

    await tool.execute({ query: 'anything' }, context, CONFIG);

    expect(ai).not.toHaveBeenCalled();
  });
});
