/**
 * Shared doubles for the discovery-tool suites (task #10).
 *
 * NOT a test file — `jest.config.js` testMatch only collects `*.test.ts`.
 *
 * Every fixture is SYNTHETIC: invented case names, `CAUSE NO. 00-0000-XX`
 * placeholders, generic filing titles, invented people (CLAUDE.md § Privacy).
 */

import type { ToolConfigEntry, ToolExecutionContext } from '../../tool-types';

export const CONFIG: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

export function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * A context whose `database` is the supplied plain object, cast once at the
 * boundary — the same pattern as analysis-tool-harness.ts. Nothing else on the
 * context is exercised by the discovery tools (no vector store, no LLM).
 */
export function makeContext(database: Record<string, any>): ToolExecutionContext & {
  logger: ReturnType<typeof makeLogger>;
} {
  const logger = makeLogger();
  return {
    vectorStore: {} as any,
    embeddingProvider: {} as any,
    database: database as any,
    logger: logger as any,
    profile: 'local',
  } as any;
}

/** `findMany` double that ignores its argument and returns a fixed list. */
export function fixedFindMany(rows: any[]) {
  return jest.fn().mockResolvedValue(rows);
}

// ---------------------------------------------------------------------------
// Synthetic rows
// ---------------------------------------------------------------------------

export const CASE_A = {
  id: 'case-aaa',
  name: 'Nordvale Holdings Bill of Review',
  caseNumber: 'CAUSE NO. 00-0000-XX',
  jurisdiction: 'D-1-XX',
  county: 'Example County',
  state: 'TX',
  createdAt: new Date('2024-01-02T00:00:00.000Z'),
  documents: [{ id: 'doc-1' }, { id: 'doc-2' }],
};

export const CASE_B = {
  id: 'case-bbb',
  name: 'Quill Fabrication Interlocutory Appeal',
  caseNumber: 'CAUSE NO. 00-0001-XX',
  jurisdiction: 'D-1-XX',
  county: null,
  state: null,
  createdAt: new Date('2024-02-02T00:00:00.000Z'),
  documents: [],
};
