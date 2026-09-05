/**
 * Shared fixtures for the LLM analysis tool suites (SS-3).
 *
 * NOT a test file — `jest.config.js` testMatch only collects `*.test.ts`, so
 * this module is imported, never executed as a suite.
 *
 * Every fixture here is SYNTHETIC: invented parties, `CAUSE NO. 00-0000-XX`
 * placeholders, generic filing titles. Nothing in this file comes from a real
 * document (CLAUDE.md § Privacy).
 */

import type { ToolConfigEntry, ToolExecutionContext } from '../../tool-types';

export const CONFIG: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

/** Synthetic chunk text — invented case, invented parties, generic titles. */
export const SYNTHETIC_CHUNKS = [
  {
    chunkId: 'chunk-1',
    documentId: 'doc-1',
    fileName: 'motion.pdf',
    pageNumber: 1,
    text:
      'CAUSE NO. 00-0000-XX. Nordvale Holdings LLC moves the Court for entry of an order ' +
      'compelling production. Counsel for Petitioner advised the client on 2024-01-15.',
  },
  {
    chunkId: 'chunk-2',
    documentId: 'doc-2',
    fileName: 'response.pdf',
    pageNumber: 4,
    text:
      'Respondent Quill Fabrication Inc. denies that any conference occurred on 2024-01-15 ' +
      'and asserts the deadline to respond has not yet run.',
  },
];

export interface HarnessOptions {
  /** Chunks the vector store returns for any search. Defaults to SYNTHETIC_CHUNKS. */
  chunks?: typeof SYNTHETIC_CHUNKS;
  /** Extra fields merged onto the context (e.g. `profile`, `aiProvider`). */
  overlay?: Partial<ToolExecutionContext>;
}

export interface Harness {
  context: ToolExecutionContext;
  search: jest.Mock;
  logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
}

/**
 * A context whose vector store returns synthetic chunks for every query and
 * whose Prisma double answers the `document.findMany` / `findUnique` lookups
 * that `getCaseChunks` / `getDocumentChunks` make.
 */
export function makeHarness(opts: HarnessOptions = {}): Harness {
  const chunks = opts.chunks ?? SYNTHETIC_CHUNKS;

  const search = jest.fn().mockResolvedValue(
    chunks.map((c, i) => ({
      chunkId: c.chunkId,
      text: c.text,
      score: 0.9 - i * 0.1,
      metadata: {
        documentId: c.documentId,
        caseId: 'case-1',
        pageNumber: c.pageNumber,
        chunkIndex: i,
        isExhibit: false,
      },
    })),
  );

  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const database = {
    document: {
      findMany: jest.fn().mockResolvedValue(
        chunks.map((c) => ({ id: c.documentId, fileName: c.fileName })),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const hit = chunks.find((c) => c.documentId === where.id);
        return hit ? { fileName: hit.fileName } : { fileName: 'motion.pdf' };
      }),
    },
    workflow: { findMany: jest.fn().mockResolvedValue([]) },
    workflowTemplate: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const context = {
    logger,
    vectorStore: { search },
    database,
    embeddingProvider: { embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) },
    ...(opts.overlay ?? {}),
  } as unknown as ToolExecutionContext;

  return { context, search, logger };
}

/** A context whose vector store returns nothing — the "no evidence" path. */
export function makeEmptyHarness(overlay?: Partial<ToolExecutionContext>): Harness {
  return makeHarness({ chunks: [], overlay });
}

/** Shape `completeAI` returns; only `.content` is read by `callLLM`. */
export function aiResponse(content: string) {
  return { content, provider: 'ollama', model: 'qwen2.5:14b', usage: {} };
}
