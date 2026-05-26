// Field-qualified term extraction → LanceDB scalar where-clauses.
//
// Verifies that the AST→FTS pre-pass:
//   1. Lifts field terms whose ancestors are all-AND into SQL where-clauses
//   2. Falls back to bare text match for unknown fields (with a warn)
//   3. Falls back to bare text match for field terms under an OR ancestor
//      (with a warn)
//   4. Returns a usable rewritten AST with the lifted leaves removed

// Local logger mock: the global jest.setup.js mock omits the `logger` named
// export, so we re-mock here to provide a jest.fn we can spy on.
jest.mock('@/lib/logger', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
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
    MatchQuery,
    PhraseQuery,
    BooleanQuery,
    Occur: { Must: 'MUST', Should: 'SHOULD', MustNot: 'MUST_NOT' },
    Operator: {},
    rerankers: {},
  };
});

import { parseBooleanQuery } from '../boolean-query';
import { astToLanceQuery, extractFieldFilters, FIELD_RESOLVERS } from '../boolean-to-fts';
import { MatchQuery, BooleanQuery } from '../../vector/vector-store';
import { logger } from '@/lib/logger';

function parse(input: string) {
  const r = parseBooleanQuery(input);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.ast;
}

describe('FIELD_RESOLVERS map (schema audit)', () => {
  test('case → case_number column', () => {
    expect(FIELD_RESOLVERS.case).toEqual({ kind: 'lance-scalar', column: 'case_number' });
  });
  test('caseId → case_id, motionType → document_type (alias)', () => {
    const caseId = FIELD_RESOLVERS.caseId;
    const motionType = FIELD_RESOLVERS.motionType;
    if (caseId.kind !== 'lance-scalar' || motionType.kind !== 'lance-scalar') {
      throw new Error('expected lance-scalar kind');
    }
    expect(caseId.column).toBe('case_id');
    expect(motionType.column).toBe('document_type');
  });
  test('every resolver is one of the supported kinds (#54 adds ref/traverse)', () => {
    for (const r of Object.values(FIELD_RESOLVERS)) {
      expect(['lance-scalar', 'lance-scalar-ref', 'prisma-traverse']).toContain(r.kind);
    }
  });
});

describe('extractFieldFilters — AND-only ancestors', () => {
  test('case==23-CV-1234 AND motion → where + MatchQuery', () => {
    const ast = parse('case==23-CV-1234 AND motion');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    void 0; // shape extended with prismaRequests in #54 — see unified-pipeline test
    expect(whereClauses).toEqual([`case_number = '23-CV-1234'`]);
    // stripped AST is just the bare term `motion`
    expect(stripped).toEqual({ op: 'TERM', value: 'motion', phrase: false });
    // And we can still hand it to astToLanceQuery
    const fq = astToLanceQuery(stripped!) as any;
    expect(fq).toBeInstanceOf(MatchQuery);
    expect(fq.q).toBe('motion');
    expect(fq.field).toBe('text');
  });

  test('motionType==disqualification (lone) → where + null AST', () => {
    const ast = parse('motionType==disqualification');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    void 0; // shape extended with prismaRequests in #54 — see unified-pipeline test
    expect(whereClauses).toEqual([`document_type = 'disqualification'`]);
    expect(stripped).toBeNull();
  });

  test("phrase field value: case==\"motion to compel\" AND granted", () => {
    const ast = parse('case=="motion to compel" AND granted');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    void 0; // shape extended with prismaRequests in #54 — see unified-pipeline test
    expect(whereClauses).toEqual([`case_number = 'motion to compel'`]);
    expect(stripped).toEqual({ op: 'TERM', value: 'granted', phrase: false });
  });

  test('two AND-ed field terms → two where clauses', () => {
    const ast = parse('case==X AND filingType==RR');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    void 0; // shape extended with prismaRequests in #54 — see unified-pipeline test
    expect(whereClauses).toEqual([
      `case_number = 'X'`,
      `filing_type = 'RR'`,
    ]);
    expect(stripped).toBeNull();
  });

  test("SQL injection guard: case==O'Hara", () => {
    const ast = parse("case==O'Hara");
    const { whereClauses } = extractFieldFilters(ast);
    expect(whereClauses).toEqual([`case_number = 'O''Hara'`]);
  });
});

describe('extractFieldFilters — unknown fields fall back', () => {
  beforeEach(() => {
    (logger.warn as jest.Mock).mockClear?.();
  });

  test('purple==cow → bare text match against canonical literal "purple==cow"', () => {
    const ast = parse('purple==cow');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    void 0; // shape extended with prismaRequests in #54 — see unified-pipeline test
    expect(whereClauses).toEqual([]);
    // Degraded literal uses canonical Axon `==` (legacy `:` was normalized
    // at tokenize time — there's no longer a way to recover the original).
    expect(stripped).toEqual({ op: 'TERM', value: 'purple==cow', phrase: false });
    // Logger warned at least once
    expect((logger.warn as jest.Mock).mock?.calls?.length ?? 0).toBeGreaterThanOrEqual(1);
    // Downstream: feeding to astToLanceQuery yields a MatchQuery on `text`
    const fq = astToLanceQuery(stripped!) as any;
    expect(fq).toBeInstanceOf(MatchQuery);
    expect(fq.q).toBe('purple==cow');
    expect(fq.field).toBe('text');
  });
});

describe('extractFieldFilters — OR-ancestor degradation', () => {
  beforeEach(() => {
    (logger.warn as jest.Mock).mockClear?.();
  });

  test('case==X OR keyword → field term degraded to bare text (logged)', () => {
    const ast = parse('case==X OR keyword');
    const { whereClauses, ast: stripped } = extractFieldFilters(ast);
    void 0; // shape extended with prismaRequests in #54 — see unified-pipeline test
    expect(whereClauses).toEqual([]);
    // The OR is preserved; the field term became a bare "case==X" text match
    // (canonical Axon — `:` was normalized away at tokenize time).
    expect(stripped).toEqual({
      op: 'OR',
      children: [
        { op: 'TERM', value: 'case==X', phrase: false },
        { op: 'TERM', value: 'keyword', phrase: false },
      ],
    });
    expect((logger.warn as jest.Mock).mock?.calls?.length ?? 0).toBeGreaterThanOrEqual(1);

    // The rewritten AST still converts to a BooleanQuery cleanly.
    const fq = astToLanceQuery(stripped!) as any;
    expect(fq).toBeInstanceOf(BooleanQuery);
    expect(fq.clauses.map((c: any) => c[0])).toEqual(['SHOULD', 'SHOULD']);
  });
});
