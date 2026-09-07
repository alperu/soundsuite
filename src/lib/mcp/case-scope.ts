/**
 * Shared case-scope resolution for the case-scoped tools
 * (docs/tasks/12-multi-case-scoping-and-param-typing.md, items 2 and 4).
 *
 * One place decides what `caseId` / `caseIds` mean so the four call sites
 * (`scan_for_pattern`, `query_case_knowledge`, `query_case_graph`,
 * `research_evidence` / `research_start`) cannot drift:
 *
 *  - `caseId` and `caseIds` are mutually exclusive — sending both is a
 *    contradiction, not a merge.
 *  - every id is checked to exist in ONE `case.findMany`, whatever the list
 *    length. A typo used to return 200 with zero results, which is
 *    indistinguishable from "this case contains nothing".
 *
 * Runtime *types* are not checked here — `BaseMCPTool.validateParamTypes`
 * already rejects `caseId: []` / `caseIds: "x"` from the declared schema
 * before `executeImpl` runs. This module only sees well-typed values.
 */

import type { PrismaClient } from '@prisma/client';
import { McpError } from './llm-policy';

export interface CaseScope {
  /** Single-case scope, when the caller sent `caseId`. */
  caseId?: string;
  /** Multi-case scope, when the caller sent `caseIds` (deduped, non-empty). */
  caseIds?: string[];
}

export interface CaseScopeInput {
  caseId?: unknown;
  caseIds?: unknown;
}

/** Names used in error text, so `query_case_graph` can say `caseScope`. */
export interface CaseScopeNames {
  single?: string;
  multi?: string;
}

/** Every id the scope covers, in caller order. Empty = unscoped. */
export function caseScopeIds(scope: CaseScope): string[] {
  if (scope.caseIds && scope.caseIds.length > 0) return scope.caseIds;
  return scope.caseId ? [scope.caseId] : [];
}

/**
 * The retrieval-filter fragment for a scope. `caseIds` wins when present —
 * `buildWhereClause` branches on it first and never ANDs the two, which would
 * be unsatisfiable.
 */
export function caseScopeFilter(scope: CaseScope): Record<string, unknown> {
  if (scope.caseIds && scope.caseIds.length > 0) return { caseIds: [...scope.caseIds] };
  if (scope.caseId) return { caseId: scope.caseId };
  return {};
}

/**
 * Normalise + validate `{ caseId, caseIds }` and confirm every id exists.
 *
 * Throws `McpError('INVALID_PARAMS')` for: both fields given, an empty
 * `caseIds`, a blank id, or an id with no Case row.
 */
export async function resolveCaseScope(
  params: CaseScopeInput | undefined,
  database: PrismaClient | undefined,
  names: CaseScopeNames = {},
): Promise<CaseScope> {
  const single = names.single ?? 'caseId';
  const multi = names.multi ?? 'caseIds';
  const p = params ?? {};

  const hasSingle = typeof p.caseId === 'string' && p.caseId.trim().length > 0;
  const hasMulti = Array.isArray(p.caseIds);

  if (hasSingle && hasMulti) {
    throw new McpError(
      'INVALID_PARAMS',
      `${single} and ${multi} are mutually exclusive — send ${single} for one case or ${multi} for a subset, not both`,
    );
  }

  let ids: string[];
  if (hasMulti) {
    const raw = p.caseIds as unknown[];
    if (raw.length === 0) {
      throw new McpError('INVALID_PARAMS', `${multi} must contain at least one case id`);
    }
    const trimmed = raw.map((v) => (typeof v === 'string' ? v.trim() : ''));
    if (trimmed.some((v) => !v)) {
      throw new McpError('INVALID_PARAMS', `${multi} entries must be non-empty case ids`);
    }
    ids = [...new Set(trimmed)];
  } else if (hasSingle) {
    ids = [(p.caseId as string).trim()];
  } else {
    return {};
  }

  await assertCasesExist(ids, database, single);

  return hasMulti ? { caseIds: ids } : { caseId: ids[0] };
}

/**
 * One query for the whole list. Skipped when the injected client has no
 * `case.findMany` (older test doubles) — production Prisma always does.
 */
export async function assertCasesExist(
  ids: string[],
  database: PrismaClient | undefined,
  label = 'caseId',
): Promise<void> {
  if (ids.length === 0) return;
  const findMany = (database as any)?.case?.findMany;
  if (typeof findMany !== 'function') return;

  const rows: Array<{ id: string }> = await (database as any).case.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new McpError(
      'INVALID_PARAMS',
      `case not found: ${missing.map((id) => `"${id}"`).join(', ')}` +
        ` — call list_cases for valid ${label} values`,
    );
  }
}
