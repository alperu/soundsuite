import { parseBooleanQuery, astSerialize, Node } from '../boolean-query';

function ok(input: string) {
  const r = parseBooleanQuery(input);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error} @ ${r.position}`);
  return r;
}
function term(value: string, phrase = false): Node { return { op: 'TERM', value, phrase }; }

describe('parseBooleanQuery — basic terms', () => {
  test('1. empty string → empty AND, no operators', () => {
    const r = parseBooleanQuery('');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hasOperators).toBe(false);
      expect(r.ast).toEqual({ op: 'AND', children: [] });
    }
  });

  test('2. whitespace only → empty AND', () => {
    const r = parseBooleanQuery('   \t\n  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toEqual({ op: 'AND', children: [] });
  });

  test('3. single keyword → single TERM, no operators', () => {
    const r = ok('motion');
    expect(r.hasOperators).toBe(false);
    expect(r.ast).toEqual(term('motion'));
  });

  test('4. single keyword with surrounding whitespace', () => {
    const r = ok('  motion  ');
    expect(r.ast).toEqual(term('motion'));
  });

  test('5. two adjacent bare terms → implicit AND', () => {
    const r = ok('motion compel');
    expect(r.hasOperators).toBe(false);
    expect(r.ast).toEqual({ op: 'AND', children: [term('motion'), term('compel')] });
  });

  test('6. three adjacent terms → implicit AND chain', () => {
    const r = ok('a b c');
    expect(r.ast).toEqual({ op: 'AND', children: [term('a'), term('b'), term('c')] });
  });
});

describe('parseBooleanQuery — operators', () => {
  test('7. explicit AND', () => {
    const r = ok('motion AND compel');
    expect(r.hasOperators).toBe(true);
    expect(r.ast).toEqual({ op: 'AND', children: [term('motion'), term('compel')] });
  });

  test('8. lowercase and', () => {
    const r = ok('motion and compel');
    expect(r.hasOperators).toBe(true);
    expect(r.ast).toEqual({ op: 'AND', children: [term('motion'), term('compel')] });
  });

  test('9. explicit OR', () => {
    const r = ok('appeal OR petition');
    expect(r.hasOperators).toBe(true);
    expect(r.ast).toEqual({ op: 'OR', children: [term('appeal'), term('petition')] });
  });

  test('10. lowercase or', () => {
    const r = ok('appeal or petition');
    expect(r.ast).toEqual({ op: 'OR', children: [term('appeal'), term('petition')] });
  });

  test('11. AND tighter than OR', () => {
    // A AND B OR C → (A AND B) OR C
    const r = ok('A AND B OR C');
    expect(r.ast).toEqual({
      op: 'OR',
      children: [{ op: 'AND', children: [term('A'), term('B')] }, term('C')],
    });
  });

  test('12. OR-AND-OR precedence', () => {
    // A OR B AND C OR D → A OR (B AND C) OR D
    const r = ok('A OR B AND C OR D');
    expect(r.ast).toEqual({
      op: 'OR',
      children: [term('A'), { op: 'AND', children: [term('B'), term('C')] }, term('D')],
    });
  });

  test('13. parens override precedence', () => {
    const r = ok('A AND (B OR C)');
    expect(r.ast).toEqual({
      op: 'AND',
      children: [term('A'), { op: 'OR', children: [term('B'), term('C')] }],
    });
  });

  test('14. nested parens', () => {
    const r = ok('((A))');
    expect(r.ast).toEqual(term('A'));
  });

  test('15. parens with implicit AND outside', () => {
    const r = ok('(A OR B) C');
    expect(r.ast).toEqual({
      op: 'AND',
      children: [{ op: 'OR', children: [term('A'), term('B')] }, term('C')],
    });
  });

  test('16. (A AND B) OR C exemplar', () => {
    const r = ok('(A AND B) OR C');
    expect(r.ast).toEqual({
      op: 'OR',
      children: [{ op: 'AND', children: [term('A'), term('B')] }, term('C')],
    });
  });
});

describe('parseBooleanQuery — NOT and dash', () => {
  test('17. NOT word', () => {
    const r = ok('NOT dismissed');
    expect(r.hasOperators).toBe(true);
    expect(r.ast).toEqual({ op: 'NOT', child: term('dismissed') });
  });

  test('18. lowercase not', () => {
    const r = ok('not dismissed');
    expect(r.ast).toEqual({ op: 'NOT', child: term('dismissed') });
  });

  test('19. dash prefix', () => {
    const r = ok('-dismissed');
    expect(r.hasOperators).toBe(true);
    expect(r.ast).toEqual({ op: 'NOT', child: term('dismissed') });
  });

  test('20. dash inside a word is NOT negation', () => {
    const r = ok('case-23');
    expect(r.hasOperators).toBe(false);
    expect(r.ast).toEqual(term('case-23'));
  });

  test('21. AND NOT combination', () => {
    const r = ok('motion AND NOT dismissed');
    expect(r.ast).toEqual({
      op: 'AND',
      children: [term('motion'), { op: 'NOT', child: term('dismissed') }],
    });
  });

  test('22. AND with -dash shorthand', () => {
    const r = ok('motion -dismissed');
    expect(r.ast).toEqual({
      op: 'AND',
      children: [term('motion'), { op: 'NOT', child: term('dismissed') }],
    });
  });

  test('23. double NOT', () => {
    const r = ok('NOT NOT foo');
    expect(r.ast).toEqual({ op: 'NOT', child: { op: 'NOT', child: term('foo') } });
  });

  test('24. NOT in parens', () => {
    const r = ok('A AND (NOT B)');
    expect(r.ast).toEqual({
      op: 'AND',
      children: [term('A'), { op: 'NOT', child: term('B') }],
    });
  });
});

describe('parseBooleanQuery — phrases', () => {
  test('25. simple phrase', () => {
    const r = ok('"motion to compel"');
    expect(r.hasOperators).toBe(true);
    expect(r.ast).toEqual(term('motion to compel', true));
  });

  test('26. phrase with case number', () => {
    const r = ok('"23-CV-1234"');
    expect(r.ast).toEqual(term('23-CV-1234', true));
  });

  test('27. escaped quote in phrase', () => {
    const r = ok('"say \\"hi\\""');
    expect(r.ast).toEqual(term('say "hi"', true));
  });

  test('28. escaped backslash in phrase', () => {
    const r = ok('"a\\\\b"');
    expect(r.ast).toEqual(term('a\\b', true));
  });

  test('29. phrase combined with AND', () => {
    const r = ok('"motion to compel" AND granted');
    expect(r.ast).toEqual({
      op: 'AND',
      children: [term('motion to compel', true), term('granted')],
    });
  });

  test('30. unclosed phrase → error', () => {
    const r = parseBooleanQuery('"open phrase');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.position).toBe(0);
      expect(r.error).toMatch(/Unclosed/);
    }
  });

  test('31. dash inside phrase preserved as literal', () => {
    const r = ok('"-not-negation"');
    expect(r.ast).toEqual(term('-not-negation', true));
  });
});

describe('parseBooleanQuery — operator-like substrings', () => {
  test('32. "Andersen" is not "and ersen"', () => {
    const r = ok('Andersen');
    expect(r.hasOperators).toBe(false);
    expect(r.ast).toEqual(term('Andersen'));
  });

  test('33. "Organizer" is not "Or ganizer"', () => {
    const r = ok('Organizer');
    expect(r.ast).toEqual(term('Organizer'));
  });

  test('34. "north" containing "or" is not OR', () => {
    const r = ok('north south');
    expect(r.hasOperators).toBe(false);
    expect(r.ast).toEqual({ op: 'AND', children: [term('north'), term('south')] });
  });
});

describe('parseBooleanQuery — errors', () => {
  test('35. unbalanced open paren', () => {
    const r = parseBooleanQuery('(A AND B');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.position).toBe(0);
  });

  test('36. unbalanced close paren', () => {
    const r = parseBooleanQuery('A AND B)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unbalanced|trailing/);
  });

  test('37. AND at start invalid', () => {
    const r = parseBooleanQuery('AND foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.position).toBe(0);
  });

  test('38. trailing AND invalid', () => {
    const r = parseBooleanQuery('foo AND');
    expect(r.ok).toBe(false);
  });

  test('39. trailing OR invalid', () => {
    const r = parseBooleanQuery('foo OR');
    expect(r.ok).toBe(false);
  });

  test('40. empty parens invalid', () => {
    const r = parseBooleanQuery('()');
    expect(r.ok).toBe(false);
  });

  test('41. NOT with nothing after', () => {
    const r = parseBooleanQuery('NOT');
    expect(r.ok).toBe(false);
  });

  test('42. dash with nothing after (treated as bare term)', () => {
    // `-` followed by whitespace shouldn't be a DASH op; we treat it as a bare term
    const r = ok('- foo');
    expect(r.ast).toEqual({ op: 'AND', children: [term('-'), term('foo')] });
  });
});

describe('parseBooleanQuery — hasOperators flag', () => {
  test('43. plain keywords → false', () => {
    expect((parseBooleanQuery('foo bar baz') as { ok: true; hasOperators: boolean }).hasOperators).toBe(false);
  });
  test('44. with phrase → true', () => {
    expect((parseBooleanQuery('"foo"') as { ok: true; hasOperators: boolean }).hasOperators).toBe(true);
  });
  test('45. with paren → true', () => {
    expect((parseBooleanQuery('(foo)') as { ok: true; hasOperators: boolean }).hasOperators).toBe(true);
  });
});

describe('astSerialize — round-trip', () => {
  const cases = [
    'foo',
    'foo bar',
    'A AND B',
    'A OR B',
    '(A AND B) OR C',
    'A AND (B OR C)',
    'NOT dismissed',
    'motion AND NOT dismissed',
    '"motion to compel"',
    '"motion to compel" AND granted',
    '(A OR B) AND (C OR D)',
  ];
  for (const c of cases) {
    test(`round-trip: ${c}`, () => {
      const r1 = parseBooleanQuery(c);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const ser = astSerialize(r1.ast);
      const r2 = parseBooleanQuery(ser);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.ast).toEqual(r1.ast);
    });
  }

  test('escaped quote round-trips', () => {
    const r1 = parseBooleanQuery('"say \\"hi\\""');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const ser = astSerialize(r1.ast);
    const r2 = parseBooleanQuery(ser);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.ast).toEqual(r1.ast);
  });
});

describe('parseBooleanQuery — field-qualified terms', () => {
  test('F1. simple field:value', () => {
    const r = ok('motionType:disqualification');
    expect(r.hasOperators).toBe(false);
    expect(r.ast).toEqual({ op: 'TERM', value: 'disqualification', phrase: false, field: 'motionType' });
  });

  test('F2. field:"quoted phrase"', () => {
    const r = ok('case:"23-CV-1234"');
    expect(r.ast).toEqual({ op: 'TERM', value: '23-CV-1234', phrase: true, field: 'case' });
  });

  test('F3. two field terms OR-combined', () => {
    const r = ok('motionType:disqualification OR case:23-CV-1234');
    expect(r.hasOperators).toBe(true);
    expect(r.ast).toEqual({
      op: 'OR',
      children: [
        { op: 'TERM', value: 'disqualification', phrase: false, field: 'motionType' },
        { op: 'TERM', value: '23-CV-1234', phrase: false, field: 'case' },
      ],
    });
  });

  test('F4. trailing colon → parse error', () => {
    const r = parseBooleanQuery('motionType:');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Expected value after field 'motionType:'/);
    }
  });

  test('F5. leading colon → bare term (no field)', () => {
    const r = ok(':bare');
    expect(r.ast).toEqual({ op: 'TERM', value: ':bare', phrase: false });
  });

  test('F6. field term AND -bareNegated', () => {
    const r = ok('motionType:disqualification AND -dismissed');
    expect(r.ast).toEqual({
      op: 'AND',
      children: [
        { op: 'TERM', value: 'disqualification', phrase: false, field: 'motionType' },
        { op: 'NOT', child: term('dismissed') },
      ],
    });
  });

  test('F7. field:"motion to compel" (phrase value)', () => {
    const r = ok('case:"motion to compel"');
    expect(r.ast).toEqual({ op: 'TERM', value: 'motion to compel', phrase: true, field: 'case' });
  });

  test('F8. and:foo is a field term, not an operator', () => {
    const r = ok('and:foo');
    expect(r.hasOperators).toBe(false);
    expect(r.ast).toEqual({ op: 'TERM', value: 'foo', phrase: false, field: 'and' });
  });

  test('F9. caseAnd:foo — ident isn\'t split mid-token', () => {
    const r = ok('caseAnd:foo');
    expect(r.ast).toEqual({ op: 'TERM', value: 'foo', phrase: false, field: 'caseAnd' });
  });

  test('F10. case: "23-CV-1234" (space after colon) → parse error', () => {
    // Chosen behavior: trailing colon followed by whitespace is a parse error
    // (consistent with the bare-trailing-colon rule). Document the choice here.
    const r = parseBooleanQuery('case: "23-CV-1234"');
    expect(r.ok).toBe(false);
  });

  test('F11. single field term → hasOperators=false', () => {
    const r = ok('case:X');
    expect(r.hasOperators).toBe(false);
  });

  test('F12. bare-value case:23-CV-1234 (no quotes)', () => {
    const r = ok('case:23-CV-1234');
    expect(r.ast).toEqual({ op: 'TERM', value: '23-CV-1234', phrase: false, field: 'case' });
  });

  test('F13. field-term round-trips through astSerialize', () => {
    const r1 = parseBooleanQuery('motionType:disqualification OR case:"23-CV-1234"');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const ser = astSerialize(r1.ast);
    const r2 = parseBooleanQuery(ser);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.ast).toEqual(r1.ast);
  });
});

