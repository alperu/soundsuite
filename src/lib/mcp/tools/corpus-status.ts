/**
 * corpus_status — how much of the corpus is actually searchable (REPORT-v12 §2a, task 23).
 *
 * Every "proven absent" answer this surface produces is proven *of the index*.
 * Before this tool, nothing on the MCP surface answered the question that makes
 * such a claim meaningful: how many documents are indexed, out of how many
 * present? v12 tried to establish it by sampling with scans and could not —
 * rows come back in table order, so a broad scan returns thousands of chunks
 * from a handful of documents.
 *
 * Design notes that are load-bearing rather than incidental:
 *
 *  - `category: 'search'`. `tool-registry.ts` sets `toolNeedsLlm = category !==
 *    'search'`, and under the `local` profile a non-`search` tool requires a
 *    reachable Ollama. A status tool that fails closed on a degraded fleet is
 *    useless in exactly the situation you most want it.
 *
 *  - Status buckets are whatever `groupBy` observes, never an assumed list.
 *    `Document.status` is a bare String with no enum, and the live corpus uses
 *    `DISCOVERED` — which is absent from the four conventional values in the UI
 *    type. A tool built against that list would silently bucket every
 *    un-ingested document as nothing at all.
 *
 *  - Two timestamps, each named for what it measures. `max(Document.updatedAt)`
 *    over-reports (readiness backfill and requeues bump it), so the honest
 *    "last ingest run" is `JobLog.completedAt`. One merged field would be the
 *    same over-claim this tool exists to stop.
 *
 *  - Chunk counts live only in LanceDB. The corpus total is one `countRows()`
 *    and is always paid; per-case counts are N queries and are opt-in. An
 *    unreachable table yields `null` with a reason, never `0` — a caller will
 *    divide by a zero denominator and print something confident.
 */

import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';

/** Only this table is the corpus. `data/lancedb/` also holds ~33 sibling
 *  `chunks_chat_session_*.lance` tables plus `filing-types.lance`. Never glob. */
const CHUNKS_TABLE = 'chunks';

export interface CorpusStatusParams {
  /** Restrict the per-case breakdown to one case. Totals stay corpus-wide. */
  caseId?: string;
  /** Count chunks per case (N LanceDB queries). Corpus total is always returned. */
  includeChunks?: boolean;
}

export interface CorpusStatusCaseRow {
  caseId: string;
  name: string;
  caseNumber?: string;
  documentsTotal: number;
  documentsIndexed: number;
  /** documentsIndexed / documentsTotal, 3 dp. `null` when the case has no documents. */
  coverage: number | null;
  byStatus: Record<string, number>;
  /** Present only with `includeChunks`. `null` when the vector table is unreadable. */
  chunks?: number | null;
}

export interface CorpusStatusResult {
  documents: {
    total: number;
    indexed: number;
    /** Observed status values only — never an assumed list. */
    byStatus: Record<string, number>;
    /**
     * Documents with no pageCount: an ingest-completeness signal in its own right.
     * ALWAYS corpus-wide, like `total` — it is not narrowed by `caseId`, which
     * only scopes the `cases[]` breakdown. Named here rather than left implicit
     * for the same reason the two ingest timestamps are named separately.
     */
    missingPageCount: number;
  };
  /** documentsIndexed / documentsTotal across the whole corpus, 3 dp. */
  corpusCoverage: number | null;
  chunks: {
    total: number | null;
    /** Why `total` is null. Absent when the count succeeded. */
    unavailableReason?: string;
  };
  cases: CorpusStatusCaseRow[];
  ingest: {
    /** Honest "last ingest run" — a completed JobLog. Null when none has completed. */
    lastJobCompletedAt: string | null;
    lastJobDocumentsQueued?: number;
    lastJobDocumentsProcessed?: number;
    lastJobDocumentsFailed?: number;
    /** max(Document.updatedAt). Bumped by backfills and requeues — not an ingest time. */
    lastDocumentUpdatedAt: string | null;
  };
  /** Shape version, so callers can branch without guessing. */
  corpusStatusVersion: number;
}

export const CORPUS_STATUS_VERSION = 1;

function ratio(part: number, whole: number): number | null {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 1000;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

export class CorpusStatusTool extends BaseMCPTool<CorpusStatusParams, CorpusStatusResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'corpus_status',
      displayName: 'Corpus Status',
      description:
        'How much of the corpus is actually searchable: documents total vs indexed, ' +
        'broken down by observed status and by case, plus the corpus chunk count and ' +
        'the last completed ingest run. Call this before relying on any negative finding — ' +
        'a scan proves absence from the INDEX, and this is the denominator that makes ' +
        'such a claim meaningful. Coverage varies sharply per case, so read the per-case ' +
        'figure for the case you are scoped to, not the corpus average. Read-only, no LLM.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: {
        type: 'object',
        properties: {
          caseId: {
            type: 'string',
            description:
              'Restrict the per-case breakdown to this case. Corpus-wide totals are ' +
              'returned regardless, so a scoped answer still knows its own denominator.',
          },
          includeChunks: {
            type: 'boolean',
            description:
              'Also count chunks per case (one vector query per case). The corpus-wide ' +
              'chunk total is returned either way. Default false.',
          },
        },
        required: [],
      },
    };
  }

  async executeImpl(
    params: CorpusStatusParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<CorpusStatusResult> {
    const { caseId, includeChunks = false } = params ?? {};
    context.logger.info('Handling corpus_status', { caseId: !!caseId, includeChunks });

    const db = context.database;

    // --- Documents, by observed status. `status` is a bare String with no
    // enum; grouping is the only shape that cannot drop an unexpected value.
    // The `as any` on groupBy args is Prisma's overload signature, which
    // intersects the argument with `any[]` and rejects a plain object literal.
    const statusGroups: any[] = await db.document.groupBy({
      by: ['status'],
      _count: { _all: true },
    } as any);
    const byStatus: Record<string, number> = {};
    for (const g of statusGroups) {
      byStatus[String(g.status)] = g._count?._all ?? 0;
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const indexed = byStatus.INDEXED ?? 0;

    const missingPageCount = await db.document.count({ where: { pageCount: null } });

    // --- Per case. Grouped in one query, then joined to case rows for names.
    const caseGroups: any[] = await db.document.groupBy({
      by: ['caseId', 'status'],
      _count: { _all: true },
      ...(caseId ? { where: { caseId } } : {}),
    } as any);

    const perCase = new Map<string, Record<string, number>>();
    for (const g of caseGroups) {
      const id = String(g.caseId);
      const bucket = perCase.get(id) ?? {};
      bucket[String(g.status)] = g._count?._all ?? 0;
      perCase.set(id, bucket);
    }

    const caseRows: any[] = await db.case.findMany({
      ...(caseId ? { where: { id: caseId } } : {}),
      select: { id: true, name: true, caseNumber: true },
      orderBy: { createdAt: 'desc' },
    });

    const cases: CorpusStatusCaseRow[] = caseRows.map((c) => {
      const buckets = perCase.get(String(c.id)) ?? {};
      const cTotal = Object.values(buckets).reduce((a, b) => a + b, 0);
      const cIndexed = buckets.INDEXED ?? 0;
      return {
        caseId: String(c.id),
        name: String(c.name ?? ''),
        ...(c.caseNumber ? { caseNumber: String(c.caseNumber) } : {}),
        documentsTotal: cTotal,
        documentsIndexed: cIndexed,
        coverage: ratio(cIndexed, cTotal),
        byStatus: buckets,
      };
    });

    // --- Ingest timestamps. Two fields, two meanings.
    const lastJob: any = await db.jobLog
      .findFirst({
        where: { completedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
      })
      .catch(() => null);

    const docAgg: any = await db.document
      .aggregate({ _max: { updatedAt: true } })
      .catch(() => null);

    // --- Chunks. Never throws, never reports 0 for "unknown".
    const chunks = await countChunks(context, cases, includeChunks, indexed);

    context.logger.info('corpus_status completed', {
      documents: total,
      indexed,
      cases: cases.length,
      chunksKnown: chunks.total !== null,
    });

    return {
      documents: { total, indexed, byStatus, missingPageCount },
      corpusCoverage: ratio(indexed, total),
      chunks: chunks.summary,
      cases,
      ingest: {
        lastJobCompletedAt: iso(lastJob?.completedAt),
        ...(lastJob
          ? {
              lastJobDocumentsQueued: lastJob.documentsQueued ?? 0,
              lastJobDocumentsProcessed: lastJob.documentsProcessed ?? 0,
              lastJobDocumentsFailed: lastJob.documentsFailed ?? 0,
            }
          : {}),
        lastDocumentUpdatedAt: iso(docAgg?._max?.updatedAt),
      },
      corpusStatusVersion: CORPUS_STATUS_VERSION,
    };
  }
}

/**
 * Corpus chunk total, and optionally per-case counts, from the LanceDB `chunks`
 * table. Every failure path yields `null` plus a reason — a zero denominator is
 * worse than an absent one, because a caller will divide by it.
 */
async function countChunks(
  context: ToolExecutionContext,
  cases: CorpusStatusCaseRow[],
  includeChunks: boolean,
  indexedDocuments: number,
): Promise<{ summary: CorpusStatusResult['chunks']; total: number | null }> {
  try {
    const lancedb = await import('@lancedb/lancedb');
    const dbPath = process.env.LANCEDB_PATH || './data/lancedb';
    const conn = await lancedb.connect(dbPath);
    const table = await conn.openTable(CHUNKS_TABLE);
    const total: number = await table.countRows();

    // A zero chunk count alongside indexed documents is not a measurement, it
    // is a contradiction — the two stores disagree. Serving the 0 would hand a
    // caller a confident denominator to divide by, which is the specific
    // failure this tool exists to prevent. Report it as unknown, and say why.
    if (total === 0 && indexedDocuments > 0) {
      const reason =
        `vector table '${CHUNKS_TABLE}' reports 0 chunks while ${indexedDocuments} ` +
        'documents are INDEXED — the metadata and vector stores disagree';
      context.logger.warn('corpus_status chunk count is inconsistent', { indexedDocuments });
      if (includeChunks) {
        for (const row of cases) row.chunks = null;
      }
      return { summary: { total: null, unavailableReason: reason }, total: null };
    }

    if (includeChunks) {
      for (const row of cases) {
        try {
          // Same quote-escaping idiom as the existing vector count routes.
          const safe = row.caseId.replace(/'/g, "''");
          row.chunks = await table.countRows(`case_id = '${safe}'`);
        } catch {
          row.chunks = null;
        }
      }
    }

    return { summary: { total }, total };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    context.logger.warn('corpus_status could not count chunks', { reason });
    if (includeChunks) {
      for (const row of cases) row.chunks = null;
    }
    return {
      summary: { total: null, unavailableReason: `vector table unreadable: ${reason}` },
      total: null,
    };
  }
}
