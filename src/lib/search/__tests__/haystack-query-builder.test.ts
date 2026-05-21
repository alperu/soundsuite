import {
  buildHaystackFilter,
  parseChipString,
  personFilterForToken,
  FilterChip,
} from '../haystack-query-builder';

describe('buildHaystackFilter', () => {
  it('compiles judge + motionType chips into a motion filter', () => {
    const chips: FilterChip[] = [
      { key: 'judge', value: '@person-roberts' },
      { key: 'motionType', value: 'disqualify' },
    ];
    const result = buildHaystackFilter(chips);
    expect(result.filter).toBe(
      'motion and judgeRef==@person-roberts and motionType=="disqualify"',
    );
    expect(result.impliedKind).toBe('motion');
  });

  it('handles a refRef value that lacks a leading @', () => {
    const result = buildHaystackFilter([{ key: 'judge', value: 'person-roberts' }]);
    expect(result.filter).toBe('motion and judgeRef==@person-roberts');
  });

  it('emits a date range using >= and <= for hearingDate', () => {
    const result = buildHaystackFilter([
      { key: 'hearingDate', value: '2026-06-01..2026-06-30' },
    ]);
    expect(result.filter).toBe(
      'motion and hearingDate>=2026-06-01 and hearingDate<=2026-06-30',
    );
  });

  it('uses >= for filedAfter and <= for filedBefore', () => {
    const result = buildHaystackFilter([
      { key: 'filedAfter', value: '2026-01-01' },
      { key: 'filedBefore', value: '2026-12-31' },
    ]);
    expect(result.filter).toBe(
      'motionEvent and courtFilingDate>=2026-01-01 and courtFilingDate<=2026-12-31',
    );
  });

  it('returns empty filter for empty chips', () => {
    const result = buildHaystackFilter([]);
    expect(result.filter).toBe('');
    expect(result.freetext).toBe('');
  });

  it('passes through freetext alongside chips', () => {
    const result = buildHaystackFilter(
      [{ key: 'judge', value: '@person-roberts' }],
      '  bias and prior rulings  ',
    );
    expect(result.filter).toBe('motion and judgeRef==@person-roberts');
    expect(result.freetext).toBe('bias and prior rulings');
  });

  it('ANDs multiple chips of the same key inside parens', () => {
    const result = buildHaystackFilter([
      { key: 'movant', value: '@person-alper' },
      { key: 'movant', value: '@person-jane' },
    ]);
    expect(result.filter).toBe(
      'motion and (movantRef==@person-alper and movantRef==@person-jane)',
    );
  });

  it('drops implied kind on conflict', () => {
    const result = buildHaystackFilter([
      { key: 'judge', value: '@person-roberts' }, // impliedKind: motion
      { key: 'kind', value: 'filed' }, // impliedKind: motionEvent
    ]);
    // No implied kind because the two chips disagree
    expect(result.impliedKind).toBeUndefined();
    expect(result.filter).toBe('judgeRef==@person-roberts and kind=="filed"');
  });

  it('compiles a kind chip into a motionEvent filter', () => {
    const result = buildHaystackFilter([{ key: 'kind', value: 'signed' }]);
    expect(result.filter).toBe('motionEvent and kind=="signed"');
  });

  it('handles revisionSeq as a raw number', () => {
    const result = buildHaystackFilter([{ key: 'revisionSeq', value: '3' }]);
    expect(result.filter).toBe('revisionSeq==3');
  });
});

describe('parseChipString', () => {
  it('parses key:value tokens and freetext', () => {
    const { chips, freetext } = parseChipString(
      'judge:@person-roberts motionType:disqualify bias',
    );
    expect(chips).toEqual([
      { key: 'judge', value: '@person-roberts' },
      { key: 'motionType', value: 'disqualify' },
    ]);
    expect(freetext).toBe('bias');
  });

  it('parses quoted values', () => {
    const { chips } = parseChipString('motionType:"summary judgment"');
    expect(chips).toEqual([{ key: 'motionType', value: 'summary judgment' }]);
  });

  it('passes through unknown keys as freetext', () => {
    const { chips, freetext } = parseChipString('bogus:foo bar');
    expect(chips).toEqual([]);
    expect(freetext).toContain('bogus:foo');
    expect(freetext).toContain('bar');
  });
});

describe('personFilterForToken', () => {
  it('returns role-scoped person filters', () => {
    expect(personFilterForToken('judge')).toBe('person and judge');
    expect(personFilterForToken('lawyer')).toBe('person and lawyer');
    expect(personFilterForToken('clerk')).toBe('person and courtClerk');
    expect(personFilterForToken('reporter')).toBe('person and courtReporter');
    expect(personFilterForToken('movant')).toBe('person');
    expect(personFilterForToken('hearingDate')).toBeNull();
  });
});
