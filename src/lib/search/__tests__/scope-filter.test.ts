import { scopeToWhereClauses } from '../scope-filter';

describe('scopeToWhereClauses', () => {
  it('returns no clause for an empty selection', () => {
    expect(scopeToWhereClauses({ caseIds: [], filingIds: [] })).toEqual([]);
  });

  it('emits only the case arm when no filings are selected', () => {
    expect(scopeToWhereClauses({ caseIds: ['case-1', 'case-2'], filingIds: [] }))
      .toEqual([`(case_id IN ('case-1', 'case-2'))`]);
  });

  it('emits only the filing arm when no cases are selected', () => {
    expect(scopeToWhereClauses({ caseIds: [], filingIds: ['filing-1'] }))
      .toEqual([`(filing_id IN ('filing-1'))`]);
  });

  it('ORs both arms inside a SINGLE clause', () => {
    const clauses = scopeToWhereClauses({
      caseIds: ['case-1'],
      filingIds: ['filing-1', 'filing-2'],
    });
    // One clause, not two: _rawWhere entries AND-join, so a second clause
    // would intersect the arms and match nothing.
    expect(clauses).toHaveLength(1);
    expect(clauses[0]).toBe(
      `(case_id IN ('case-1') OR filing_id IN ('filing-1', 'filing-2'))`,
    );
  });

  it("escapes single quotes by doubling them", () => {
    expect(scopeToWhereClauses({ caseIds: ["o'brien"], filingIds: [] }))
      .toEqual([`(case_id IN ('o''brien'))`]);
  });

  it('ignores empty-string ids', () => {
    expect(scopeToWhereClauses({ caseIds: ['', 'case-1'], filingIds: [''] }))
      .toEqual([`(case_id IN ('case-1'))`]);
  });
});
