/**
 * Shared "is this document partially indexed?" check.
 *
 * Before this module, the same distinctPages-vs-pageCount comparison was
 * implemented twice (src/app/page.tsx's getPartialDocumentIds and
 * src/app/api/documents/partial-status/route.ts) and BOTH copies had the
 * same gap: they counted distinct indexed pages in LanceDB and compared to
 * pageCount, with no allowance for pages that are blank by design. A
 * document with legitimately blank pages would be flagged PARTIAL forever,
 * because there is no text on a blank page to embed — no amount of
 * re-indexing closes that gap.
 *
 * `src/app/api/vectors/page-report/route.ts` already gets this right at
 * per-page granularity by checking PageCache.source === 'empty'. This
 * module applies the same idea at the batched, multi-document granularity
 * the sidebar/grid badges need — with one addition: PageCache is wiped
 * after successful ingestion (see ingestion-pipeline.ts), so for older
 * INDEXED documents there is no PageCache row to check at all. PageScore
 * rows persist across that wipe specifically to snapshot this
 * (schema.prisma: "outlives the PageCache wipe"), so this module falls
 * back to PageScore.source === 'empty' for any document that has no
 * PageCache rows left.
 */

export interface PartialDetectionDoc {
  id: string;
  pageCount: number;
}

interface PageRow {
  documentId: string;
  pageNumber: number;
}

export interface PartialDetectionPrisma {
  pageCache: {
    findMany: (args: { where: Record<string, unknown>; select?: Record<string, boolean>; distinct?: string[] }) => Promise<PageRow[]>;
  };
  pageScore: {
    findMany: (args: { where: Record<string, unknown>; select?: Record<string, boolean> }) => Promise<PageRow[]>;
  };
}

export interface PartialDetectionLancedb {
  connect: (path: string) => Promise<{
    tableNames: () => Promise<string[]>;
    openTable: (name: string) => Promise<{
      query: () => {
        select: (cols: string[]) => {
          where: (clause: string) => { toArray: () => Promise<Array<Record<string, unknown>>> };
        };
      };
    }>;
  }>;
}

export interface ComputePartialOptions {
  prisma: PartialDetectionPrisma;
  lancedb: PartialDetectionLancedb;
  lancedbPath: string;
  tableName?: string;
}

function escapeSqlList(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
}

/**
 * Returns the set of document ids among `docs` whose indexed-page coverage
 * (chunks in LanceDB, plus pages known blank-by-design) falls short of
 * pageCount.
 */
export async function computeDocumentCoverage(
  docs: PartialDetectionDoc[],
  opts: ComputePartialOptions,
): Promise<DocumentCoverage> {
  const partial = new Set<string>();
  const nothingToRepair = new Set<string>();
  if (docs.length === 0) return { partial, nothingToRepair };

  const tableName = opts.tableName ?? 'chunks';
  const db = await opts.lancedb.connect(opts.lancedbPath);
  const tableNames = await db.tableNames();

  if (!tableNames.includes(tableName)) {
    // No chunks table at all means nothing has been proven indexed.
    for (const doc of docs) partial.add(doc.id);
    return { partial, nothingToRepair };
  }

  const table = await db.openTable(tableName);
  const docIds = docs.map((d) => d.id);
  const rows = await table
    .query()
    .select(['document_id', 'page_number'])
    .where(`document_id IN (${escapeSqlList(docIds)})`)
    .toArray();

  const indexedPagesByDoc = new Map<string, Set<number>>();
  for (const row of rows) {
    const docId = row.document_id as string;
    const pageNum = row.page_number as number;
    if (!indexedPagesByDoc.has(docId)) indexedPagesByDoc.set(docId, new Set());
    indexedPagesByDoc.get(docId)!.add(pageNum);
  }

  // Naive candidates under the raw distinct-pages-vs-pageCount comparison.
  // Only these need the (more expensive) blank-page lookup.
  const candidates = docs.filter((d) => (indexedPagesByDoc.get(d.id)?.size ?? 0) < d.pageCount);
  if (candidates.length === 0) return { partial, nothingToRepair };

  const candidateIds = candidates.map((d) => d.id);
  const [pcEmptyRows, psEmptyRows, pcAnyRows] = await Promise.all([
    opts.prisma.pageCache.findMany({
      where: { documentId: { in: candidateIds }, source: { in: ['empty', 'image-only'] } },
      select: { documentId: true, pageNumber: true },
    }),
    opts.prisma.pageScore.findMany({
      where: { documentId: { in: candidateIds }, source: { in: ['empty', 'image-only'] } },
      select: { documentId: true, pageNumber: true },
    }),
    opts.prisma.pageCache.findMany({
      where: { documentId: { in: candidateIds } },
      select: { documentId: true },
      distinct: ['documentId'],
    }),
  ]);

  const docsWithPageCache = new Set(pcAnyRows.map((r) => r.documentId));

  const emptyByDoc = new Map<string, Set<number>>();
  for (const r of pcEmptyRows) {
    if (!emptyByDoc.has(r.documentId)) emptyByDoc.set(r.documentId, new Set());
    emptyByDoc.get(r.documentId)!.add(r.pageNumber);
  }
  for (const r of psEmptyRows) {
    // PageCache wins when present — only fall back to PageScore for
    // documents whose PageCache rows are gone (wiped after ingest).
    if (docsWithPageCache.has(r.documentId)) continue;
    if (!emptyByDoc.has(r.documentId)) emptyByDoc.set(r.documentId, new Set());
    emptyByDoc.get(r.documentId)!.add(r.pageNumber);
  }

  for (const doc of candidates) {
    const indexed = indexedPagesByDoc.get(doc.id) ?? new Set<number>();
    const unindexable = emptyByDoc.get(doc.id) ?? new Set<number>();
    const coveredCount = new Set([...indexed, ...unindexable]).size;
    if (coveredCount < doc.pageCount) {
      partial.add(doc.id);
    } else if (unindexable.size > 0) {
      // Fully accounted for, but not every page is IN the index: some are
      // blank by design or image-only. Not partial — there is nothing to
      // repair — but not plainly "indexed" either, and the dashboard needs
      // to say which so it can show "Indexed (Nothing to repair)" rather
      // than implying a gap that a repair could close.
      nothingToRepair.add(doc.id);
    }
  }

  return { partial, nothingToRepair };
}

/** Coverage verdict for a batch of documents. */
export interface DocumentCoverage {
  /** Has pages with no vectors that a repair could plausibly index. */
  partial: Set<string>;
  /**
   * Every page is accounted for, but some are not in the index because they
   * cannot be: blank by design, or image-only (ink, no extractable text).
   * Nothing to repair — and saying "partial" about these was the complaint
   * this set exists to answer.
   */
  nothingToRepair: Set<string>;
}

/**
 * Back-compat shim: the partial set only.
 *
 * Kept because two callers and a test suite are written against it, and
 * widening the return type at every call site is churn that buys nothing for
 * the ones that only want the badge.
 */
export async function computePartialDocumentIds(
  docs: PartialDetectionDoc[],
  opts: ComputePartialOptions,
): Promise<Set<string>> {
  return (await computeDocumentCoverage(docs, opts)).partial;
}
