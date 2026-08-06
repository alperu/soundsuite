import { prisma } from '@/lib/db/prisma';
import CaseViewWrapper from '@/components/case-view-wrapper';
import * as lancedb from '@lancedb/lancedb';

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
  };
}

interface Document {
  id: string;
  fileName: string;
  status: 'QUEUED' | 'PROCESSING' | 'INDEXED' | 'ERROR' | 'STOPPED';
  pageCount: number | null;
  detectedExhibits: number;
  errorMessage: string | null;
  embeddingModel: string | null;
  createdAt: string;
  updatedAt: string;
}

async function getPartialDocumentIds(): Promise<Set<string>> {
  const partialIds = new Set<string>();

  try {
    // Get all INDEXED documents with a known pageCount
    const indexedDocs = await prisma.document.findMany({
      where: { status: 'INDEXED', pageCount: { gt: 0 } },
      select: { id: true, pageCount: true },
    });

    if (indexedDocs.length === 0) return partialIds;

    const db = await lancedb.connect(LANCEDB_PATH);
    const tableNames = await db.tableNames();
    if (!tableNames.includes(TABLE_NAME)) return partialIds;

    const table = await db.openTable(TABLE_NAME);

    // Build a lookup of expected page counts
    const expectedPages = new Map<string, number>();
    for (const doc of indexedDocs) {
      expectedPages.set(doc.id, doc.pageCount!);
    }

    // Batch query: get all rows for INDEXED documents, selecting only document_id and page_number
    const docIds = indexedDocs.map(d => d.id);
    const rows = await table.query()
      .select(['document_id', 'page_number'])
      .where(`document_id IN (${docIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')})`)
      .toArray();

    // Group distinct page numbers per document
    const indexedPagesMap = new Map<string, Set<number>>();
    for (const row of rows) {
      const docId = row.document_id as string;
      const pageNum = row.page_number as number;
      if (!indexedPagesMap.has(docId)) {
        indexedPagesMap.set(docId, new Set());
      }
      indexedPagesMap.get(docId)!.add(pageNum);
    }

    // Compare indexed page count vs expected page count
    for (const [docId, expected] of expectedPages) {
      const indexedPages = indexedPagesMap.get(docId);
      const indexedCount = indexedPages ? indexedPages.size : 0;
      if (indexedCount < expected) {
        partialIds.add(docId);
      }
    }
  } catch {
    // LanceDB may not be available — return empty set
  }

  return partialIds;
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
    };

    caseItem.documents.forEach((doc: any) => {
      const status = doc.status as keyof typeof statusCounts;
      if (status === 'INDEXED' && partialIds.has(doc.id)) {
        statusCounts.PARTIAL++;
      } else if (status in statusCounts) {
        statusCounts[status]++;
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
      status: doc.status as 'QUEUED' | 'PROCESSING' | 'INDEXED' | 'ERROR' | 'STOPPED',
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
