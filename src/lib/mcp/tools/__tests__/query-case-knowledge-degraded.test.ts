/** @jest-environment node */
/**
 * The degraded path must not report an undifferentiated success.
 *
 * `query_case_knowledge` has two legs that fail *into* a 200: the default
 * `searchMode: 'hybrid'` falls through to keyword/FTS when the embedding
 * provider throws, and `rerank()` returns its input unchanged on all six of
 * its failure paths. Before docs/tasks/39 item 10 neither was visible to a
 * caller — the `pushWarning` channel both sites write to is never supplied on
 * an MCP-facing `ToolExecutionContext`, and `ToolExecutionResult` has no field
 * to carry a warning regardless.
 *
 * These tests pin the in-band replacement: `retrieval` + `warnings` on the
 * result object itself, which `mcp-server.ts:222` serialises verbatim.
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy).
 */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../chat/chat-vector-store', () => ({ getChatVectorStore: jest.fn() }));

// The reranker is the unit under observation in half these tests, so the
// double honours the real contract: it reports an outcome through `onOutcome`
// and returns the input array untouched when it does not rerank.
jest.mock('../../../search/reranker', () => ({
  rerank: jest.fn(
    async (
      _q: string,
      results: any[],
      topN: number,
      _onWarning: unknown,
      opts?: { onOutcome?: (o: unknown) => void },
    ) => {
      opts?.onOutcome?.({
        applied: true,
        host: 'http://rerank.invalid:8099',
        model: 'test-reranker',
        poolIn: results.length,
        poolOut: Math.min(results.length, topN),
      });
      return results.slice(0, topN);
    },
  ),
}));

import { QueryCaseKnowledgeTool } from '../query-case-knowledge';
import { rerank } from '../../../search/reranker';
import type { ToolExecutionContext, ToolConfigEntry } from '../../tool-types';
import type { SearchResult } from '../../../vector/vector-store';

const config: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };
const mockedRerank = rerank as unknown as jest.Mock;

function hit(chunkId: string, text: string): SearchResult {
  return {
    chunkId,
    text,
    score: 0.9,
    metadata: {
      documentId: 'doc-1',
      caseId: 'case-1',
      pageNumber: 3,
      chunkIndex: 0,
      isExhibit: false,
    },
  } as SearchResult;
}

/**
 * @param embed  `'ok'` resolves a vector; an Error is thrown by the provider.
 */
function makeContext(results: SearchResult[], embed: 'ok' | Error = 'ok') {
  const database = {
    case: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([{ id: 'case-1' }]),
    },
    filing: { findMany: jest.fn().mockResolvedValue([]) },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        fileName: 'motion.pdf',
        filing: null,
        case: null,
        documentType: 'Motion',
        tags: {},
      }),
    },
  };
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    vectorStore: { search: jest.fn().mockResolvedValue(results) },
    database,
    embeddingProvider: {
      embed:
        embed === 'ok'
          ? jest.fn().mockResolvedValue([[0.1, 0.2]])
          : jest.fn().mockRejectedValue(embed),
    },
  } as unknown as ToolExecutionContext;
}

/** Make the mocked reranker take one of its six non-rerank exits. */
function rerankSkips(reason: string, message?: string) {
  mockedRerank.mockImplementationOnce(
    async (_q: string, results: any[], _topN: number, _w: unknown, opts?: any) => {
      opts?.onOutcome?.({ applied: false, reason, message, poolIn: results.length, poolOut: results.length });
      return results;
    },
  );
}

describe('query_case_knowledge degradation is reported in-band', () => {
  const tool = new QueryCaseKnowledgeTool();
  beforeEach(() => jest.clearAllMocks());

  it('reports a healthy run as undegraded', async () => {
    const out = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([hit('c1', 'some text')]),
      config,
    );
    expect(out.retrieval).toMatchObject({
      searchModeRequested: 'hybrid',
      searchModeEffective: 'hybrid',
      vectorSearchApplied: true,
      rerankApplied: true,
    });
    expect(out.retrieval.rerankSkipReason).toBeUndefined();
    expect(out.warnings).toEqual([]);
  });

  // --- The embedding leg (docs/tasks/39 item 10) ---------------------------

  it('hybrid + embedding failure still succeeds, but says it became keyword-only', async () => {
    const out = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([hit('c1', 'some text')], new Error('connection refused (http://embed.invalid:11434)')),
      config,
    );

    // The pre-existing behaviour that made this defect invisible: still a
    // successful result with rows in it.
    expect(out.results.length).toBeGreaterThan(0);

    // ...and now it is legible.
    expect(out.retrieval.searchModeRequested).toBe('hybrid');
    expect(out.retrieval.searchModeEffective).toBe('keyword');
    expect(out.retrieval.vectorSearchApplied).toBe(false);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/KEYWORD-ONLY/);
    // Names the degraded role, and forbids the "corpus has no answer" reading.
    expect(out.warnings[0]).toMatch(/embedding provider failed/i);
    expect(out.warnings[0]).toMatch(/not an empty corpus/i);
    // Carries the host so an operator knows which endpoint to fix.
    expect(out.warnings[0]).toContain('http://embed.invalid:11434');
  });

  it('an empty degraded result is distinguishable from an empty healthy one', async () => {
    const degraded = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([], new Error('embed failed')),
      config,
    );
    const healthy = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([]),
      config,
    );

    // This is the whole point of the task: both return zero rows, and only
    // one of them is evidence about the corpus.
    expect(degraded.results).toEqual([]);
    expect(healthy.results).toEqual([]);
    expect(degraded.retrieval.vectorSearchApplied).toBe(false);
    expect(healthy.retrieval.vectorSearchApplied).toBe(true);
    expect(degraded.warnings.length).toBeGreaterThan(0);
    expect(healthy.warnings).toEqual([]);
  });

  it('searchMode "vector" still throws EMBEDDING_UNAVAILABLE rather than degrading', async () => {
    await expect(
      tool.executeImpl(
        { query: 'mediation', caseId: 'case-1', searchMode: 'vector' },
        makeContext([hit('c1', 'some text')], new Error('embed failed')),
        config,
      ),
    ).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
  });

  it('searchMode "keyword" is not a degradation — it was asked for', async () => {
    const out = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1', searchMode: 'keyword' },
      makeContext([hit('c1', 'some text')]),
      config,
    );
    expect(out.retrieval.searchModeRequested).toBe('keyword');
    expect(out.retrieval.searchModeEffective).toBe('keyword');
    expect(out.retrieval.vectorSearchApplied).toBe(false);
    expect(out.warnings).toEqual([]);
  });

  // --- The rerank leg (docs/tasks/22) --------------------------------------

  it.each([
    ['degraded', 'reranker unavailable'],
    ['fetch', 'fetch failed'],
    ['score-validation', 'all scores identical'],
    ['disabled', undefined],
    ['provider-none', undefined],
    ['no-host', undefined],
  ])('reports rerankApplied:false with reason "%s"', async (reason, message) => {
    rerankSkips(reason, message);
    const out = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([hit('c1', 'a'), hit('c2', 'b')]),
      config,
    );
    expect(out.retrieval.rerankApplied).toBe(false);
    expect(out.retrieval.rerankSkipReason).toBe(reason);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/NOT reranked/);
    // Must say what the ordering now IS, not merely that something failed.
    expect(out.warnings[0]).toMatch(/first-stage/i);
    expect(out.warnings[0]).toContain(reason);
    if (message) expect(out.warnings[0]).toContain(message);
  });

  it('does not warn when there was simply nothing to rerank', async () => {
    rerankSkips('empty-results');
    const out = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([]),
      config,
    );
    // An empty `results` already tells the caller this; a warning here would
    // cry wolf on every zero-hit query and devalue the real ones.
    expect(out.warnings).toEqual([]);
    expect(out.retrieval.rerankApplied).toBe(false);
  });

  it('accumulates both degradations when both legs fail', async () => {
    rerankSkips('degraded', 'reranker unavailable');
    const out = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([hit('c1', 'a')], new Error('embed failed')),
      config,
    );
    expect(out.retrieval).toMatchObject({
      searchModeEffective: 'keyword',
      vectorSearchApplied: false,
      rerankApplied: false,
      rerankSkipReason: 'degraded',
    });
    expect(out.warnings).toHaveLength(2);
  });

  it('survives JSON serialisation — this is what mcp-server.ts:222 sends', async () => {
    rerankSkips('degraded', 'reranker unavailable');
    const out = await tool.executeImpl(
      { query: 'mediation', caseId: 'case-1' },
      makeContext([hit('c1', 'a')], new Error('embed failed')),
      config,
    );
    const overTheWire = JSON.parse(JSON.stringify(out));
    expect(overTheWire.retrieval.rerankApplied).toBe(false);
    expect(overTheWire.retrieval.searchModeEffective).toBe('keyword');
    expect(overTheWire.warnings).toHaveLength(2);
  });

  it('advertises both fields in the tool description so a model looks for them', () => {
    const description = tool.getMetadata().description;
    expect(description).toContain('retrieval');
    expect(description).toContain('warnings');
    expect(description).toMatch(/rerankApplied/);
    expect(description).toMatch(/searchModeEffective/);
  });
});
