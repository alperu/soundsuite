/**
 * list_people — opens `motions-by-person` (REPORT-discovery-tools §4.3).
 *
 * `query_case_graph { operation: 'motions-by-person' }` seeds on a `personId`
 * that nothing enumerated. This is the enumeration, with `motionCount` so a
 * caller can rank by involvement instead of guessing.
 *
 * `local` profile safe: bounded Prisma queries, no LLM, compact rows.
 */

import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { LIST_DEFAULT_LIMIT } from './list-cases';

/** Roles the `Motion` relations model directly — the same set graph-expand takes. */
export type PersonRoleFilter = 'judge' | 'movant' | 'respondent' | 'any';

export interface ListPeopleParams {
  /** Substring over displayName or barNumber. */
  query?: string;
  role?: PersonRoleFilter;
  /** Only people appearing in this case. */
  caseId?: string;
  limit?: number;
}

export interface PersonRoleRow {
  role: string;
  caseId?: string;
  caseNumber?: string;
}

export interface ListPeopleResultItem {
  personId: string;
  displayName: string;
  barNumber?: string;
  jurisdiction?: string;
  roles: PersonRoleRow[];
  /** Distinct motions this person appears in, across all role sources. */
  motionCount: number;
}

export interface ListPeopleResult {
  people: ListPeopleResultItem[];
}

/** The `personRole` marker is the type tag, not a role name — never emitted. */
const ROLE_TYPE_MARKER = 'personRole';

export class ListPeopleTool extends BaseMCPTool<ListPeopleParams, ListPeopleResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'list_people',
      displayName: 'List People',
      description:
        'List people with their ids — the seed query_case_graph needs for ' +
        'motions-by-person. Filter by name/bar-number substring, by case, or by role. ' +
        'The role filter matches the motion role relations (judge / movant / respondent); ' +
        'the returned `roles` array additionally reports roles recorded on PersonRole. ' +
        'motionCount is the number of distinct motions the person appears in.',
      version: '1.0.0',
      category: 'entity',
      profiles: ['local', 'routed'],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring over displayName or barNumber.' },
          role: {
            type: 'string',
            enum: ['judge', 'movant', 'respondent', 'any'],
            description: 'Only people holding this motion role (default "any").',
          },
          caseId: { type: 'string', description: 'Only people appearing in this case.' },
          limit: {
            type: 'number',
            description: `Maximum people to return (default ${LIST_DEFAULT_LIMIT}).`,
          },
        },
        required: [],
      },
    };
  }

  async executeImpl(
    params: ListPeopleParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ListPeopleResult> {
    const { query, role = 'any', caseId, limit = LIST_DEFAULT_LIMIT } = params ?? {};
    // SQLite has no case-insensitive `mode`; lowercase + `contains`.
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const db = context.database as any;

    context.logger.info('Handling list_people', { hasQuery: !!q, role, caseId, limit });

    // Motion ids in scope, needed both for the caseId filter (PersonRole is
    // polymorphic, so a motion-scoped role cannot be joined in SQL) and for
    // resolving motion-scoped roles back to a case below.
    let caseMotionIds: string[] = [];
    if (caseId) {
      const ms = await db.motion.findMany({ where: { caseId }, select: { id: true } });
      caseMotionIds = (ms ?? []).map((m: any) => m.id);
    }

    const and: any[] = [];
    if (q) {
      and.push({ OR: [{ displayName: { contains: q } }, { barNumber: { contains: q } }] });
    }
    if (caseId) {
      and.push({
        OR: [
          { motionsAsJudge: { some: { caseId } } },
          { motionsAsMovant: { some: { caseId } } },
          { motionsAsRespondent: { some: { caseId } } },
          { roles: { some: { scopeKind: 'case', scopeId: caseId } } },
          ...(caseMotionIds.length
            ? [{ roles: { some: { scopeKind: 'motion', scopeId: { in: caseMotionIds } } } }]
            : []),
        ],
      });
    }
    if (role !== 'any') {
      const relation =
        role === 'judge' ? 'motionsAsJudge' : role === 'movant' ? 'motionsAsMovant' : 'motionsAsRespondent';
      and.push({ [relation]: { some: caseId ? { caseId } : {} } });
    }

    const motionSelect = {
      select: { id: true, caseId: true, case: { select: { caseNumber: true } } },
    };

    // Take the page of people first, then count only those — counting before
    // limiting would scan the whole table for rows nobody asked for.
    const people = await db.person.findMany({
      where: and.length ? { AND: and } : {},
      select: {
        id: true,
        displayName: true,
        barNumber: true,
        jurisdiction: { select: { name: true } },
        motionsAsJudge: motionSelect,
        motionsAsMovant: motionSelect,
        motionsAsRespondent: motionSelect,
        roles: { select: { scopeKind: true, scopeId: true, tags: true } },
      },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    // Resolve motion-scoped PersonRole rows to their case in one batched query.
    const scopedMotionIds = new Set<string>();
    for (const p of people ?? []) {
      for (const r of p.roles ?? []) {
        if (r.scopeKind === 'motion' && r.scopeId) scopedMotionIds.add(r.scopeId);
      }
    }
    const motionCase = new Map<string, { caseId?: string; caseNumber?: string }>();
    if (scopedMotionIds.size > 0) {
      const ms = await db.motion.findMany({
        where: { id: { in: Array.from(scopedMotionIds) } },
        select: { id: true, caseId: true, case: { select: { caseNumber: true } } },
      });
      for (const m of ms ?? []) {
        motionCase.set(m.id, { caseId: m.caseId ?? undefined, caseNumber: m.case?.caseNumber ?? undefined });
      }
    }

    const rows: ListPeopleResultItem[] = (people ?? []).map((p: any) => {
      const roles = new Map<string, PersonRoleRow>();
      // Distinct motion ids across every role source — a person who is both
      // movant and carries a PersonRole on the same motion counts once.
      const motionIds = new Set<string>();

      const addRelation = (list: any[], name: string) => {
        for (const m of list ?? []) {
          if (m?.id) motionIds.add(m.id);
          const row: PersonRoleRow = {
            role: name,
            ...(m?.caseId ? { caseId: m.caseId } : {}),
            ...(m?.case?.caseNumber ? { caseNumber: m.case.caseNumber } : {}),
          };
          roles.set(`${row.role}|${row.caseId ?? ''}`, row);
        }
      };
      addRelation(p.motionsAsJudge, 'judge');
      addRelation(p.motionsAsMovant, 'movant');
      addRelation(p.motionsAsRespondent, 'respondent');

      for (const r of p.roles ?? []) {
        if (r.scopeKind === 'motion' && r.scopeId) motionIds.add(r.scopeId);
        const scope =
          r.scopeKind === 'case'
            ? { caseId: r.scopeId as string | undefined, caseNumber: undefined as string | undefined }
            : motionCase.get(r.scopeId) ?? {};
        for (const name of roleNamesFromTags(r.tags)) {
          const row: PersonRoleRow = {
            role: name,
            ...(scope.caseId ? { caseId: scope.caseId } : {}),
            ...(scope.caseNumber ? { caseNumber: scope.caseNumber } : {}),
          };
          roles.set(`${row.role}|${row.caseId ?? ''}`, row);
        }
      }

      return {
        personId: p.id,
        displayName: p.displayName,
        ...(p.barNumber ? { barNumber: p.barNumber } : {}),
        ...(p.jurisdiction?.name ? { jurisdiction: p.jurisdiction.name } : {}),
        roles: Array.from(roles.values()).sort((a, b) =>
          a.role === b.role ? (a.caseId ?? '').localeCompare(b.caseId ?? '') : a.role.localeCompare(b.role),
        ),
        motionCount: motionIds.size,
      };
    });

    context.logger.info('list_people completed', { resultCount: rows.length });
    return { people: rows };
  }
}

/**
 * Role names carried in a PersonRole tag bag. Tags are Haystack-style markers
 * (`{ personRole: true, movant: true }`); the type marker itself is not a role.
 */
function roleNamesFromTags(tags: unknown): string[] {
  let bag: Record<string, unknown> | undefined;
  if (typeof tags === 'string') {
    try {
      bag = JSON.parse(tags);
    } catch {
      return [];
    }
  } else if (tags && typeof tags === 'object') {
    bag = tags as Record<string, unknown>;
  }
  if (!bag) return [];
  return Object.keys(bag)
    .filter((k) => k !== ROLE_TYPE_MARKER && !!bag![k])
    .sort();
}
