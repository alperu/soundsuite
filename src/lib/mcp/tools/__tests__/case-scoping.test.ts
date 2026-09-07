/** @jest-environment node */
/**
 * Multi-case scoping and parameter typing
 * (docs/tasks/12-multi-case-scoping-and-param-typing.md).
 *
 * One tripwire per row of that task's measured defect table, per tool:
 *  - `caseId: [ … ]`      → 400 INVALID_PARAMS *before* any store/DB call
 *  - an unknown top-level key → 400 naming the key (with a hint for `caseScope`)
 *  - `caseIds`            → the store receives `case_id IN (…)`-shaped filter
 *  - `caseId` + `caseIds` → 400, they are mutually exclusive
 *  - an id with no Case row → 400 "case not found", one `case.findMany`
 *  - an ORM throw          → EXECUTION_ERROR with no "prisma" in the message
 *
 * Synthetic ids and patterns only.
 */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../search/reranker', () => ({
  rerank: jest.fn(async (_q: string, results: unknown[], topN: number) => (results as unknown[]).slice(0, topN)),
}));
jest.mock('../../../chat/chat-vector-store', () => ({ getChatVectorStore: jest.fn() }));
jest.mock('../../../search/graph-expand', () => ({
  amendmentLineage: jest.fn().mockResolvedValue([]),
  motionsByPerson: jest.fn().mockResolvedValue([]),
  relatedMotions: jest.fn().mockResolvedValue([]),
}));

import { ScanForPatternTool } from '../scan-for-pattern';
import { QueryCaseKnowledgeTool } from '../query-case-knowledge';
import { QueryCaseGraphTool } from '../query-case-graph';
import { amendmentLineage } from '../../../search/graph-expand';
import type { ToolExecutionContext, ToolConfigEntry } from '../../tool-types';

const CASE_A = '00000000-0000-4000-8000-0000000000aa';
const CASE_B = '00000000-0000-4000-8000-0000000000bb';
const CASE_MISSING = '00000000-0000-4000-8000-0000000000ff';

const config: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** Context whose `case.findMany` knows about CASE_A and CASE_B only. */
function makeContext(opts: { caseFindMany?: jest.Mock; search?: jest.Mock } = {}) {
  const search = opts.search ?? jest.fn().mockResolvedValue([]);
  const caseFindMany =
    opts.caseFindMany ??
    jest.fn(async ({ where }: any) =>
      (where.id.in as string[]).filter((id) => id === CASE_A || id === CASE_B).map((id) => ({ id })),
    );
  const database = {
    case: { findUnique: jest.fn().mockResolvedValue(null), findMany: caseFindMany },
    filing: { findMany: jest.fn().mockResolvedValue([]) },
    document: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
  };
  const context = {
    logger: makeLogger(),
    sessionId: 'sess-scope',
    vectorStore: { search },
    database,
    embeddingProvider: { embed: jest.fn().mockResolvedValue([[0.1, 0.2]]) },
  } as unknown as ToolExecutionContext;
  return { context, search, caseFindMany, database };
}

/** The tools under test and a minimal valid param bag for each. */
const CASES = [
  { name: 'scan_for_pattern', tool: () => new ScanForPatternTool(), base: { pattern: 'trust fund' } },
  { name: 'query_case_knowledge', tool: () => new QueryCaseKnowledgeTool(), base: { query: 'trust fund', searchMode: 'keyword' } },
] as const;

describe.each(CASES)('$name — case scoping', ({ tool, base }) => {
  it('rejects an array caseId with INVALID_PARAMS before touching the store or the database', async () => {
    const { context, search, caseFindMany } = makeContext();
    const res = await tool().execute({ ...base, caseId: [CASE_A, CASE_B] } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('caseId');
    expect(res.error).toContain('string');
    expect(search).not.toHaveBeenCalled();
    expect(caseFindMany).not.toHaveBeenCalled();
  });

  it('rejects an unknown top-level parameter, naming it', async () => {
    const { context, search } = makeContext();
    const res = await tool().execute({ ...base, notAThing: 1 } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('notAThing');
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects caseScope with a hint pointing at caseIds', async () => {
    const { context, search } = makeContext();
    const res = await tool().execute({ ...base, caseScope: [CASE_A, CASE_B] } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('caseScope');
    expect(res.error).toContain('caseIds');
    expect(search).not.toHaveBeenCalled();
  });

  it('passes caseIds to the store as an IN-list filter with exactly those ids', async () => {
    const { context, search } = makeContext();
    const res = await tool().execute({ ...base, caseIds: [CASE_A, CASE_B] } as any, context, config);

    expect(res.success).toBe(true);
    expect(search).toHaveBeenCalled();
    const filter = (search.mock.calls[0][0] as any).filter;
    expect(filter.caseIds).toEqual([CASE_A, CASE_B]);
    expect(filter.caseId).toBeUndefined();
  });

  it('rejects caseId and caseIds together', async () => {
    const { context, search } = makeContext();
    const res = await tool().execute({ ...base, caseId: CASE_A, caseIds: [CASE_B] } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('mutually exclusive');
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects an id with no Case row, in one findMany, naming the id', async () => {
    const { context, search, caseFindMany } = makeContext();
    const res = await tool().execute({ ...base, caseIds: [CASE_A, CASE_MISSING] } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('case not found');
    expect(res.error).toContain(CASE_MISSING);
    expect(caseFindMany).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects a single bogus caseId rather than returning an empty page', async () => {
    const { context, search } = makeContext();
    const res = await tool().execute({ ...base, caseId: CASE_MISSING } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('case not found');
    expect(search).not.toHaveBeenCalled();
  });

  it('maps an ORM failure to EXECUTION_ERROR without leaking the invocation', async () => {
    const ormError: any = new Error(
      'Invalid `prisma.case.findMany()` invocation:\n\nArgument `id`: Invalid value provided.',
    );
    ormError.code = 'P2023';
    const { context } = makeContext({ caseFindMany: jest.fn().mockRejectedValue(ormError) });

    const res = await tool().execute({ ...base, caseId: CASE_A } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('EXECUTION_ERROR');
    expect(res.error?.toLowerCase()).not.toContain('prisma');
    expect(res.error?.toLowerCase()).not.toContain('invocation');
    // The real error still reaches the server log.
    expect((context.logger.error as jest.Mock).mock.calls[0][0]).toContain('prisma.case.findMany');
  });
});

describe('query_case_graph — case scoping', () => {
  const tool = () => new QueryCaseGraphTool();
  const base = { operation: 'amendment-lineage', motionId: 'motion-1' };

  beforeEach(() => jest.clearAllMocks());

  it('accepts caseIds as an alias of caseScope', async () => {
    const { context } = makeContext();
    const res = await tool().execute({ ...base, caseIds: [CASE_A, CASE_B] } as any, context, config);

    expect(res.success).toBe(true);
    expect((amendmentLineage as jest.Mock).mock.calls[0][1].caseScope).toEqual([CASE_A, CASE_B]);
  });

  it('keeps caseScope working', async () => {
    const { context } = makeContext();
    const res = await tool().execute({ ...base, caseScope: [CASE_A] } as any, context, config);

    expect(res.success).toBe(true);
    expect((amendmentLineage as jest.Mock).mock.calls[0][1].caseScope).toEqual([CASE_A]);
  });

  it('rejects caseScope and caseIds together', async () => {
    const { context } = makeContext();
    const res = await tool().execute({ ...base, caseScope: [CASE_A], caseIds: [CASE_B] } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(amendmentLineage).not.toHaveBeenCalled();
  });

  it('rejects an unknown top-level parameter', async () => {
    const { context } = makeContext();
    const res = await tool().execute({ ...base, caseIdList: [CASE_A] } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('caseIdList');
    expect(amendmentLineage).not.toHaveBeenCalled();
  });

  it('rejects a scope id with no Case row', async () => {
    const { context, caseFindMany } = makeContext();
    const res = await tool().execute({ ...base, caseIds: [CASE_MISSING] } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('case not found');
    expect(caseFindMany).toHaveBeenCalledTimes(1);
    expect(amendmentLineage).not.toHaveBeenCalled();
  });

  it('rejects a caseScope that is not an array', async () => {
    const { context } = makeContext();
    const res = await tool().execute({ ...base, caseScope: CASE_A } as any, context, config);

    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toContain('caseScope');
    expect(amendmentLineage).not.toHaveBeenCalled();
  });
});

describe('research_evidence params — case scoping', () => {
  it('rejects caseId and caseIds together', async () => {
    const { parseResearchParams } = await import('../../research/research-params');
    await expect(parseResearchParams({ caseId: CASE_A, caseIds: [CASE_B] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('threads caseIds into the gatherEvidence options', async () => {
    const { parseResearchParams } = await import('../../research/research-params');
    const { options } = await parseResearchParams({ caseIds: [CASE_A, CASE_B] });
    expect(options.caseIds).toEqual([CASE_A, CASE_B]);
    expect(options.caseId).toBeUndefined();
  });

  it('rejects caseScope, which is not a research parameter', async () => {
    const { parseResearchParams } = await import('../../research/research-params');
    await expect(parseResearchParams({ caseScope: [CASE_A] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });
});

describe('buildWhereClause — caseIds', () => {
  /** `buildWhereClause` is private; exercise it through a bare instance. */
  function clauseFor(filter: Record<string, unknown>): string {
    const { VectorStore } = require('../../../vector/vector-store');
    const store = new VectorStore({ dbPath: '/tmp/none', tableName: 'chunks' });
    return (store as any).buildWhereClause(filter);
  }

  it('emits an IN list for caseIds, quoted like caseId', () => {
    expect(clauseFor({ caseIds: [CASE_A, CASE_B] })).toBe(`case_id IN ("${CASE_A}", "${CASE_B}")`);
  });

  it('emits IN even for a single id, so the shape is stable', () => {
    expect(clauseFor({ caseIds: [CASE_A] })).toBe(`case_id IN ("${CASE_A}")`);
  });

  it('never ANDs caseIds with caseId — the two together are unsatisfiable', () => {
    const clause = clauseFor({ caseId: CASE_B, caseIds: [CASE_A] });
    expect(clause).toBe(`case_id IN ("${CASE_A}")`);
    expect(clause).not.toContain('AND');
  });

  it('leaves the single-case form untouched', () => {
    expect(clauseFor({ caseId: CASE_A })).toBe(`case_id = "${CASE_A}"`);
  });
});

// ---------------------------------------------------------------------------
// Citation quality must not depend on which param selected the case.
// ---------------------------------------------------------------------------

/**
 * Two synthetic cases with different jurisdictions, so the formatter choice is
 * observable: CASE_A is Texas (texas-appellate, "…-CV RR 4"), CASE_B has no
 * jurisdiction (generic, "…-CV — record.pdf, p. 4").
 */
function makeCitationContext(hits: Array<{ chunkId: string; caseId: string }>) {
  const CASE_ROWS: Record<string, any> = {
    [CASE_A]: { id: CASE_A, jurisdiction: 'Travis', state: 'Texas', country: 'US', caseNumber: '00-0000-AA' },
    [CASE_B]: { id: CASE_B, jurisdiction: null, state: null, country: null, caseNumber: '00-0000-BB' },
  };
  const caseFindMany = jest.fn(async ({ where }: any) =>
    (where.id.in as string[]).map((id) => CASE_ROWS[id]).filter(Boolean),
  );
  const filingFindMany = jest.fn().mockResolvedValue([]);
  const documentFindMany = jest.fn().mockResolvedValue([]);
  const search = jest.fn().mockResolvedValue(
    hits.map((h) => ({
      chunkId: h.chunkId,
      text: 'synthetic passage about a scheduling order',
      score: 0.9,
      metadata: {
        documentId: `doc-${h.chunkId}`,
        caseId: h.caseId,
        pageNumber: 4,
        chunkIndex: 0,
        isExhibit: false,
        filingType: "Reporter's Record",
        caseNumber: CASE_ROWS[h.caseId].caseNumber,
      },
    })),
  );
  const database = {
    case: { findUnique: jest.fn().mockResolvedValue(null), findMany: caseFindMany },
    filing: { findMany: filingFindMany },
    document: {
      findMany: documentFindMany,
      findUnique: jest.fn().mockResolvedValue({ fileName: 'record.pdf', filing: null, case: null, documentType: "Reporter's Record" }),
    },
  };
  const context = {
    logger: makeLogger(),
    sessionId: 'sess-cite',
    vectorStore: { search },
    database,
    embeddingProvider: { embed: jest.fn().mockResolvedValue([[0.1, 0.2]]) },
  } as unknown as ToolExecutionContext;
  return { context, search, caseFindMany, filingFindMany, documentFindMany };
}

describe.each(CASES)('$name — citation quality under caseIds', ({ tool, base }) => {
  it('formats caseIds:[A] byte-identically to caseId:A', async () => {
    const single = makeCitationContext([{ chunkId: 'c1', caseId: CASE_A }]);
    const viaCaseId = await tool().execute({ ...base, caseId: CASE_A } as any, single.context, config);

    const listed = makeCitationContext([{ chunkId: 'c1', caseId: CASE_A }]);
    const viaCaseIds = await tool().execute({ ...base, caseIds: [CASE_A] } as any, listed.context, config);

    expect(viaCaseId.success && viaCaseIds.success).toBe(true);
    const a = (viaCaseId.data as any).results[0];
    const b = (viaCaseIds.data as any).results[0];
    expect(b.citation).toBe(a.citation);
    expect(b.citationShort).toBe(a.citationShort);
    // Not the corpus-wide fallback: a Texas case gets the appellate form.
    expect(a.citation).toBe('00-0000-AA RR 4');
  });

  it('formats a multi-case page with each row\'s own case context, one batched lookup', async () => {
    const { context, caseFindMany, filingFindMany, documentFindMany } = makeCitationContext([
      { chunkId: 'c1', caseId: CASE_A },
      { chunkId: 'c2', caseId: CASE_B },
    ]);
    const res = await tool().execute({ ...base, caseIds: [CASE_A, CASE_B], limit: 10 } as any, context, config);

    expect(res.success).toBe(true);
    const byCase = Object.fromEntries(
      (res.data as any).results.map((r: any) => [r.caseId, r.citation]),
    );
    // Texas case → appellate form; the other → generic form. Neither is the
    // corpus-wide default, and they are not the same formatter.
    expect(byCase[CASE_A]).toBe('00-0000-AA RR 4');
    expect(byCase[CASE_B]).toBe('00-0000-BB — record.pdf, p. 4');

    // One batched lookup per table for the whole scope: the existence check
    // and the citation-context build, and one filing/document sweep.
    expect(caseFindMany).toHaveBeenCalledTimes(2);
    expect(filingFindMany).toHaveBeenCalledTimes(1);
    expect(documentFindMany).toHaveBeenCalledTimes(1);
    expect((filingFindMany.mock.calls[0][0] as any).where.caseId.in).toEqual([CASE_A, CASE_B]);
  });
});
