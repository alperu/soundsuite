import { prisma } from '@/lib/db/prisma';
import CaseViewWrapper from '@/components/case-view-wrapper';
import * as lancedb from '@lancedb/lancedb';
import {
  computePartialDocumentIds,
  type PartialDetectionPrisma,
} from '@/lib/ingestion/partial-detection';
import type { DocumentStatus } from '@/lib/document-status';

export const dynamic = 'force-dynamic';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';
const TABLE_NAME = 'chunks';

interface CaseWithStats {
  id: string;
  name: string;
  path: string;
  totalDocuments: number;
  statusCounts: {
    QUEUED: number;
    PROCESSING: number;
    INDEXED: number;
    ERROR: number;
    PARTIAL: number;
    FIXING_PARTIAL: number;
    /** Any status this file has not been taught about (e.g. DISCOVERED, STOPPED). */
    OTHER: number;
  };
}

interface Document {
  id: string;
  fileName: string;
  status: DocumentStatus;
  pageCount: number | null;
  detectedExhibits: number;
  errorMessage: string | null;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Which documents are partially indexed.
 *
 * This used to compare DISTINCT indexed page numbers against pageCount, which
 * counts a blank-by-design page as a gap: such a document is badged PARTIAL
 * forever and re-embedding can never clear it. computePartialDocumentIds applies
 * the same rule /api/vectors/page-report uses — a page that is blank by design
 * (PageCache/PageScore `source === 'empty'`) counts as covered — so the badge
 * and the Fix Partial button are only offered where a repair could actually help.
 *
 * FIXING_PARTIAL documents are included: a repair in flight does not remove the
 * good chunks, and excluding them would make the badge flicker off mid-repair,
 * which reads as the fix having failed.
 */
async function getPartialDocumentIds(): Promise<Set<string>> {
  try {
    const indexedDocs = await prisma.document.findMany({
      where: { status: { in: ['INDEXED', 'FIXING_PARTIAL'] }, pageCount: { gt: 0 } },
      select: { id: true, pageCount: true },
    });

    if (indexedDocs.length === 0) return new Set();

    // computePartialDocumentIds returns EVERY input document as partial when the
    // chunks table is absent (fresh install, moved LANCEDB_PATH). That would badge
    // the whole corpus PARTIAL and offer a repair that cannot work, so probe first
    // and fail open — which is what this page has always done.
    const db = await lancedb.connect(LANCEDB_PATH);
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE_NAME)) return new Set();

    // The real Prisma client is not structurally assignable to the narrow port
    // the module declares (its findMany args are generic `Exact<…>`); the cast is
    // required and is checked by the module's own runtime usage.
    return await computePartialDocumentIds(
      indexedDocs.map((d) => ({ id: d.id, pageCount: d.pageCount ?? 0 })),
      {
        prisma: prisma as unknown as PartialDetectionPrisma,
        lancedb,
        lancedbPath: LANCEDB_PATH,
        tableName: TABLE_NAME,
      },
    );
  } catch {
    // computePartialDocumentIds does not catch, and this is a `force-dynamic`
    // server component — an unavailable LanceDB must not break the whole page.
    return new Set();
  }
}

async function getCasesWithStats(partialIds: Set<string>): Promise<CaseWithStats[]> {
  const cases = await prisma.case.findMany({
    include: {
      documents: {
        where: { filingId: { not: null } },
        select: {
          id: true,
          status: true,
        },
      },
    },
    orderBy: {
      name: 'asc',
    },
  });

  return cases.map((caseItem: any) => {
    const statusCounts = {
      QUEUED: 0,
      PROCESSING: 0,
      INDEXED: 0,
      ERROR: 0,
      PARTIAL: 0,
      FIXING_PARTIAL: 0,
      OTHER: 0,
    };

    caseItem.documents.forEach((doc: any) => {
      const status = doc.status as keyof typeof statusCounts;
      if (status === 'INDEXED' && partialIds.has(doc.id)) {
        statusCounts.PARTIAL++;
      } else if (status in statusCounts) {
        statusCounts[status]++;
      } else {
        // Never drop a document silently: an unrecognised status (STOPPED,
        // DISCOVERED, anything added later) still counts towards the total, so
        // the chips must sum to it.
        statusCounts.OTHER++;
      }
    });

    return {
      id: caseItem.id,
      name: caseItem.name,
      path: caseItem.path,
      totalDocuments: caseItem.documents.length,
      statusCounts,
    };
  });
}

async function getInitialDocuments(): Promise<Record<string, Document[]>> {
  const documents = await prisma.document.findMany({
    where: { filingId: { not: null } },
    select: {
      id: true,
      fileName: true,
      status: true,
      pageCount: true,
      detectedExhibits: true,
      errorMessage: true,
      embeddingModel: true,
      createdAt: true,
      updatedAt: true,
      caseId: true,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  const documentsMap: Record<string, Document[]> = {};
  for (const doc of documents as any[]) {
    if (!documentsMap[doc.caseId]) documentsMap[doc.caseId] = [];
    documentsMap[doc.caseId].push({
      id: doc.id,
      fileName: doc.fileName,
      status: doc.status as DocumentStatus,
      pageCount: doc.pageCount,
      detectedExhibits: doc.detectedExhibits,
      errorMessage: doc.errorMessage,
      embeddingModel: doc.embeddingModel,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    });
  }

  return documentsMap;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const partialIds = await getPartialDocumentIds();
  const [cases, initialDocuments] = await Promise.all([
    getCasesWithStats(partialIds),
    getInitialDocuments(),
  ]);

  // URL state: /?case=<caseId>&doc=<docId>[,<docId>...] — deep-linkable
  // case + document selection (easy to hand to an AI or a teammate).
  const initialCaseId = typeof sp.case === 'string' ? sp.case : undefined;
  const initialDocIds =
    typeof sp.doc === 'string' ? sp.doc.split(',').filter(Boolean) : undefined;

  return (
    <CaseViewWrapper
      cases={cases}
      initialDocuments={initialDocuments}
      partialDocumentIds={Array.from(partialIds)}
      initialCaseId={initialCaseId}
      initialDocIds={initialDocIds}
    />
  );
}
