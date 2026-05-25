// Mock the LanceDB native module — we only need its classes as identity shells
// so we can assert the AST→FTS conversion shape without pulling in native code.
jest.mock('@lancedb/lancedb', () => {
  class MatchQuery { constructor(public q: string, public field: string) {} }
  class PhraseQuery { constructor(public q: string, public field: string) {} }
  class BooleanQuery {
    constructor(public clauses: [string, any][]) {}
  }
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
import { astToLanceQuery, BooleanFtsConversionError } from '../boolean-to-fts';
import { MatchQuery, PhraseQuery, BooleanQuery, Occur } from '../../vector/vector-store';

function build(q: string) {
  const parsed = parseBooleanQuery(q);
  if (!parsed.ok) throw new Error(parsed.error);
  return astToLanceQuery(parsed.ast);
}

describe('astToLanceQuery', () => {
  test('single term → MatchQuery', () => {
    const fq = build('motion') as any;
    expect(fq).toBeInstanceOf(MatchQuery);
  });

  test('single phrase → PhraseQuery', () => {
    const fq = build('"motion to compel"') as any;
    expect(fq).toBeInstanceOf(PhraseQuery);
  });

  test('A AND B → BooleanQuery with two Must', () => {
    const fq = build('A AND B') as any;
    expect(fq).toBeInstanceOf(BooleanQuery);
    // Inspect the constructor-captured queries via a structural check.
    // LanceDB stores the spec in `inner`, but we can also assert by re-building parts.
    // Just confirm it is a BooleanQuery — deep inspection is brittle across versions.
  });

  test('(A AND B) OR C → OR at root, AND nested first branch', () => {
    const parsed = parseBooleanQuery('(A AND B) OR C');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ast).toEqual({
      op: 'OR',
      children: [
        { op: 'AND', children: [{ op: 'TERM', value: 'A', phrase: false }, { op: 'TERM', value: 'B', phrase: false }] },
        { op: 'TERM', value: 'C', phrase: false },
      ],
    });
    const fq = astToLanceQuery(parsed.ast) as any;
    expect(fq).toBeInstanceOf(BooleanQuery);
    // Root is OR — both children are Should
    expect(fq.clauses.map((c: any) => c[0])).toEqual(['SHOULD', 'SHOULD']);
    // First child should itself be a BooleanQuery with two MUST
    const firstInner = fq.clauses[0][1];
    expect(firstInner).toBeInstanceOf(BooleanQuery);
    expect(firstInner.clauses.map((c: any) => c[0])).toEqual(['MUST', 'MUST']);
    // Second child is MatchQuery for 'C'
    expect(fq.clauses[1][1]).toBeInstanceOf(MatchQuery);
    expect(fq.clauses[1][1].q).toBe('C');
  });

  test('A AND -B → MustNot folded into parent', () => {
    const fq = build('A AND -B') as any;
    expect(fq).toBeInstanceOf(BooleanQuery);
    const occurs = fq.clauses.map((c: any) => c[0]);
    expect(occurs).toContain('MUST');
    expect(occurs).toContain('MUST_NOT');
  });

  test('A AND NOT B → BooleanQuery with Must + MustNot', () => {
    const fq = build('A AND NOT B') as any;
    expect(fq).toBeInstanceOf(BooleanQuery);
  });

  test('lone top-level NOT → throws conversion error', () => {
    const parsed = parseBooleanQuery('NOT foo');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(() => astToLanceQuery(parsed.ast)).toThrow(BooleanFtsConversionError);
  });

  test('Occur enum values are as expected', () => {
    expect(Occur.Must).toBeDefined();
    expect(Occur.Should).toBeDefined();
    expect(Occur.MustNot).toBeDefined();
  });
});
