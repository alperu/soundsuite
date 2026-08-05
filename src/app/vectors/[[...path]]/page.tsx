import { prisma } from '@/lib/db/prisma';
import VectorViewer from '@/components/vector-viewer';

export const dynamic = 'force-dynamic';

async function getData() {
  const cases = await prisma.case.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const filings = await (prisma as any).filing.findMany({
    select: { id: true, title: true, filingType: true, caseId: true },
    orderBy: { title: 'asc' },
  });

  const documents = await prisma.document.findMany({
    where: { status: 'INDEXED' },
    select: { id: true, fileName: true, caseId: true, filingId: true, readinessScore: true, readinessBand: true },
    orderBy: { fileName: 'asc' },
  });

  // Include indexed drafts as pseudo-documents so they appear in the vector viewer
  const indexedDrafts = await prisma.draft.findMany({
    where: { indexingStatus: 'INDEXED' },
    select: { id: true, title: true, caseId: true, documentType: true, indexedVersion: true, lastIndexedAt: true },
    orderBy: { title: 'asc' },
  });

  // Convert drafts to document-like objects for the viewer
  const draftDocs = indexedDrafts.map(d => ({
    id: d.id,
    fileName: `📝 Draft: ${d.title} (${d.documentType})`,
    caseId: d.caseId,
    filingId: null as string | null,
    readinessScore: null as number | null,
    readinessBand: null as string | null,
    isDraft: true,
  }));

  const allDocuments = [...documents, ...draftDocs];

  return { cases, filings, documents: allDocuments };
}

interface VectorsPageProps {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function VectorsPage({ params, searchParams }: VectorsPageProps) {
  const { path } = await params;
  const sp = await searchParams;
  const { cases, filings, documents } = await getData();

  // Parse URL segments into view mode
  // /vectors              → tableview (default)
  // /vectors/tableview    → tableview
  // /vectors/breakdown    → breakdown
  // /vectors/pagereport   → pagereport
  let initialViewMode: 'tableview' | 'breakdown' | 'pagereport' = 'tableview';

  if (path && path.length > 0) {
    const first = path[0].toLowerCase();
    if (first === 'breakdown') {
      initialViewMode = 'breakdown';
    } else if (first === 'pagereport') {
      initialViewMode = 'pagereport';
    } else if (first === 'tableview') {
      initialViewMode = 'tableview';
    }
  }

  // Parse query params for page report
  const initialCaseId = typeof sp.caseId === 'string' ? sp.caseId : undefined;
  const initialDocumentId = typeof sp.documentId === 'string' ? sp.documentId : undefined;
  const initialStatusFilter = typeof sp.status === 'string' ? sp.status : undefined;

  return (
    <VectorViewer
      cases={cases}
      filings={filings}
      documents={documents}
      initialViewMode={initialViewMode}
      hasExplicitPath={!!(path && path.length > 0)}
      initialCaseId={initialCaseId}
      initialDocumentId={initialDocumentId}
      initialStatusFilter={initialStatusFilter}
    />
  );
}
