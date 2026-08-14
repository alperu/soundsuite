/**
 * Compile a graph-editor scope selection into a LanceDB pre-filter clause.
 *
 * The vector store AND-joins every entry of `filter._rawWhere`, so a scope
 * spanning several cases and filings must compile to exactly ONE clause with
 * the arms OR'd inside it. Emitting one clause per id would intersect them and
 * match nothing.
 *
 * Fully-selected cases go in the `case_id` arm (so filings indexed later are
 * automatically in scope, and the handful of indexed documents that hang off
 * no Filing stay reachable); partially-selected cases contribute the ids of
 * their selected filings to the `filing_id` arm.
 */

export interface ScopeSelection {
  caseIds: string[];
  filingIds: string[];
}

/** LanceDB SQL uses doubled single quotes for a literal quote. */
function sqlList(ids: string[]): string {
  return ids.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
}

/**
 * Returns `[]` for an empty selection (caller should then send no filter at
 * all, not an always-false clause), otherwise a single-element array holding
 * the union clause.
 */
export function scopeToWhereClauses(scope: ScopeSelection): string[] {
  const caseIds = (scope?.caseIds ?? []).filter(Boolean);
  const filingIds = (scope?.filingIds ?? []).filter(Boolean);
  if (caseIds.length === 0 && filingIds.length === 0) return [];

  const arms: string[] = [];
  if (caseIds.length > 0) arms.push(`case_id IN (${sqlList(caseIds)})`);
  if (filingIds.length > 0) arms.push(`filing_id IN (${sqlList(filingIds)})`);

  return [`(${arms.join(' OR ')})`];
}
