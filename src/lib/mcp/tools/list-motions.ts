/**
 * list_motions — opens the graph (REPORT-discovery-tools §4.2).
 *
 * `query_case_graph` has three operations and two of them seed on a
 * `motionId` that nothing enumerated. That is why the tool shows zero
 * executions: not "untested", *uncallable*. This is the enumeration.
 *
 * `hasAmendments` is the point of the tool — it is the natural entry to
 * `amendment-lineage`, the strongest question the graph answers.
 *
 * `local` profile safe: one indexed Prisma query, no LLM, compact rows.
 */

import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import { LIST_DEFAULT_LIMIT } from './list-cases';

export interface ListMotionsParams {
  caseId?: string;
  /** Substring over motion title. */
  query?: string;
  /** Only motions with children or amends/supersedes pointers. */
  hasAmendments?: boolean;
  limit?: number;
}

export interface ListMotionsResultItem {
  motionId: string;
  title: string;
  caseId?: string;
  caseNumber?: string;
  startPage: number;
  endPage?: number;
  filingId: string;
  parentMotionId?: string;
  amendsId?: string;
  supersedesId?: string;
  revisionSeq?: number;
  /** Only set when the motion's filing maps to exactly one document. */
  documentId?: string;
}

export interface ListMotionsResult {
  motions: ListMotionsResultItem[];
}

export class ListMotionsTool extends BaseMCPTool<ListMotionsParams, ListMotionsResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'list_motions',
      displayName: 'List Motions',
      description:
        'List motions with their ids — the seed query_case_graph needs for ' +
        'amendment-lineage and related-motions. Filter by case, title substring, or ' +
        'hasAmendments (motions that have children or amends/supersedes pointers), which ' +
        'is the natural entry point to amendment lineage.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: {
        type: 'object',
        properties: {
          caseId: { type: 'string', description: 'Only motions in this case (see list_cases).' },
          query: { type: 'string', description: 'Substring over motion title.' },
          hasAmendments: {
            type: 'boolean',
            description:
              'Only motions with child motions or an amendsId / supersedesId pointer.',
          },
          limit: {
            type: 'number',
            description: `Maximum motions to return (default ${LIST_DEFAULT_LIMIT}).`,
          },
        },
        required: [],
      },
    };
  }

  async executeImpl(
    params: ListMotionsParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ListMotionsResult> {
    const { caseId, query, hasAmendments, limit = LIST_DEFAULT_LIMIT } = params ?? {};
    // SQLite has no case-insensitive `mode`; lowercase + `contains`.
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';

    context.logger.info('Handling list_motions', { caseId, hasQuery: !!q, hasAmendments, limit });

    const where: any = {};
    if (caseId) where.caseId = caseId;
    if (q) where.title = { contains: q };
    if (hasAmendments) {
      // One query, not an include + post-filter: Prisma cannot filter on
      // `_count`, but it can express "has at least one child" as a relation
      // filter, which keeps this a single indexed round trip.
      where.OR = [
        { childMotions: { some: {} } },
        { amendsId: { not: null } },
        { supersedesId: { not: null } },
      ];
    }

    const motions = await (context.database as any).motion.findMany({
      where,
      select: {
        id: true,
        title: true,
        caseId: true,
        startPage: true,
        endPage: true,
        filingId: true,
        parentMotionId: true,
        amendsId: true,
        supersedesId: true,
        revisionSeq: true,
        case: { select: { caseNumber: true } },
        filing: { select: { documents: { select: { id: true } } } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
    });

    const rows: ListMotionsResultItem[] = (motions ?? []).map((m: any) => {
      // `Filing.documents` is an array. Set documentId only when the mapping is
      // unambiguous — silently picking the first would reintroduce exactly the
      // false-positive class this task exists to remove.
      const docs: Array<{ id: string }> = m.filing?.documents ?? [];
      return {
        motionId: m.id,
        title: m.title,
        ...(m.caseId ? { caseId: m.caseId } : {}),
        ...(m.case?.caseNumber ? { caseNumber: m.case.caseNumber } : {}),
        startPage: m.startPage,
        ...(typeof m.endPage === 'number' ? { endPage: m.endPage } : {}),
        filingId: m.filingId,
        ...(m.parentMotionId ? { parentMotionId: m.parentMotionId } : {}),
        ...(m.amendsId ? { amendsId: m.amendsId } : {}),
        ...(m.supersedesId ? { supersedesId: m.supersedesId } : {}),
        ...(typeof m.revisionSeq === 'number' ? { revisionSeq: m.revisionSeq } : {}),
        ...(docs.length === 1 ? { documentId: docs[0].id } : {}),
      };
    });

    context.logger.info('list_motions completed', { resultCount: rows.length });
    return { motions: rows };
  }
}
