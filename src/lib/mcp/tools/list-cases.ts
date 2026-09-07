/**
 * list_cases — the unblocker (REPORT-discovery-tools §4.1).
 *
 * Four analysis tools require a `caseId` and, before this, nothing on the MCP
 * surface handed one out: retrieval returns `caseNumber` (the docket number a
 * human reads) and the tools want the database id. This is the enumeration
 * that closes the gap.
 *
 * `local` profile safe: one indexed Prisma query, no LLM, compact rows.
 */

import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';

export interface ListCasesParams {
  /** Substring filter over name / caseNumber / jurisdiction, or an exact caseNumber. */
  query?: string;
  limit?: number;
}

export interface ListCasesResultItem {
  caseId: string;
  name: string;
  caseNumber?: string;
  jurisdiction?: string;
  county?: string;
  state?: string;
  totalDocuments: number;
  createdAt: string;
}

export interface ListCasesResult {
  cases: ListCasesResultItem[];
}

export const LIST_DEFAULT_LIMIT = 25;

export class ListCasesTool extends BaseMCPTool<ListCasesParams, ListCasesResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'list_cases',
      displayName: 'List Cases',
      description:
        'List indexed cases with their ids. Call this first when a tool needs a caseId — ' +
        'retrieval results carry caseNumber (the docket number), not the caseId that ' +
        'detect_contradictions, track_claim_evolution, analyze_citations and ' +
        'reconstruct_timeline require. Optionally filter by name, caseNumber or jurisdiction.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Optional filter over name, caseNumber and jurisdiction. An exact caseNumber ' +
              'is matched first, so the docket number seen in evidence is a direct lookup key.',
          },
          limit: {
            type: 'number',
            description: `Maximum cases to return (default ${LIST_DEFAULT_LIMIT}).`,
          },
        },
        required: [],
      },
    };
  }

  async executeImpl(
    params: ListCasesParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ListCasesResult> {
    const { query, limit = LIST_DEFAULT_LIMIT } = params ?? {};
    const raw = typeof query === 'string' ? query.trim() : '';

    context.logger.info('Handling list_cases', { hasQuery: !!raw, limit });

    // caseNumber fast path — exact match on the trimmed input first. This is
    // what appears in evidence, so it is the natural lookup key. Live rows can
    // carry trailing whitespace (see GET /api/cases), hence the `contains`
    // fallback below rather than an exact-only match.
    if (raw) {
      const exact = await context.database.case.findMany({
        where: { caseNumber: raw },
        include: { documents: { select: { id: true } } },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      if (exact.length > 0) {
        return { cases: exact.map(toCaseRow) };
      }
    }

    // SQLite has no case-insensitive `mode` — lowercase and use `contains`,
    // the same approach as search_workflows.
    const q = raw.toLowerCase();
    const where = raw
      ? {
          OR: [
            { name: { contains: q } },
            { caseNumber: { contains: q } },
            { jurisdiction: { contains: q } },
          ],
        }
      : {};

    const cases = await context.database.case.findMany({
      where,
      include: { documents: { select: { id: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    context.logger.info('list_cases completed', { resultCount: cases.length });
    return { cases: cases.map(toCaseRow) };
  }
}

function toCaseRow(c: any): ListCasesResultItem {
  return {
    caseId: c.id,
    name: c.name,
    ...(c.caseNumber ? { caseNumber: c.caseNumber } : {}),
    ...(c.jurisdiction ? { jurisdiction: c.jurisdiction } : {}),
    ...(c.county ? { county: c.county } : {}),
    ...(c.state ? { state: c.state } : {}),
    totalDocuments: Array.isArray(c.documents) ? c.documents.length : 0,
    createdAt:
      c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt ?? ''),
  };
}
