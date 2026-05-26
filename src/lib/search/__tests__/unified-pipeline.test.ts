// Unified search pipeline tests (#54).
//
// Verifies that the extended `extractFieldFilters` + `resolvePrismaFilters`
// produce the right LanceDB where-clauses for:
//   - lance-scalar (case=="X" AND motion)
//   - lance-scalar-ref (caseRef==@uuid)
//   - 2-hop case-attribute traversal (case->jurisdiction=="TX")
//   - single-segment prisma-traverse (judge==@uuid → judgeRef==@uuid via alias)
//   - 3-hop case->judge->name="Roberts"
//   - numeric lance-scalar (volumeNumber >= 2)
//   - unknown root field degrades without crashing

jest.mock('@/lib/logger', () => {
  const mockLogger = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
  return {
    LogLevel: { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' },
    Logger: jest.fn().mockImplementation(() => mockLogger),
    createLogger: jest.fn().mockReturnValue(mockLogger),
    logger: mockLogger,
  };
});

jest.mock('@lancedb/lancedb', () => {
  class MatchQuery { constructor(public q: string, public field: string) {} }
  class PhraseQuery { constructor(public q: string, public field: string) {} }
  class BooleanQuery { constructor(public clauses: [string, any][]) {} }
  return {
    MatchQuery, PhraseQuery, BooleanQuery,
    Occur: { Must: 'MUST', Should: 'SHOULD', MustNot: 'MUST_NOT' },
    Operator: {}, rerankers: {},
  };
});

import { parseBooleanQuery } from '../boolean-query';
import {
  extractFieldFilters,
  resolvePrismaFilters,
  LegalSchemaClient,
} from '../boolean-to-fts';

function parse(input: string) {
  const r = parseBooleanQuery(input);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.ast;
}

function makeClient(opts: {
  cases?: Array<{ id: string }>;
  motions?: Array<{ caseId: string | null }>;
  persons?: Array<{ id: string }>;
} = {}): LegalSchemaClient {
  return {
    case:   { findMany: jest.fn().mockResolvedValue(opts.cases ?? []) },
    motion: { findMany: jest.fn().mockResolvedValue(opts.motions ?? []) },
    person: { findMany: jest.fn().mockResolvedValue(opts.persons ?? []) },
  };
}

describe('unified-pipeline — lance-scalar paths (no Prisma)', () => {
  test('case=="X" AND motion → lance-scalar where + FTS, no Prisma', async () => {
    const ast = parse('case=="X" AND motion');
    const { whereClauses, prismaRequests, ast: stripped } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([`case_number = 'X'`]);
    expect(prismaRequests).toEqual([]);
    expect(stripped).toEqual({ op: 'TERM', value: 'motion', phrase: false });

    const client = makeClient();
    const { whereClauses: more } = await resolvePrismaFilters(prismaRequests, client);
    expect(more).toEqual([]);
    expect(client.case.findMany).not.toHaveBeenCalled();
    expect(client.motion.findMany).not.toHaveBeenCalled();
  });

  test('caseRef==@uuid → scalar case_id = uuid, no Prisma', async () => {
    const ast = parse('caseRef==@deadbeef-1234');
    const { whereClauses, prismaRequests } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([`case_id = 'deadbeef-1234'`]);
    expect(prismaRequests).toEqual([]);
  });

  test('volumeNumber >= 2 → numeric scalar predicate', async () => {
    const ast = parse('volumeNumber>=2');
    const { whereClauses } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([`volume_number >= 2`]);
  });

  test('unknown field "someRandomField==value" degrades, no crash', async () => {
    const ast = parse('someRandomField==value');
    const { whereClauses, prismaRequests, ast: stripped } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([]);
    expect(prismaRequests).toEqual([]);
    expect(stripped).toEqual({
      op: 'TERM', value: 'someRandomField==value', phrase: false,
    });
  });
});

describe('unified-pipeline — prisma-traverse', () => {
  test('case->jurisdiction=="TX" → mock prisma.case.findMany, caseIds pre-filter', async () => {
    const ast = parse('case->jurisdiction=="TX"');
    const { whereClauses, prismaRequests } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([]);
    expect(prismaRequests).toHaveLength(1);
    expect(prismaRequests[0].path).toEqual(['case', 'jurisdiction']);

    const client = makeClient({ cases: [{ id: 'c1' }, { id: 'c2' }] });
    const { whereClauses: more } = await resolvePrismaFilters(prismaRequests, client);
    expect(client.case.findMany).toHaveBeenCalledWith({
      where: { jurisdiction: 'TX' },
      select: { id: true },
    });
    expect(more).toEqual([`case_id IN ('c1', 'c2')`]);
  });

  test('judge==@uuid → alias rewrites to judgeRef → Prisma lookup → caseIds', async () => {
    // `judge` aliases to `judgeRef` in FIELD_ALIASES. Confirm via parser.
    const ast = parse('judge==@p-1');
    // After alias, path is ['judgeRef']; isRef:true; value is 'p-1'.
    const { whereClauses, prismaRequests } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([]);
    expect(prismaRequests).toHaveLength(1);
    expect(prismaRequests[0].path).toEqual(['judgeRef']);
    expect(prismaRequests[0].isRef).toBe(true);
    expect(prismaRequests[0].value).toBe('p-1');

    const client = makeClient({
      motions: [{ caseId: 'c-a' }, { caseId: 'c-b' }, { caseId: 'c-a' }],
    });
    const { whereClauses: more } = await resolvePrismaFilters(prismaRequests, client);
    expect(client.motion.findMany).toHaveBeenCalledWith({
      where: { judgeId: 'p-1' },
      select: { caseId: true },
    });
    expect(more).toEqual([`case_id IN ('c-a', 'c-b')`]);
  });

  test('case->judge->name=="Roberts" → two-hop chain (person → motion → caseIds)', async () => {
    const ast = parse('case->judge->name=="Roberts"');
    const { prismaRequests } = extractFieldFilters(ast);
    expect(prismaRequests).toHaveLength(1);

    const client = makeClient({
      persons: [{ id: 'p-1' }],
      motions: [{ caseId: 'c-1' }, { caseId: 'c-2' }],
    });
    const { whereClauses: more } = await resolvePrismaFilters(prismaRequests, client);
    expect(client.person.findMany).toHaveBeenCalledWith({
      where: { displayName: 'Roberts' },
      select: { id: true },
    });
    expect(client.motion.findMany).toHaveBeenCalledWith({
      where: { judgeId: { in: ['p-1'] } },
      select: { caseId: true },
    });
    expect(more).toEqual([`case_id IN ('c-1', 'c-2')`]);
  });

  test('empty match-set → sentinel predicate (no rows)', async () => {
    const ast = parse('case->jurisdiction=="ZZ"');
    const { prismaRequests } = extractFieldFilters(ast);
    const client = makeClient({ cases: [] });
    const { whereClauses } = await resolvePrismaFilters(prismaRequests, client);
    expect(whereClauses).toEqual([`case_id = '__no_match__'`]);
  });

  test('unknown traversal path (case->unknownField) degrades, no Prisma call', async () => {
    const ast = parse('case->unknownField==X');
    const { whereClauses, prismaRequests, ast: stripped } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([]);
    expect(prismaRequests).toEqual([]);
    expect(stripped).toEqual({
      op: 'TERM', value: 'case->unknownField==X', phrase: false,
    });
  });
});

describe('unified-pipeline — NOT semantics', () => {
  test('NOT case=="X" lifts as case_number != X (single-TERM negation)', async () => {
    const ast = parse('foo AND NOT case=="X"');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([`case_number != 'X'`]);
    // The bare `foo` remains.
    expect(stripped).toEqual({ op: 'TERM', value: 'foo', phrase: false });
  });

  test('NOT (case=="X" AND foo) leaves subtree intact — no SQL lift', async () => {
    // De Morgan's would require ORing SQL with FTS — LanceDB can't.
    // Safer: don't lift anything from inside a NOT-of-compound.
    const ast = parse('bar AND NOT (case=="X" AND foo)');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([]);
    // Stripped AST keeps the NOT-AND intact (the case=="X" leaf becomes a
    // bare text TERM since it wasn't lifted, but the subtree shape stands).
    expect(stripped).not.toBeNull();
    // Crude shape assertion: there's a NOT somewhere in the tree.
    const hasNot = JSON.stringify(stripped).includes('"NOT"');
    expect(hasNot).toBe(true);
  });
});

describe('unified-pipeline — combined paths', () => {
  test('caseRef==@u1 AND case->jurisdiction=="TX" → both lifts, one Prisma call', async () => {
    const ast = parse('caseRef==@u1 AND case->jurisdiction=="TX"');
    const { whereClauses, prismaRequests } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([`case_id = 'u1'`]);
    expect(prismaRequests).toHaveLength(1);

    const client = makeClient({ cases: [{ id: 'c-1' }] });
    const { whereClauses: more } = await resolvePrismaFilters(prismaRequests, client);
    expect(more).toEqual([`case_id IN ('c-1')`]);
  });
});
