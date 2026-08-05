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

  // Parse URL segments: /vectors/{tool}/{filter}/{selection}
  //   tool      → tableview (default) | breakdown | pagereport
  //   filter    → all | case-{id} | filing-{id} | doc-{id}   (per-tool subset)
  //   selection → chunk-{id} (tableview) | page-{n} (pagereport)
  // Filter kinds a tool does not support are ignored (URL is normalized
  // client-side on the next interaction). Legacy pagereport query params
  // (?caseId=&documentId=&status=) are still honored.
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

  const FILTER_KINDS_BY_TOOL: Record<typeof initialViewMode, string[]> = {
    tableview: ['case', 'filing', 'doc'],
    breakdown: ['case'],
    pagereport: ['case', 'doc'],
  };

  let initialFilterKind: 'all' | 'case' | 'filing' | 'doc' = 'all';
  let initialFilterId: string | undefined;
  const filterSeg = path?.[1];
  if (filterSeg && filterSeg !== 'all') {
    const m = /^(case|filing|doc)-(.+)$/.exec(decodeURIComponent(filterSeg));
    if (m && FILTER_KINDS_BY_TOOL[initialViewMode].includes(m[1])) {
      initialFilterKind = m[1] as 'case' | 'filing' | 'doc';
      initialFilterId = m[2];
    }
  }

  let initialChunkId: string | undefined;
  let initialModalPage: number | undefined;
  let initialViewerPage: number | undefined;
  const selSeg = path?.[2];
  if (selSeg) {
    const decoded = decodeURIComponent(selSeg);
    if (initialViewMode === 'tableview' && decoded.startsWith('chunk-')) {
      initialChunkId = decoded.slice('chunk-'.length);
    } else if (initialViewMode === 'pagereport' && /^page-\d+$/.test(decoded)) {
      initialModalPage = parseInt(decoded.slice('page-'.length), 10);
    } else if (initialViewMode === 'pagereport' && /^pageview-\d+$/.test(decoded)) {
      initialViewerPage = parseInt(decoded.slice('pageview-'.length), 10);
    }
  }

  // Pagereport entity filter: path segment wins, legacy query params as fallback
  const initialCaseId =
    (initialViewMode === 'pagereport' && initialFilterKind === 'case' ? initialFilterId : undefined) ??
    (typeof sp.caseId === 'string' ? sp.caseId : undefined);
  const initialDocumentId =
    (initialViewMode === 'pagereport' && initialFilterKind === 'doc' ? initialFilterId : undefined) ??
    (typeof sp.documentId === 'string' ? sp.documentId : undefined);
  const initialStatusFilter = typeof sp.status === 'string' ? sp.status : undefined;

  // Tableview secondary filters (query params — orthogonal to the path filter)
  const initialTableQuery = {
    isExhibit: typeof sp.type === 'string' ? sp.type : undefined,
    textSearch: typeof sp.q === 'string' ? sp.q : undefined,
    pageMin: typeof sp.pmin === 'string' ? sp.pmin : undefined,
    pageMax: typeof sp.pmax === 'string' ? sp.pmax : undefined,
  };

  return (
    <VectorViewer
      cases={cases}
      filings={filings}
      documents={documents}
      initialViewMode={initialViewMode}
      hasExplicitPath={!!(path && path.length > 0)}
      initialFilterKind={initialFilterKind}
      initialFilterId={initialFilterId}
      initialChunkId={initialChunkId}
      initialModalPage={initialModalPage}
      initialViewerPage={initialViewerPage}
      initialTableQuery={initialTableQuery}
      initialCaseId={initialCaseId}
      initialDocumentId={initialDocumentId}
      initialStatusFilter={initialStatusFilter}
    />
  );
}
