/** @jest-environment node */
/**
 * query_case_knowledge draft guard: the `recordStatus` param becomes a vector
 * store filter, and draft hits come back labelled (field + citation marker).
 * Synthetic fixtures only.
 */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../../search/reranker', () => ({
  rerank: jest.fn(async (_q: string, results: unknown[], topN: number) => (results as unknown[]).slice(0, topN)),
}));
jest.mock('../../../chat/chat-vector-store', () => ({ getChatVectorStore: jest.fn() }));

import { QueryCaseKnowledgeTool } from '../query-case-knowledge';
import type { ToolExecutionContext, ToolConfigEntry } from '../../tool-types';
import type { SearchResult } from '../../../vector/vector-store';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const config: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

function hit(over: Partial<SearchResult['metadata']> & { chunkId: string; text: string }): SearchResult {
  const { chunkId, text, ...meta } = over;
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
      ...meta,
    },
  };
}

function makeContext(results: SearchResult[], docTags: Record<string, unknown> = {}) {
  const search = jest.fn().mockResolvedValue(results);
  const database = {
    case: { findUnique: jest.fn().mockResolvedValue(null) },
    filing: { findMany: jest.fn().mockResolvedValue([]) },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ fileName: 'motion.pdf', filing: null, case: null, documentType: 'Motion', tags: docTags }),
    },
  };
  const context = {
    logger,
    sessionId: 'sess-t',
    vectorStore: { search },
    database,
    embeddingProvider: { embed: jest.fn().mockResolvedValue([[0.1, 0.2]]) },
  } as unknown as ToolExecutionContext;
  return { context, search };
}

describe('query_case_knowledge recordStatus', () => {
  const tool = new QueryCaseKnowledgeTool();

  it('declares the recordStatus filter in its input schema and documents draft labelling', () => {
    const meta = tool.getMetadata();
    const prop = (meta.inputSchema as any).properties.recordStatus;
    expect(prop.enum).toEqual(['filed', 'draft', 'any']);
    expect(meta.description).toMatch(/DRAFT/);
  });

  it('passes recordStatus through as a vector-store filter', async () => {
    const { context, search } = makeContext([]);
    await tool.executeImpl({ query: 'mediation', caseId: 'case-1', searchMode: 'keyword', recordStatus: 'filed' }, context, config);
    expect(search).toHaveBeenCalled();
    expect(search.mock.calls[0][0].filter).toMatchObject({ caseId: 'case-1', recordStatus: 'filed' });
  });

  it('does not add a filter for the default "any"', async () => {
    const { context, search } = makeContext([]);
    await tool.executeImpl({ query: 'mediation', caseId: 'case-1', searchMode: 'keyword' }, context, config);
    expect(search.mock.calls[0][0].filter).toEqual({ caseId: 'case-1' });
  });

  it('labels draft hits: recordStatus field plus DRAFT marker in the citation', async () => {
    const { context } = makeContext([
      hit({ chunkId: 'c1', text: 'draft text', recordStatus: 'draft' }),
      hit({ chunkId: 'c2', text: 'filed text', pageNumber: 4, recordStatus: 'filed' }),
    ]);
    const out = await tool.executeImpl({ query: 'mediation', caseId: 'case-1', searchMode: 'keyword' }, context, config);
    const draft = out.results.find((r) => r.text === 'draft text')!;
    const filed = out.results.find((r) => r.text === 'filed text')!;
    expect(draft.recordStatus).toBe('draft');
    expect(draft.citation).toMatch(/DRAFT, filing not confirmed$/);
    expect(draft.citationShort).toMatch(/DRAFT, filing not confirmed$/);
    expect(filed.recordStatus).toBe('filed');
    expect(filed.citation).not.toMatch(/DRAFT/);
  });

  it('falls back to Document.tags.recordStatus for chunks indexed before the column existed', async () => {
    const { context } = makeContext([hit({ chunkId: 'c1', text: 'legacy chunk' })], { recordStatus: 'draft' });
    const out = await tool.executeImpl({ query: 'mediation', caseId: 'case-1', searchMode: 'keyword' }, context, config);
    expect(out.results[0].recordStatus).toBe('draft');
    expect(out.results[0].citation).toMatch(/DRAFT, filing not confirmed$/);
  });
});
