'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getPreference, setPreference } from '@/lib/indexed-db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VectorChunk {
  id: string;
  text: string;
  documentId: string;
  caseId: string;
  pageNumber: number;
  chunkIndex: number;
  isExhibit: boolean;
  exhibitPath: string | null;
  createdAt: number;
  /** Chunk readiness score — inherits its page's v2 ladder score (null = not scored). */
  readinessScore?: number | null;
}

/** Score badge classes matching the document-grid band colors. */
function chunkScoreBadge(score: number): string {
  if (score >= 85) return 'bg-green-100 text-green-700';
  if (score >= 70) return 'bg-green-50 text-green-600';
  if (score >= 50) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

interface VectorStats {
  totalChunks: number;
  totalDocuments: number;
  totalCases: number;
  exhibitChunks: number;
  textChunks: number;
  avgChunksPerDoc: number;
  vectorDimensions: number | null;
  embedding: { provider: string; model: string; dbPath: string };
  caseBreakdown: { id: string; name: string; chunks: number }[];
  documentBreakdown: { id: string; name: string; caseId: string; chunks: number }[];
}

interface Case {
  id: string;
  name: string;
}

interface Filing {
  id: string;
  title: string;
  filingType: string;
  caseId: string;
}

interface Document {
  id: string;
  fileName: string;
  caseId: string;
  filingId: string | null;
  /** AI Readiness Score (0-100), null = not yet scored (e.g. drafts, pre-feature docs). */
  readinessScore?: number | null;
  readinessBand?: string | null;
}

/** "Motion.pdf · ⚠ 62 RISKY" — readiness suffix for document pickers. */
function docOptionLabel(d: Document): string {
  if (d.readinessScore == null || !d.readinessBand) return d.fileName;
  const flag = d.readinessBand === 'RISKY' || d.readinessBand === 'POOR' ? '⚠ ' : '';
  return `${d.fileName} · ${flag}${d.readinessScore} ${d.readinessBand}`;
}

interface PageReportData {
  documentId: string;
  fileName: string;
  totalPages: number;
  pages: Array<{
    pageNumber: number;
    textPreview: string;
    textDensity: number;
    source: string | null;
    chunkCount: number;
    hasExhibit: boolean;
    status: 'indexed' | 'unindexed' | 'empty';
    /** Per-page readiness score (readiness v2 Phase 3); null = not scored. */
    score?: number | null;
    band?: string | null;
    pageClass?: string | null;
    flags?: string[];
  }>;
  summary: {
    indexedPages: number; unindexedPages: number; emptyPages?: number; totalChunks: number;
    meanPageScore?: number | null; riskyPages?: number; poorPages?: number;
  };
}

type ViewMode = 'tableview' | 'breakdown' | 'pagereport' | 'metaview';

// ---------------------------------------------------------------------------
// URL scheme: /vectors/{tool}/{filter}/{selection}
//   filter    → all | case-{id} | filing-{id} | doc-{id}
//   selection → chunk-{id} (tableview) | page-{n} (pagereport)
// Secondary tableview filters (type/q/pmin/pmax) and pagereport status ride
// as query params. Each tool only accepts the filter kinds it can act on;
// switching tools carries the filter across when the target supports it.
// ---------------------------------------------------------------------------

type VectorFilterKind = 'all' | 'case' | 'filing' | 'doc';

interface VectorsFilter {
  kind: VectorFilterKind;
  id?: string;
}

const TOOL_FILTER_KINDS: Record<ViewMode, VectorFilterKind[]> = {
  tableview: ['case', 'filing', 'doc'],
  breakdown: ['case'],
  pagereport: ['case', 'doc'],
  metaview: ['case', 'doc'],
};

function buildVectorsPath(
  tool: ViewMode,
  filter?: VectorsFilter,
  selection?: string,
  query?: URLSearchParams,
): string {
  const segs = [`/vectors/${tool}`];
  const hasFilter = filter && filter.kind !== 'all' && filter.id
    && TOOL_FILTER_KINDS[tool].includes(filter.kind);
  if (hasFilter) {
    segs.push(`${filter!.kind}-${encodeURIComponent(filter!.id!)}`);
  } else if (selection) {
    segs.push('all'); // selection needs a filter slot to keep segment positions stable
  }
  if (selection) segs.push(encodeURIComponent(selection));
  const qs = query?.toString();
  const full = segs.join('/') + (qs ? `?${qs}` : '');
  // Every /vectors URL write flows through here — remember the last tool and
  // each tool's last full URL so a bare /vectors visit can restore them
  // (soundsuite-cache → preferences, same store as home/search).
  if (typeof window !== 'undefined') {
    setPreference('vectors.lastTool', tool).catch(() => {});
    setPreference(`vectors.url.${tool}`, full).catch(() => {});
  }
  return full;
}

/** Carry a filter to another tool, dropping it if the target can't use it. */
function carryFilter(filter: VectorsFilter, target: ViewMode): VectorsFilter {
  if (filter.kind !== 'all' && filter.id && TOOL_FILTER_KINDS[target].includes(filter.kind)) {
    return filter;
  }
  return { kind: 'all' };
}

interface VectorViewerProps {
  cases: Case[];
  filings: Filing[];
  documents: Document[];
  initialViewMode?: ViewMode;
  hasExplicitPath?: boolean;
  initialFilterKind?: VectorFilterKind;
  initialFilterId?: string;
  initialChunkId?: string;
  initialModalPage?: number;
  initialViewerPage?: number;
  initialMetaPage?: number;
  initialTableQuery?: { isExhibit?: string; textSearch?: string; pageMin?: string; pageMax?: string; sortBy?: string; sortDir?: string; pg?: string };
  initialCaseId?: string;
  initialDocumentId?: string;
  initialStatusFilter?: string;
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function VectorViewer({
  cases,
  filings,
  documents,
  initialViewMode = 'tableview',
  hasExplicitPath = false,
  initialFilterKind = 'all',
  initialFilterId,
  initialChunkId,
  initialModalPage,
  initialViewerPage,
  initialMetaPage,
  initialTableQuery,
  initialCaseId,
  initialDocumentId,
  initialStatusFilter,
}: VectorViewerProps) {
  const router = useRouter();
  const [viewMode, setViewModeState] = useState<ViewMode>(initialViewMode);
  const [stats, setStats] = useState<VectorStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // Last-known entity filter, reported up by the active tool so switching
  // tools can carry it across (when the target tool supports the kind).
  const currentFilterRef = useRef<VectorsFilter>(
    initialFilterKind !== 'all' && initialFilterId
      ? { kind: initialFilterKind, id: initialFilterId }
      : initialDocumentId
        ? { kind: 'doc', id: initialDocumentId }
        : initialCaseId
          ? { kind: 'case', id: initialCaseId }
          : { kind: 'all' },
  );
  const reportFilter = useCallback((f: VectorsFilter) => {
    currentFilterRef.current = f;
  }, []);

  // URL-driven navigation — /vectors/{tool}/{filter}; selection never carries
  const setViewMode = useCallback((m: ViewMode) => {
    setViewModeState(m);
    router.push(buildVectorsPath(m, carryFilter(currentFilterRef.current, m)), { scroll: false });
  }, [router]);

  // Bare /vectors visit → restore the last tool + that tool's last settings
  // from IndexedDB preferences. An explicit path always wins (deep links).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (hasExplicitPath || restoredRef.current) return;
    restoredRef.current = true;
    (async () => {
      try {
        const lastTool = await getPreference<ViewMode>('vectors.lastTool');
        // Derived from TOOL_FILTER_KINDS so a new tool can't be forgotten here
        if (!lastTool || !Object.keys(TOOL_FILTER_KINDS).includes(lastTool)) return;
        const lastUrl = await getPreference<string>(`vectors.url.${lastTool}`);
        if (lastUrl && lastUrl.startsWith('/vectors')) {
          router.replace(lastUrl, { scroll: false });
        }
      } catch { /* stay on defaults */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasExplicitPath]);

  // Fetch stats once on mount
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/vectors/stats');
        const data = await res.json();
        if (res.ok) setStats(data);
      } catch {
        // Stats are non-critical
      } finally {
        setStatsLoading(false);
      }
    };
    fetchStats();
  }, []);

  return (
    <div className="flex h-full">
      {/* ================================================================= */}
      {/* LEFT SIDEBAR — View Mode */}
      {/* ================================================================= */}
      <aside className="w-44 flex-shrink-0 border-r border-gray-200 bg-gray-50/80 flex flex-col">
        <div className="p-3 border-b border-gray-200">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Tools</h2>
        </div>
        <nav className="p-2 space-y-1">
          <SidebarButton
            active={viewMode === 'tableview'}
            onClick={() => setViewMode('tableview')}
            icon={<TableIcon />}
            label="Table View"
          />
          <SidebarButton
            active={viewMode === 'breakdown'}
            onClick={() => setViewMode('breakdown')}
            icon={<ChartIcon />}
            label="Breakdown"
          />
          <SidebarButton
            active={viewMode === 'pagereport'}
            onClick={() => setViewMode('pagereport')}
            icon={<ClipboardCheckIcon />}
            label="Page Report"
          />
          <SidebarButton
            active={viewMode === 'metaview'}
            onClick={() => setViewMode('metaview')}
            icon={<LayersIcon />}
            label="Meta View"
          />
        </nav>
      </aside>

      {/* ================================================================= */}
      {/* CENTER — Top Bar + Main Content */}
      {/* ================================================================= */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar — Embedding + Stats */}
        <div className="flex-shrink-0 bg-white border-b border-gray-200 px-6 py-3">
          {stats ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-500">Provider</span>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 capitalize">
                  {stats.embedding.provider}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-500">Model</span>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800 font-mono">
                  {stats.embedding.model}
                </span>
              </div>
              {stats.vectorDimensions && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-500">Dimensions</span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                    {stats.vectorDimensions}
                  </span>
                </div>
              )}
              <div className="ml-auto flex items-center gap-4 text-xs text-gray-500">
                <span>{stats.totalChunks.toLocaleString()} chunks</span>
                <span>{stats.totalDocuments.toLocaleString()} docs</span>
                <span>{stats.totalCases.toLocaleString()} cases</span>
              </div>
            </div>
          ) : statsLoading ? (
            <div className="h-6 bg-gray-100 rounded animate-pulse w-96" />
          ) : null}
        </div>

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-gray-50">
          <div className="p-6 space-y-6 w-full">
            {viewMode === 'tableview' && (
              <TableViewContent
                cases={cases}
                filings={filings}
                documents={documents}
                stats={stats}
                statsLoading={statsLoading}
                initialFilter={currentFilterRef.current}
                initialChunkId={initialViewMode === 'tableview' ? initialChunkId : undefined}
                initialQuery={initialTableQuery}
                reportFilter={reportFilter}
              />
            )}
            {viewMode === 'breakdown' && (
              <BreakdownContent
                cases={cases}
                stats={stats}
                statsLoading={statsLoading}
                initialCaseId={currentFilterRef.current.kind === 'case' ? currentFilterRef.current.id : undefined}
                reportFilter={reportFilter}
              />
            )}
            {viewMode === 'pagereport' && (
              <PageReportContent
                cases={cases}
                filings={filings}
                documents={documents}
                initialCaseId={initialCaseId}
                initialDocumentId={initialDocumentId}
                initialStatusFilter={initialStatusFilter}
                initialModalPage={initialViewMode === 'pagereport' ? initialModalPage : undefined}
                initialViewerPage={initialViewMode === 'pagereport' ? initialViewerPage : undefined}
                reportFilter={reportFilter}
              />
            )}
            {viewMode === 'metaview' && (
              <MetaViewContent
                cases={cases}
                documents={documents}
                initialCaseId={currentFilterRef.current.kind === 'case' ? currentFilterRef.current.id : undefined}
                initialDocumentId={currentFilterRef.current.kind === 'doc' ? currentFilterRef.current.id : undefined}
                initialPage={initialViewMode === 'metaview' ? initialMetaPage : undefined}
                reportFilter={reportFilter}
              />
            )}
          </div>
        </main>
      </div>

      {/* ================================================================= */}
      {/* RIGHT SIDEBAR — Docs */}
      {/* ================================================================= */}
      <aside className="w-72 flex-shrink-0 border-l border-gray-200 bg-white flex flex-col overflow-hidden">
        <div className="p-3 border-b border-gray-200">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Docs</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          <VectorDocsPanel viewMode={viewMode} />
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar Button
// ---------------------------------------------------------------------------

function SidebarButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
        active ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
      }`}
    >
      <span className={`w-4 h-4 shrink-0 ${active ? 'text-blue-600' : 'text-gray-400'}`}>
        {icon}
      </span>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function TableIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M12 12v-1.5c0-.621-.504-1.125-1.125-1.125M12 12c0-.621.504-1.125 1.125-1.125m-2.25 0A1.125 1.125 0 0112 12m0 0v1.5m0-1.5c0-.621.504-1.125 1.125-1.125" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  );
}

function ClipboardCheckIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15a2.25 2.25 0 011.65 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 3.98 8.25 4.655 8.25 5.5v.875c0 .345.168.655.427.85m7.896-3.314c.376.023.75.05 1.124.08 .631.064 1.476.739 1.476 1.584v.875c0 .345-.168.655-.427.85m-10.79 0H6.75a2.25 2.25 0 00-2.25 2.25v10.5a2.25 2.25 0 002.25 2.25h10.5a2.25 2.25 0 002.25-2.25V7.5a2.25 2.25 0 00-2.25-2.25h-.878m-10.79 0c-.082.052-.164.107-.245.165M9 15l2.25 2.25L15 12" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Table View Content
// ---------------------------------------------------------------------------

function TableViewContent({
  cases,
  filings,
  documents,
  stats,
  statsLoading,
  initialFilter,
  initialChunkId,
  initialQuery,
  reportFilter,
}: {
  cases: Case[];
  filings: Filing[];
  documents: Document[];
  stats: VectorStats | null;
  statsLoading: boolean;
  initialFilter?: VectorsFilter;
  initialChunkId?: string;
  initialQuery?: { isExhibit?: string; textSearch?: string; pageMin?: string; pageMax?: string; sortBy?: string; sortDir?: string; pg?: string };
  reportFilter?: (f: VectorsFilter) => void;
}) {
  const router = useRouter();
  const [chunks, setChunks] = useState<VectorChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedChunk, setExpandedChunk] = useState<string | null>(initialChunkId ?? null);

  // Pagination — seeded from ?pg= so a refresh stays on the same page
  const [page, setPage] = useState(() => {
    const n = parseInt(initialQuery?.pg ?? '', 10);
    return Number.isFinite(n) && n > 1 ? n : 1;
  });
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const limit = 50;

  // Filters — primary entity filter seeds from the URL path segment
  const [caseId, setCaseId] = useState(initialFilter?.kind === 'case' ? initialFilter.id ?? '' : '');
  const [filingId, setFilingId] = useState(initialFilter?.kind === 'filing' ? initialFilter.id ?? '' : '');
  const [documentId, setDocumentId] = useState(initialFilter?.kind === 'doc' ? initialFilter.id ?? '' : '');
  const [isExhibit, setIsExhibit] = useState(initialQuery?.isExhibit ?? '');
  const [textSearch, setTextSearch] = useState(initialQuery?.textSearch ?? '');
  const [pageMin, setPageMin] = useState(initialQuery?.pageMin ?? '');
  const [pageMax, setPageMax] = useState(initialQuery?.pageMax ?? '');
  const [filterTrigger, setFilterTrigger] = useState(0);

  // Column sorting (server-side, whole filtered set)
  const CHUNK_SORT_FIELDS = ['pageNumber', 'chunkIndex', 'isExhibit', 'readinessScore', 'documentId', 'createdAt'] as const;
  type ChunkSortField = (typeof CHUNK_SORT_FIELDS)[number];
  const [sortBy, setSortBy] = useState<ChunkSortField | ''>(
    CHUNK_SORT_FIELDS.includes(initialQuery?.sortBy as ChunkSortField) ? (initialQuery!.sortBy as ChunkSortField) : '',
  );
  const [sortDir, setSortDir] = useState<SortDir>(initialQuery?.sortDir === 'desc' ? 'desc' : 'asc');

  // Sync /vectors/tableview/{filter}/{chunk-selection}?type&q&pmin&pmax.
  // The path filter is the most specific selected entity (doc > filing > case).
  const syncUrl = useCallback((overrides?: {
    selection?: string | null;
    caseId?: string; filingId?: string; documentId?: string;
    isExhibit?: string; textSearch?: string; pageMin?: string; pageMax?: string;
    sortBy?: string; sortDir?: string; pg?: number;
  }) => {
    const c = overrides?.caseId ?? caseId;
    const f = overrides?.filingId ?? filingId;
    const d = overrides?.documentId ?? documentId;
    const filter: VectorsFilter = d
      ? { kind: 'doc', id: d }
      : f
        ? { kind: 'filing', id: f }
        : c
          ? { kind: 'case', id: c }
          : { kind: 'all' };
    reportFilter?.(filter);
    const qp = new URLSearchParams();
    const ex = overrides?.isExhibit ?? isExhibit;
    const q = overrides?.textSearch ?? textSearch;
    const pmin = overrides?.pageMin ?? pageMin;
    const pmax = overrides?.pageMax ?? pageMax;
    if (ex) qp.set('type', ex);
    if (q.trim()) qp.set('q', q.trim());
    if (pmin) qp.set('pmin', pmin);
    if (pmax) qp.set('pmax', pmax);
    const sb = overrides?.sortBy ?? sortBy;
    const sd = overrides?.sortDir ?? sortDir;
    if (sb) { qp.set('sort', sb); qp.set('dir', sd); }
    const pg = overrides?.pg ?? page;
    if (pg > 1) qp.set('pg', String(pg));
    const selection = overrides?.selection === undefined
      ? (expandedChunk ? `chunk-${expandedChunk}` : undefined)
      : (overrides.selection ? `chunk-${overrides.selection}` : undefined);
    router.replace(buildVectorsPath('tableview', filter, selection, qp), { scroll: false });
  }, [router, reportFilter, caseId, filingId, documentId, isExhibit, textSearch, pageMin, pageMax, sortBy, sortDir, expandedChunk, page]);

  const toggleChunk = useCallback((id: string) => {
    const next = expandedChunk === id ? null : id;
    setExpandedChunk(next);
    syncUrl({ selection: next });
  }, [expandedChunk, syncUrl]);

  const handlePageChange = useCallback((p: number) => {
    setPage(p);
    syncUrl({ pg: p });
  }, [syncUrl]);

  const filteredFilings = caseId
    ? filings.filter(f => f.caseId === caseId)
    : filings;

  const filteredDocs = documents.filter(d => {
    if (caseId && d.caseId !== caseId) return false;
    if (filingId && d.filingId !== filingId) return false;
    return true;
  });

  // Fetch chunks
  useEffect(() => {
    let cancelled = false;
    const fetchChunks = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ page: String(page), limit: String(limit) });
        if (caseId) params.set('caseId', caseId);
        if (filingId) params.set('filingId', filingId);
        if (documentId) params.set('documentId', documentId);
        if (isExhibit) params.set('isExhibit', isExhibit);
        if (textSearch.trim()) params.set('textSearch', textSearch.trim());
        if (pageMin) params.set('pageMin', pageMin);
        if (pageMax) params.set('pageMax', pageMax);
        if (sortBy) { params.set('sortBy', sortBy); params.set('sortDir', sortDir); }

        const res = await fetch(`/api/vectors?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch vectors');

        if (!cancelled) {
          setChunks(data.chunks);
          setTotal(data.total);
          setTotalPages(data.totalPages);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchChunks();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filterTrigger, sortBy, sortDir]);

  const handleSort = useCallback((field: ChunkSortField) => {
    const nextDir: SortDir = sortBy === field && sortDir === 'asc' ? 'desc' : 'asc';
    const nextBy = field;
    setSortBy(nextBy);
    setSortDir(nextDir);
    setPage(1);
    setExpandedChunk(null);
    syncUrl({ selection: null, sortBy: nextBy, sortDir: nextDir, pg: 1 });
   
  }, [sortBy, sortDir, syncUrl]);

  const handleApplyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setExpandedChunk(null);
    setFilterTrigger(t => t + 1);
    syncUrl({ selection: null, pg: 1 });
  };

  const handleResetFilters = () => {
    setCaseId('');
    setFilingId('');
    setDocumentId('');
    setIsExhibit('');
    setTextSearch('');
    setPageMin('');
    setPageMax('');
    setPage(1);
    setExpandedChunk(null);
    setFilterTrigger(t => t + 1);
    syncUrl({
      selection: null, pg: 1,
      caseId: '', filingId: '', documentId: '',
      isExhibit: '', textSearch: '', pageMin: '', pageMax: '',
    });
  };

  const formatDate = (ts: number) => new Date(ts).toLocaleString();
  const truncateText = (text: string, maxLen = 150) =>
    text.length <= maxLen ? text : text.substring(0, maxLen) + '\u2026';
  const getDocName = (id: string) =>
    documents.find(d => d.id === id)?.fileName || id.substring(0, 8) + '\u2026';
  const getCaseName = (id: string) =>
    cases.find(c => c.id === id)?.name;

  return (
    <>
      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {[
            { label: 'Total Chunks', value: stats.totalChunks.toLocaleString(), color: 'bg-blue-50 text-blue-700' },
            { label: 'Documents', value: stats.totalDocuments.toLocaleString(), color: 'bg-green-50 text-green-700' },
            { label: 'Cases', value: stats.totalCases.toLocaleString(), color: 'bg-purple-50 text-purple-700' },
            { label: 'Text Chunks', value: stats.textChunks.toLocaleString(), color: 'bg-gray-50 text-gray-700' },
            { label: 'Exhibit Chunks', value: stats.exhibitChunks.toLocaleString(), color: 'bg-amber-50 text-amber-700' },
            { label: 'Avg / Doc', value: String(stats.avgChunksPerDoc), color: 'bg-indigo-50 text-indigo-700' },
          ].map((s) => (
            <div key={s.label} className={`rounded-lg p-4 ${s.color}`}>
              <p className="text-xs font-medium opacity-75">{s.label}</p>
              <p className="text-2xl font-bold mt-1">{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {statsLoading && !stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg p-4 bg-gray-100 animate-pulse h-20" />
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <form onSubmit={handleApplyFilters}>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Case</label>
              <select
                value={caseId}
                onChange={(e) => { setCaseId(e.target.value); setFilingId(''); setDocumentId(''); }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">All Cases</option>
                {cases.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Filing</label>
              <select
                value={filingId}
                onChange={(e) => { setFilingId(e.target.value); setDocumentId(''); }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">All Filings</option>
                {filteredFilings.map((f) => (
                  <option key={f.id} value={f.id}>{f.title} ({f.filingType})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Document</label>
              <select
                value={documentId}
                onChange={(e) => setDocumentId(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">All Documents</option>
                {filteredDocs.map((d) => (
                  <option key={d.id} value={d.id}>{docOptionLabel(d)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
              <select
                value={isExhibit}
                onChange={(e) => setIsExhibit(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">All Types</option>
                <option value="false">Text Chunks</option>
                <option value="true">Exhibit Chunks</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Text Search</label>
              <input
                type="text"
                value={textSearch}
                onChange={(e) => setTextSearch(e.target.value)}
                placeholder="Search within chunk text..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Page Range</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  value={pageMin}
                  onChange={(e) => setPageMin(e.target.value)}
                  placeholder="Min"
                  min="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <input
                  type="number"
                  value={pageMax}
                  onChange={(e) => setPageMax(e.target.value)}
                  placeholder="Max"
                  min="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <button
                type="submit"
                className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={handleResetFilters}
                className="flex-1 bg-gray-100 text-gray-700 py-2 px-4 rounded-md text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {/* Results Info + Top Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          {loading ? 'Loading\u2026' : `Showing ${chunks.length} of ${total.toLocaleString()} chunks`}
        </p>
        {totalPages > 1 && (
          <Pagination page={page} totalPages={totalPages} loading={loading} onPageChange={handlePageChange} />
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full mx-auto" />
          <p className="text-gray-500 mt-4">Loading vectors&hellip;</p>
        </div>
      ) : chunks.length > 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Text Preview</th>
                  <SortableHeader field="pageNumber" label="Page" current={sortBy} dir={sortDir} onClick={handleSort} />
                  <SortableHeader field="chunkIndex" label="Chunk #" current={sortBy} dir={sortDir} onClick={handleSort} />
                  <SortableHeader field="isExhibit" label="Type" current={sortBy} dir={sortDir} onClick={handleSort} />
                  <SortableHeader field="readinessScore" label="Score" current={sortBy} dir={sortDir} onClick={handleSort} className="!whitespace-nowrap" />
                  <SortableHeader field="documentId" label="Document" current={sortBy} dir={sortDir} onClick={handleSort} />
                  <SortableHeader field="createdAt" label="Indexed" current={sortBy} dir={sortDir} onClick={handleSort} />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {chunks.map((chunk) => {
                  const isExpanded = expandedChunk === chunk.id;
                  return (
                    <tr
                      key={chunk.id}
                      onClick={() => toggleChunk(chunk.id)}
                      className={`cursor-pointer transition-colors ${isExpanded ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 max-w-md">
                        {isExpanded ? (
                          <div>
                            <p className="text-gray-900 whitespace-pre-wrap break-words">{chunk.text}</p>
                            <div className="mt-3 pt-3 border-t border-gray-200 grid grid-cols-2 gap-x-4 gap-y-1">
                              <Detail label="Chunk ID" value={chunk.id} />
                              <Detail label="Case" value={getCaseName(chunk.caseId) || chunk.caseId} />
                              <Detail label="Text Length" value={`${chunk.text.length} chars`} />
                              {chunk.exhibitPath && <Detail label="Exhibit Path" value={chunk.exhibitPath} />}
                            </div>
                          </div>
                        ) : (
                          <p className="text-gray-700 truncate">{truncateText(chunk.text)}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{chunk.pageNumber}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{chunk.chunkIndex}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          chunk.isExhibit
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}>
                          {chunk.isExhibit ? 'Exhibit' : 'Text'}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {chunk.readinessScore != null ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${chunkScoreBadge(chunk.readinessScore)}`}>
                            {chunk.readinessScore}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap max-w-[200px] truncate" title={getDocName(chunk.documentId)}>
                        {getDocName(chunk.documentId)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                        {formatDate(chunk.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <p className="text-gray-500">No vector chunks found</p>
          <p className="text-sm text-gray-400 mt-2">
            {total === 0
              ? 'The vector database is empty. Process some documents first.'
              : 'Try adjusting your filters.'}
          </p>
        </div>
      )}

      {/* Bottom Pagination */}
      {totalPages > 1 && chunks.length > 10 && (
        <div className="flex justify-center">
          <Pagination page={page} totalPages={totalPages} loading={loading} onPageChange={handlePageChange} full />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Breakdown Content
// ---------------------------------------------------------------------------

function BreakdownContent({
  cases,
  stats,
  statsLoading,
  initialCaseId,
  reportFilter,
}: {
  cases: Case[];
  stats: VectorStats | null;
  statsLoading: boolean;
  initialCaseId?: string;
  reportFilter?: (f: VectorsFilter) => void;
}) {
  const router = useRouter();
  const getCaseName = (id: string) => cases.find(c => c.id === id)?.name;

  // Breakdown's only supported filter kind is case- (clicking a case bar
  // toggles it); the document breakdown narrows to the selected case.
  const [selectedCaseId, setSelectedCaseId] = useState(initialCaseId ?? '');
  const toggleCase = useCallback((id: string) => {
    const next = selectedCaseId === id ? '' : id;
    setSelectedCaseId(next);
    const filter: VectorsFilter = next ? { kind: 'case', id: next } : { kind: 'all' };
    reportFilter?.(filter);
    router.replace(buildVectorsPath('breakdown', filter), { scroll: false });
  }, [selectedCaseId, reportFilter, router]);

  if (!stats && statsLoading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full mx-auto" />
        <p className="text-gray-500 mt-4">Loading stats&hellip;</p>
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      {/* Case Breakdown */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Chunks by Case</h3>
        {stats.caseBreakdown.length > 0 ? (
          <div className="space-y-3">
            {stats.caseBreakdown.map((c) => (
              <div
                key={c.id}
                onClick={() => toggleCase(c.id)}
                title={selectedCaseId === c.id ? 'Click to clear case filter' : 'Click to filter documents by this case'}
                className={`cursor-pointer rounded-md transition-colors -mx-2 px-2 py-1 ${selectedCaseId === c.id ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-gray-50'}`}
              >
                <BarRow label={c.name} value={c.chunks} max={stats.totalChunks} color="bg-blue-500" />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No data</p>
        )}
      </div>

      {/* Document Breakdown */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Chunks by Document
          {selectedCaseId && (
            <span className="ml-2 text-sm font-normal text-blue-600">
              — {getCaseName(selectedCaseId) || 'selected case'}
            </span>
          )}
        </h3>
        {stats.documentBreakdown.length > 0 ? (
          <div className="space-y-2">
            {stats.documentBreakdown.filter(d => !selectedCaseId || d.caseId === selectedCaseId).map((d) => {
              const caseName = getCaseName(d.caseId);
              return (
                <div key={d.id} className="flex items-center gap-4">
                  <div className="w-64 min-w-0">
                    <p className="text-sm text-gray-700 truncate" title={d.name}>{d.name}</p>
                    {caseName && <p className="text-xs text-gray-400 truncate">{caseName}</p>}
                  </div>
                  <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
                    <div
                      className="bg-green-500 h-full rounded-full flex items-center justify-end pr-2 transition-all"
                      style={{ width: `${Math.max(8, (d.chunks / stats.totalChunks) * 100)}%` }}
                    >
                      <span className="text-xs text-white font-medium">{d.chunks}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No data</p>
        )}
      </div>

      {/* Content Type Distribution */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Content Type Distribution</h3>
        <div className="flex h-8 rounded-full overflow-hidden bg-gray-100">
          {stats.totalChunks > 0 && (
            <>
              <div
                className="bg-blue-500 flex items-center justify-center transition-all"
                style={{ width: `${(stats.textChunks / stats.totalChunks) * 100}%` }}
              >
                {stats.textChunks > 0 && (
                  <span className="text-xs text-white font-medium px-2">
                    Text {((stats.textChunks / stats.totalChunks) * 100).toFixed(1)}%
                  </span>
                )}
              </div>
              <div
                className="bg-amber-500 flex items-center justify-center transition-all"
                style={{ width: `${(stats.exhibitChunks / stats.totalChunks) * 100}%` }}
              >
                {stats.exhibitChunks > 0 && (
                  <span className="text-xs text-white font-medium px-2">
                    Exhibits {((stats.exhibitChunks / stats.totalChunks) * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        <div className="flex gap-6 mt-3">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <span className="text-sm text-gray-600">Text ({stats.textChunks.toLocaleString()})</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-500" />
            <span className="text-sm text-gray-600">Exhibits ({stats.exhibitChunks.toLocaleString()})</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Report Content
// ---------------------------------------------------------------------------

type PageSortField = 'pageNumber' | 'textPreview' | 'source' | 'chunkCount' | 'status' | 'score';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | 'indexed' | 'unindexed' | 'empty';

function truncateWords(text: string, maxWords = 40): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '\u2026';
}

function PageReportContent({
  cases,
  filings,
  documents,
  initialCaseId,
  initialDocumentId,
  initialStatusFilter,
  initialModalPage,
  initialViewerPage,
  reportFilter,
}: {
  cases: Case[];
  filings: Filing[];
  documents: Document[];
  initialCaseId?: string;
  initialDocumentId?: string;
  initialStatusFilter?: string;
  initialModalPage?: number;
  initialViewerPage?: number;
  reportFilter?: (f: VectorsFilter) => void;
}) {
  const router = useRouter();

  // Determine if URL has explicit params (they take priority over IndexedDB)
  const hasExplicitParams = !!(initialCaseId || initialDocumentId || initialStatusFilter);

  const [selectedCaseId, setSelectedCaseId] = useState(initialCaseId || '');
  const [selectedDocId, setSelectedDocId] = useState(initialDocumentId || '');
  const [reportData, setReportData] = useState<PageReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportPage, setReportPage] = useState(1);
  const rowsPerPage = 100;

  // Sorting
  const [sortField, setSortField] = useState<PageSortField>('pageNumber');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Status filter
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    initialStatusFilter === 'indexed' || initialStatusFilter === 'unindexed' || initialStatusFilter === 'empty' ? initialStatusFilter : 'all'
  );

  // Soft navigations (link click / URL edit on an already-mounted viewer)
  // update the initial* props WITHOUT remounting, so useState seeds are
  // stale. Re-sync explicit URL params into state when they change —
  // otherwise ?status=unindexed can render under a leftover filter (e.g.
  // 'empty' → empty list) from the previous interaction.
  useEffect(() => {
    if (initialStatusFilter === 'indexed' || initialStatusFilter === 'unindexed' || initialStatusFilter === 'empty') {
      setStatusFilter(initialStatusFilter);
      setReportPage(1);
    }
   
  }, [initialStatusFilter]);
  useEffect(() => {
    if (initialDocumentId) setSelectedDocId(initialDocumentId);
    if (initialCaseId) setSelectedCaseId(initialCaseId);
   
  }, [initialDocumentId, initialCaseId]);

  // Modals — both URL-addressable: page-{n} (chunks) / pageview-{n} (image viewer)
  const [pageViewerPage, setPageViewerPage] = useState<number | null>(
    initialDocumentId && initialViewerPage ? initialViewerPage : null,
  );
  const [chunksModalPage, setChunksModalPage] = useState<number | null>(
    initialDocumentId && initialModalPage ? initialModalPage : null,
  );

  // Selection
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());

  // Reindex state
  const [reindexing, setReindexing] = useState(false);
  const [reindexSuccess, setReindexSuccess] = useState(false);
  const [reindexMessage, setReindexMessage] = useState('');

  // Restore from IndexedDB on mount (only if no URL params)
  const idbInitialized = useRef(false);
  useEffect(() => {
    if (hasExplicitParams) {
      idbInitialized.current = true;
      return;
    }
    Promise.all([
      getPreference<string>('vectors.pageReport.caseId'),
      getPreference<string>('vectors.pageReport.documentId'),
      getPreference<string>('vectors.pageReport.statusFilter'),
    ]).then(([storedCase, storedDoc, storedStatus]) => {
      if (storedCase) setSelectedCaseId(storedCase);
      if (storedDoc) setSelectedDocId(storedDoc);
      const validStatus = storedStatus === 'indexed' || storedStatus === 'unindexed' || storedStatus === 'empty' || storedStatus === 'all';
      if (validStatus) {
        setStatusFilter(storedStatus as StatusFilter);
      }
      // Sync URL with restored IDB values (path-segment form)
      const filter: VectorsFilter = storedDoc
        ? { kind: 'doc', id: storedDoc }
        : storedCase
          ? { kind: 'case', id: storedCase }
          : { kind: 'all' };
      reportFilter?.(filter);
      const s = validStatus ? storedStatus : 'all';
      const params = new URLSearchParams();
      if (s && s !== 'all') params.set('status', s);
      router.replace(buildVectorsPath('pagereport', filter, undefined, params), { scroll: false });
      idbInitialized.current = true;
    }).catch(() => { idbInitialized.current = true; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update URL helper — /vectors/pagereport/{doc-|case-}{id}/{page-n | pageview-n}?status=
  const updateUrl = useCallback((overrides: { caseId?: string; documentId?: string; status?: string; modalPage?: number | null; viewerPage?: number | null }) => {
    const c = overrides.caseId ?? selectedCaseId;
    const d = overrides.documentId ?? selectedDocId;
    const s = overrides.status ?? statusFilter;
    const mp = overrides.modalPage === undefined ? chunksModalPage : overrides.modalPage;
    const vp = overrides.viewerPage === undefined ? pageViewerPage : overrides.viewerPage;
    const filter: VectorsFilter = d
      ? { kind: 'doc', id: d }
      : c
        ? { kind: 'case', id: c }
        : { kind: 'all' };
    reportFilter?.(filter);
    const params = new URLSearchParams();
    if (s && s !== 'all') params.set('status', s);
    // page selections only meaningful with a document selected;
    // the image viewer wins when both modals have state
    const selection = d && vp ? `pageview-${vp}` : d && mp ? `page-${mp}` : undefined;
    router.replace(buildVectorsPath('pagereport', filter, selection, params), { scroll: false });
  }, [router, reportFilter, selectedCaseId, selectedDocId, statusFilter, chunksModalPage, pageViewerPage]);

  const openChunksModal = useCallback((p: number) => {
    setChunksModalPage(p);
    updateUrl({ modalPage: p });
  }, [updateUrl]);

  const closeChunksModal = useCallback(() => {
    setChunksModalPage(null);
    updateUrl({ modalPage: null });
  }, [updateUrl]);

  const openPageViewer = useCallback((p: number) => {
    setPageViewerPage(p);
    updateUrl({ viewerPage: p });
  }, [updateUrl]);

  const closePageViewer = useCallback(() => {
    setPageViewerPage(null);
    updateUrl({ viewerPage: null });
  }, [updateUrl]);

  // Handlers that sync state + IndexedDB + URL
  const handleCaseChange = useCallback((id: string) => {
    setSelectedCaseId(id);
    setSelectedDocId('');
    setSelectedPages(new Set());
    setChunksModalPage(null);
    setPageViewerPage(null);
    setPreference('vectors.pageReport.caseId', id).catch(() => {});
    setPreference('vectors.pageReport.documentId', '').catch(() => {});
    updateUrl({ caseId: id, documentId: '', modalPage: null, viewerPage: null });
  }, [updateUrl]);

  const handleDocChange = useCallback((id: string) => {
    setSelectedDocId(id);
    setSelectedPages(new Set());
    setChunksModalPage(null);
    setPageViewerPage(null);
    setPreference('vectors.pageReport.documentId', id).catch(() => {});
    updateUrl({ documentId: id, modalPage: null, viewerPage: null });
  }, [updateUrl]);

  const handleStatusFilter = useCallback((f: StatusFilter) => {
    setStatusFilter(f);
    setReportPage(1);
    setPreference('vectors.pageReport.statusFilter', f).catch(() => {});
    updateUrl({ status: f });
  }, [updateUrl]);

  const filteredDocs = documents.filter(d => {
    if (selectedCaseId && d.caseId !== selectedCaseId) return false;
    return true;
  });

  // Fetch report when document changes
  useEffect(() => {
    if (!selectedDocId) {
      setReportData(null);
      return;
    }
    let cancelled = false;
    const fetchReport = async () => {
      setLoading(true);
      setError(null);
      setReportPage(1);
      setSortField('pageNumber');
      setSortDir('asc');
      // Don't reset statusFilter on doc change — keep the filter from URL/IDB
      try {
        const res = await fetch(`/api/vectors/page-report?documentId=${selectedDocId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch page report');
        if (!cancelled) setReportData(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchReport();
    return () => { cancelled = true; };
  }, [selectedDocId]);

  // Filter + sort + paginate
  const processedPages = useMemo(() => {
    if (!reportData) return [];
    let pages = reportData.pages;

    // Filter by status
    if (statusFilter !== 'all') {
      pages = pages.filter(p => p.status === statusFilter);
    }

    // Sort
    const dir = sortDir === 'asc' ? 1 : -1;
    pages = [...pages].sort((a, b) => {
      switch (sortField) {
        case 'pageNumber': return (a.pageNumber - b.pageNumber) * dir;
        case 'textPreview': return a.textPreview.localeCompare(b.textPreview) * dir;
        case 'source': return (a.source || '').localeCompare(b.source || '') * dir;
        case 'chunkCount': return (a.chunkCount - b.chunkCount) * dir;
        case 'status': return a.status.localeCompare(b.status) * dir;
        case 'score': {
          // Unscored/blank pages sort last regardless of direction.
          const av = a.pageClass === 'blank' ? null : a.score ?? null;
          const bv = b.pageClass === 'blank' ? null : b.score ?? null;
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (av - bv) * dir;
        }
        default: return 0;
      }
    });

    return pages;
  }, [reportData, statusFilter, sortField, sortDir]);

  const paginatedPages = processedPages.slice((reportPage - 1) * rowsPerPage, reportPage * rowsPerPage);
  const reportTotalPages = Math.ceil(processedPages.length / rowsPerPage);

  const handleSort = (field: PageSortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
    setReportPage(1);
  };

  // Selection helpers
  const allVisibleSelected = paginatedPages.length > 0 && paginatedPages.every(p => selectedPages.has(p.pageNumber));

  const togglePage = (pageNum: number) => {
    setSelectedPages(prev => {
      const next = new Set(prev);
      if (next.has(pageNum)) next.delete(pageNum);
      else next.add(pageNum);
      return next;
    });
  };

  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedPages(prev => {
        const next = new Set(prev);
        paginatedPages.forEach(p => next.delete(p.pageNumber));
        return next;
      });
    } else {
      setSelectedPages(prev => {
        const next = new Set(prev);
        paginatedPages.forEach(p => next.add(p.pageNumber));
        return next;
      });
    }
  };

  // Reindex handler — selectively reindex only the selected pages
  const handleReindex = async () => {
    if (!selectedDocId || reindexing || selectedPages.size === 0) return;
    setReindexing(true);
    setReindexSuccess(false);
    setError(null);
    try {
      const pageNumbers = Array.from(selectedPages).sort((a, b) => a - b);
      const res = await fetch(`/api/documents/${selectedDocId}/reindex-pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages: pageNumbers }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to reindex pages');
      }
      setSelectedPages(new Set());
      setReindexSuccess(true);
      setReindexMessage(`Reindexed ${data.pagesProcessed} pages, ${data.chunksCreated} chunks created${data.ocrPages ? `, ${data.ocrPages} OCR` : ''}${data.emptyPages?.length ? `, ${data.emptyPages.length} empty` : ''}`);
      // Refresh the report data
      const reportRes = await fetch(`/api/vectors/page-report?documentId=${selectedDocId}`);
      const reportJson = await reportRes.json();
      if (reportRes.ok) setReportData(reportJson);
      // Auto-hide success after 5s
      setTimeout(() => { setReindexSuccess(false); setReindexMessage(''); }, 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reindex failed');
    } finally {
      setReindexing(false);
    }
  };

  // Select all unindexed pages helper
  const selectAllUnindexed = () => {
    if (!reportData) return;
    const unindexed = reportData.pages.filter(p => p.status === 'unindexed').map(p => p.pageNumber);
    setSelectedPages(new Set(unindexed));
  };

  return (
    <>
      {/* Selectors */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Case</label>
            <select
              value={selectedCaseId}
              onChange={(e) => handleCaseChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">All Cases</option>
              {cases.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Document</label>
            <select
              value={selectedDocId}
              onChange={(e) => handleDocChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Select a document...</option>
              {filteredDocs.map((d) => (
                <option key={d.id} value={d.id}>{docOptionLabel(d)}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
          <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full mx-auto" />
          <p className="text-gray-500 mt-4">Loading page report&hellip;</p>
        </div>
      )}

      {/* Report Data */}
      {reportData && !loading && (
        <>
          {/* Summary Bar */}
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-lg p-4 bg-green-50 text-green-700">
              <p className="text-xs font-medium opacity-75">Indexed Pages</p>
              <p className="text-2xl font-bold mt-1">{reportData.summary.indexedPages.toLocaleString()}</p>
            </div>
            <div className="rounded-lg p-4 bg-red-50 text-red-700">
              <p className="text-xs font-medium opacity-75">Unindexed Pages</p>
              <p className="text-2xl font-bold mt-1">{reportData.summary.unindexedPages.toLocaleString()}</p>
            </div>
            <div className="rounded-lg p-4 bg-blue-50 text-blue-700">
              <p className="text-xs font-medium opacity-75">Total Pages</p>
              <p className="text-2xl font-bold mt-1">{reportData.totalPages.toLocaleString()}</p>
            </div>
          </div>

          {/* Reindex Action Bar */}
          {(selectedPages.size > 0 || reindexSuccess) && (
            <div className={`sticky top-0 z-10 ${reindexSuccess ? 'bg-green-600' : 'bg-blue-600'} text-white rounded-lg px-4 py-3 flex items-center justify-between shadow-md`}>
              <span className="text-sm font-medium">
                {reindexSuccess
                  ? reindexMessage
                  : `${selectedPages.size} page${selectedPages.size !== 1 ? 's' : ''} selected`}
              </span>
              {!reindexSuccess && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setSelectedPages(new Set())}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-blue-500 hover:bg-blue-400 transition-colors"
                  >
                    Clear
                  </button>
                  <button
                    onClick={handleReindex}
                    disabled={reindexing}
                    className="px-4 py-1.5 rounded-md text-xs font-medium bg-white text-blue-700 hover:bg-blue-50 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {reindexing ? (
                      <>
                        <div className="animate-spin h-3.5 w-3.5 border-2 border-blue-600 border-t-transparent rounded-full" />
                        Reindexing {selectedPages.size} pages...
                      </>
                    ) : (
                      `Reindex ${selectedPages.size} Page${selectedPages.size !== 1 ? 's' : ''}`
                    )}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Select All Unindexed shortcut */}
          {reportData && reportData.summary.unindexedPages > 0 && selectedPages.size === 0 && !reindexSuccess && (
            <div className="flex items-center gap-2">
              <button
                onClick={selectAllUnindexed}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 transition-colors"
              >
                Select All {reportData.summary.unindexedPages} Unindexed Pages
              </button>
            </div>
          )}

          {/* Status Filter + Pagination */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {(['all', 'indexed', 'unindexed', 'empty'] as const).map(f => {
                const activeColor = f === 'indexed' ? 'bg-green-100 text-green-800'
                  : f === 'unindexed' ? 'bg-red-100 text-red-800'
                  : f === 'empty' ? 'bg-gray-200 text-gray-700'
                  : 'bg-blue-100 text-blue-800';
                const count = f === 'all' ? reportData.pages.length
                  : f === 'indexed' ? reportData.summary.indexedPages
                  : f === 'unindexed' ? reportData.summary.unindexedPages
                  : (reportData.summary.emptyPages || 0);
                const label = f.charAt(0).toUpperCase() + f.slice(1);
                return (
                  <button
                    key={f}
                    onClick={() => handleStatusFilter(f)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      statusFilter === f ? activeColor : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {`${label} (${count})`}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3">
              <p className="text-sm text-gray-500">
                {processedPages.length} pages
              </p>
              {reportTotalPages > 1 && (
                <Pagination
                  page={reportPage}
                  totalPages={reportTotalPages}
                  loading={false}
                  onPageChange={setReportPage}
                />
              )}
            </div>
          </div>

          {/* Page Table */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleAllVisible}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                      />
                    </th>
                    <SortableHeader field="pageNumber" label="Page" current={sortField} dir={sortDir} onClick={handleSort} className="w-16" />
                    <SortableHeader field="textPreview" label="Text Preview" current={sortField} dir={sortDir} onClick={handleSort} />
                    <SortableHeader field="source" label="Source" current={sortField} dir={sortDir} onClick={handleSort} className="w-20" />
                    <SortableHeader field="chunkCount" label="Chunks" current={sortField} dir={sortDir} onClick={handleSort} className="w-20" />
                    <SortableHeader field="score" label="Score" current={sortField} dir={sortDir} onClick={handleSort} className="w-20" />
                    <SortableHeader field="status" label="Status" current={sortField} dir={sortDir} onClick={handleSort} className="w-24" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {paginatedPages.map((p) => (
                    <tr key={p.pageNumber} className={`${p.status === 'unindexed' ? 'bg-red-50/30' : p.status === 'empty' ? 'bg-gray-50/50' : 'hover:bg-gray-50'} ${selectedPages.has(p.pageNumber) ? 'bg-blue-50/40' : ''}`}>
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selectedPages.has(p.pageNumber)}
                          onChange={() => togglePage(p.pageNumber)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => openPageViewer(p.pageNumber)}
                          className="text-blue-600 hover:text-blue-800 hover:underline font-mono text-xs cursor-pointer"
                          title="View PDF page"
                        >
                          {p.pageNumber}
                        </button>
                      </td>
                      <td className="px-4 py-2.5">
                        {p.textPreview ? (
                          <p className="text-gray-700 text-xs truncate" title={p.textPreview}>
                            {truncateWords(p.textPreview)}
                          </p>
                        ) : (
                          <button
                            onClick={() => openPageViewer(p.pageNumber)}
                            className="text-gray-400 italic text-xs hover:text-blue-600 hover:underline cursor-pointer inline-flex items-center gap-1"
                            title="No text extracted — click to view PDF page"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            no text — view page
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                        {p.source ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            p.source === 'ocr' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'
                          }`}>
                            {p.source}
                          </span>
                        ) : (
                          <span className="text-gray-300">&mdash;</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs whitespace-nowrap">
                        {p.chunkCount > 0 ? (
                          <button
                            onClick={() => openChunksModal(p.pageNumber)}
                            className="text-blue-600 hover:text-blue-800 hover:underline font-medium cursor-pointer"
                          >
                            {p.chunkCount}
                            {p.hasExhibit && (
                              <span className="ml-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">
                                exhibit
                              </span>
                            )}
                          </button>
                        ) : (
                          <span className="text-gray-400">0</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {p.pageClass === 'blank' ? (
                          <span className="text-gray-400 text-xs italic" title="Blank page — excluded from scoring">blank</span>
                        ) : p.score != null ? (
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${chunkScoreBadge(p.score)}`}
                            title={`${p.pageClass ?? ''}${p.flags && p.flags.length ? ` — ${p.flags.join(', ')}` : ''}`}
                          >
                            {p.score}
                          </span>
                        ) : (
                          <span className="text-gray-300">&mdash;</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {p.status === 'indexed' ? (
                          <button
                            onClick={() => openPageViewer(p.pageNumber)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200 transition-colors cursor-pointer"
                            title="View PDF page"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                            indexed
                          </button>
                        ) : p.status === 'empty' ? (
                          <button
                            onClick={() => openPageViewer(p.pageNumber)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors cursor-pointer"
                            title="View PDF page (empty)"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
                            </svg>
                            empty
                          </button>
                        ) : (
                          <button
                            onClick={() => openPageViewer(p.pageNumber)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 transition-colors cursor-pointer"
                            title="View PDF page"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            unindexed
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bottom Pagination */}
          {reportTotalPages > 1 && paginatedPages.length > 20 && (
            <div className="flex justify-center">
              <Pagination
                page={reportPage}
                totalPages={reportTotalPages}
                loading={false}
                onPageChange={setReportPage}
                full
              />
            </div>
          )}
        </>
      )}

      {/* Empty State */}
      {!selectedDocId && !loading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg className="w-16 h-16 text-gray-200 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <h3 className="text-lg font-medium text-gray-400 mb-1">Select a Document</h3>
          <p className="text-sm text-gray-400">Choose a document to view per-page indexing status</p>
        </div>
      )}

      {/* PDF Page Viewer Modal */}
      {pageViewerPage !== null && selectedDocId && (
        <PageViewerModal
          documentId={selectedDocId}
          pageNumber={pageViewerPage}
          totalPages={reportData?.totalPages || 0}
          onClose={closePageViewer}
          onNavigate={openPageViewer}
        />
      )}

      {/* Chunks Modal */}
      {chunksModalPage !== null && selectedDocId && (
        <ChunksModal
          documentId={selectedDocId}
          pageNumber={chunksModalPage}
          onClose={closeChunksModal}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sortable Header
// ---------------------------------------------------------------------------

function SortableHeader<F extends string>({
  field,
  label,
  current,
  dir,
  onClick,
  className = '',
}: {
  field: F;
  label: string;
  /** '' = no active sort (tableview's initial state) */
  current: F | '';
  dir: SortDir;
  onClick: (f: F) => void;
  className?: string;
}) {
  const isActive = current === field;
  return (
    <th
      className={`px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap select-none cursor-pointer hover:bg-gray-100 transition-colors ${className}`}
      onClick={() => onClick(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
            {dir === 'asc' ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
            )}
          </svg>
        ) : (
          <svg className="w-3 h-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 15L12 18.75 15.75 15m-7.5-6L12 5.25 15.75 9" />
          </svg>
        )}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// PDF Page Viewer Modal
// ---------------------------------------------------------------------------

function PageViewerModal({
  documentId,
  pageNumber,
  totalPages,
  onClose,
  onNavigate,
}: {
  documentId: string;
  pageNumber: number;
  totalPages: number;
  onClose: () => void;
  onNavigate: (page: number) => void;
}) {
  const [imgLoading, setImgLoading] = useState(true);
  const [imgError, setImgError] = useState(false);
  const imgSrc = `/api/documents/${documentId}/page-image/${pageNumber}?scale=1.5`;

  // Reset state on page change
  useEffect(() => {
    setImgLoading(true);
    setImgError(false);
  }, [pageNumber]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && pageNumber > 1) onNavigate(pageNumber - 1);
      if (e.key === 'ArrowRight' && pageNumber < totalPages) onNavigate(pageNumber + 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, onNavigate, pageNumber, totalPages]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl flex flex-col max-w-4xl w-full max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-900">Page {pageNumber}</h3>
            <span className="text-xs text-gray-400">of {totalPages}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onNavigate(pageNumber - 1)}
              disabled={pageNumber <= 1}
              className="px-2 py-1 text-xs border border-gray-300 rounded disabled:opacity-30 hover:bg-gray-50 transition-colors"
            >
              Prev
            </button>
            <button
              onClick={() => onNavigate(pageNumber + 1)}
              disabled={pageNumber >= totalPages}
              className="px-2 py-1 text-xs border border-gray-300 rounded disabled:opacity-30 hover:bg-gray-50 transition-colors"
            >
              Next
            </button>
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-gray-100 flex items-start justify-center p-4">
          {imgLoading && !imgError && (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
            </div>
          )}
          {imgError ? (
            <div className="text-center py-20">
              <p className="text-gray-500 text-sm">Failed to load page image</p>
              <p className="text-xs text-gray-400 mt-1">The server may not support page image rendering</p>
            </div>
          ) : (
            <img
              src={imgSrc}
              alt={`Page ${pageNumber}`}
              className={`max-w-full shadow-lg rounded ${imgLoading ? 'hidden' : ''}`}
              onLoad={() => setImgLoading(false)}
              onError={() => { setImgLoading(false); setImgError(true); }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chunks Modal
// ---------------------------------------------------------------------------

function ChunksModal({
  documentId,
  pageNumber,
  onClose,
}: {
  documentId: string;
  pageNumber: number;
  onClose: () => void;
}) {
  const [chunks, setChunks] = useState<VectorChunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchChunks = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          documentId,
          pageMin: String(pageNumber),
          pageMax: String(pageNumber),
          limit: '200',
          page: '1',
        });
        const res = await fetch(`/api/vectors?${params}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch chunks');
        if (!cancelled) setChunks(data.chunks);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'An error occurred');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchChunks();
    return () => { cancelled = true; };
  }, [documentId, pageNumber]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl flex flex-col max-w-3xl w-full max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-900">Chunks on Page {pageNumber}</h3>
            {!loading && <span className="text-xs text-gray-400">{chunks.length} chunk{chunks.length !== 1 ? 's' : ''}</span>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
            </div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}
          {!loading && !error && chunks.length === 0 && (
            <p className="text-gray-500 text-sm text-center py-8">No chunks found for this page</p>
          )}
          {!loading && chunks.map((chunk) => (
            <div key={chunk.id} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-gray-500">Chunk #{chunk.chunkIndex}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${
                  chunk.isExhibit ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                }`}>
                  {chunk.isExhibit ? 'Exhibit' : 'Text'}
                </span>
                <span className="text-[10px] text-gray-400 ml-auto">{chunk.text.length} chars</span>
              </div>
              <p className="text-xs text-gray-800 whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto">
                {chunk.text}
              </p>
              {chunk.exhibitPath && (
                <p className="text-[10px] text-gray-400 mt-2">Exhibit: {chunk.exhibitPath}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vector Docs Panel (right sidebar)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Meta View — docparse structure inspector (blocks, headings, bbox overlay)
// URL: /vectors/metaview/{doc-|case-}{id}/{page-n}
// Reads /api/documents/[id]/structure (SQLite PageCache.structuredJson).
// ---------------------------------------------------------------------------

/** RR per-line overlay: one color per parent paragraph (speaker turn),
 * cycled by block index so adjacent turns always differ. */
const LINE_PALETTE = [
  { border: 'border-sky-500/70', bg: 'bg-sky-500/10', label: 'text-sky-600' },
  { border: 'border-emerald-500/70', bg: 'bg-emerald-500/10', label: 'text-emerald-600' },
  { border: 'border-amber-500/70', bg: 'bg-amber-500/10', label: 'text-amber-600' },
  { border: 'border-fuchsia-500/70', bg: 'bg-fuchsia-500/10', label: 'text-fuchsia-600' },
];

const BLOCK_COLORS: Record<string, string> = {
  heading: 'border-amber-500 bg-amber-500/15',
  paragraph: 'border-blue-400 bg-blue-400/10',
  table: 'border-green-500 bg-green-500/15',
  footnote: 'border-cyan-500 bg-cyan-500/15',
  page_header: 'border-gray-400 bg-gray-400/20',
  page_footer: 'border-gray-400 bg-gray-400/20',
  page_number: 'border-gray-400 bg-gray-400/20',
  seal: 'border-purple-500 bg-purple-500/15',
  signature: 'border-purple-500 bg-purple-500/15',
  figure: 'border-pink-500 bg-pink-500/15',
  unknown: 'border-red-500 bg-red-500/15',
};

const BLOCK_CHIP: Record<string, string> = {
  heading: 'bg-amber-100 text-amber-800',
  paragraph: 'bg-blue-100 text-blue-800',
  table: 'bg-green-100 text-green-800',
  footnote: 'bg-cyan-100 text-cyan-800',
  page_header: 'bg-gray-100 text-gray-600',
  page_footer: 'bg-gray-100 text-gray-600',
  page_number: 'bg-gray-100 text-gray-600',
  seal: 'bg-purple-100 text-purple-800',
  signature: 'bg-purple-100 text-purple-800',
  figure: 'bg-pink-100 text-pink-800',
  unknown: 'bg-red-100 text-red-800',
};

interface MetaBlock {
  type: string;
  text: string;
  html?: string;
  bbox: [number, number, number, number] | null;
  order: number;
  identifiers?: { batesNumber?: string; fileStamp?: string };
  /** RR producer (PLAN-rr-structure): speaker turns with printed line numbers */
  speaker?: string;
  lineStart?: number;
  lineEnd?: number;
  lines?: { lineNumber?: number; text: string; bbox: [number, number, number, number] | null }[];
}

interface MetaSummaryPage {
  pageNumber: number;
  parseMethod: string | null;
  producer: string | null;
  counts: Record<string, number>;
  headings: string[];
}

function MetaViewContent({
  cases,
  documents,
  initialCaseId,
  initialDocumentId,
  initialPage,
  reportFilter,
}: {
  cases: Case[];
  documents: Document[];
  initialCaseId?: string;
  initialDocumentId?: string;
  initialPage?: number;
  reportFilter?: (f: VectorsFilter) => void;
}) {
  const router = useRouter();
  const [selectedCaseId, setSelectedCaseId] = useState(
    initialCaseId ?? (initialDocumentId ? documents.find(d => d.id === initialDocumentId)?.caseId ?? '' : ''),
  );
  const [selectedDocId, setSelectedDocId] = useState(initialDocumentId ?? '');
  const [summary, setSummary] = useState<{ parserVersion: string | null; structuredPages: number; pageCount: number | null; pages: MetaSummaryPage[] } | null>(null);
  const [selectedPage, setSelectedPage] = useState<number | null>(initialPage ?? null);
  const [detail, setDetail] = useState<{ blocks: MetaBlock[]; producer?: string; parseMethod?: string | null; pageDims?: { width: number; height: number } | null; structured: boolean } | null>(null);
  const [view, setView] = useState<'blocks' | 'overlay' | 'chunks'>('overlay');
  const [showParaNums, setShowParaNums] = useState(false);
  const [pageChunks, setPageChunks] = useState<{
    id: string; text: string; chunkIndex: number; startLine: number | null;
    endLine: number | null; isExhibit: boolean; readinessScore: number | null;
  }[] | null>(null);
  // Figures whose OCR text the operator clicked away (click again to restore)
  const [hiddenFigs, setHiddenFigs] = useState<Set<number>>(new Set());
  const toggleFig = (order: number) => setHiddenFigs(prev => {
    const next = new Set(prev);
    if (next.has(order)) next.delete(order); else next.add(order);
    return next;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredDocs = documents.filter(d => !selectedCaseId || d.caseId === selectedCaseId);

  const syncUrl = useCallback((docId: string, page: number | null) => {
    const filter: VectorsFilter = docId
      ? { kind: 'doc', id: docId }
      : selectedCaseId
        ? { kind: 'case', id: selectedCaseId }
        : { kind: 'all' };
    reportFilter?.(filter);
    router.replace(buildVectorsPath('metaview', filter, docId && page ? `page-${page}` : undefined), { scroll: false });
  }, [router, reportFilter, selectedCaseId]);

  // Fetch document summary
  useEffect(() => {
    if (!selectedDocId) { setSummary(null); setDetail(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/documents/${selectedDocId}/structure`)
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        if (data.error) { setError(data.error); setSummary(null); return; }
        setSummary(data);
        // auto-select: URL page if valid, else first structured page
        if (data.pages?.length) {
          const target = data.pages.find((p: MetaSummaryPage) => p.pageNumber === selectedPage)
            ? selectedPage
            : data.pages[0].pageNumber;
          setSelectedPage(target);
        } else {
          setSelectedPage(null);
        }
      })
      .catch(e => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDocId]);

  // Fetch page detail
  useEffect(() => {
    if (!selectedDocId || selectedPage == null) { setDetail(null); return; }
    let cancelled = false;
    setHiddenFigs(new Set());
    setPageChunks(null);
    fetch(`/api/documents/${selectedDocId}/structure?page=${selectedPage}`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setDetail(data); })
      .catch(() => {});
    fetch(`/api/documents/${selectedDocId}/chunks?page=${selectedPage}`)
      .then(res => res.json())
      .then(data => { if (!cancelled) setPageChunks(data.chunks ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedDocId, selectedPage]);

  const pickPage = (p: number) => {
    setSelectedPage(p);
    syncUrl(selectedDocId, p);
  };

  const countChips = (counts: Record<string, number>) => {
    // '¶' not 'P': the page rows also render p{pageNumber} — 'p19 P16' read
    // as paragraph numbering to an operator (debug finding 2026-08-06)
    const short: Record<string, string> = { heading: 'H', paragraph: '¶', table: 'T', page_header: 'hd', page_footer: 'ft', page_number: '#', footnote: 'fn' };
    return Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${short[t] ?? t}${n}`)
      .join(' ');
  };

  return (
    <div className="space-y-4">
      {/* Pickers */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Case</label>
          <select
            value={selectedCaseId}
            onChange={e => { setSelectedCaseId(e.target.value); setSelectedDocId(''); setSummary(null); setDetail(null); }}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            <option value="">All Cases</option>
            {cases.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Document</label>
          <select
            value={selectedDocId}
            onChange={e => { setSelectedDocId(e.target.value); setSelectedPage(null); syncUrl(e.target.value, null); }}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          >
            <option value="">Select a document…</option>
            {filteredDocs.map(d => <option key={d.id} value={d.id}>{docOptionLabel(d)}</option>)}
          </select>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">{error}</div>}
      {loading && <div className="text-sm text-gray-500">Loading structure…</div>}

      {summary && !loading && (
        summary.pages.length === 0 ? (
          summary.parserVersion ? (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
              The structure stage ran on this document ({summary.parserVersion}) and stored no
              structured pages — expected for fully scanned documents with no extractable text.
              <strong> Reporter&apos;s Record / transcript volumes now DO get structure</strong> (speaker
              turns with printed line numbers, producer <code>rr</code>) — if this is an RR indexed
              before that landed, re-index it via clear-index to attach structure.
            </div>
          ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
            No structure stored for this document (parserVersion: none). It was indexed before
            structured parsing was enabled — re-index it via clear-index to attach structure.
          </div>
          )
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Page list */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">
                {summary.structuredPages}/{summary.pageCount ?? '?'} pages structured
              </span>
              <span className="text-xs text-gray-400 font-mono">{summary.parserVersion}</span>
            </div>
            <div
              className="px-4 py-1.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between gap-2 text-[11px] font-medium text-gray-500"
              title="H=heading · ¶=paragraph · T=table · hd=page header · ft=page footer · #=page number · fn=footnote"
            >
              <span>Page</span>
              <span>Blocks (H heading · ¶ para · T table · hd/ft furniture)</span>
            </div>
            <div className="overflow-y-auto max-h-[70vh] divide-y divide-gray-100">
              {summary.pages.map(p => (
                <div
                  key={p.pageNumber}
                  onClick={() => pickPage(p.pageNumber)}
                  className={`px-4 py-2 cursor-pointer text-sm flex items-center justify-between gap-2 ${selectedPage === p.pageNumber ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  <span className="font-medium text-gray-800">p{p.pageNumber}</span>
                  <span className="text-xs text-gray-500 font-mono truncate">{countChips(p.counts)}</span>
                  {p.producer !== 'rr' && (p.counts.heading ?? 0) === 0 && <span className="text-[10px] text-amber-600" title="No headings detected on this page">⚠H0</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Detail */}
          <div className="lg:col-span-2 bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">
                Page {selectedPage} — {detail?.producer ?? '…'} / {detail?.parseMethod ?? ''}
              </span>
              <div className="flex items-center gap-1">
                {view === 'overlay' && (
                  <label className="flex items-center gap-1 text-xs text-gray-600 mr-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={showParaNums}
                      onChange={e => setShowParaNums(e.target.checked)}
                    />
                    ¶ numbers
                  </label>
                )}
                {(['overlay', 'blocks', 'chunks'] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className={`text-xs px-2.5 py-1 rounded ${view === v ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                  >
                    {v === 'overlay' ? 'Overlay' : v === 'blocks' ? 'Blocks' : 'Chunks'}
                  </button>
                ))}
              </div>
            </div>

            {detail && view === 'overlay' && (
              <div className="p-4 overflow-auto max-h-[70vh]">
                {detail.pageDims ? (
                  <div className="relative inline-block w-full" style={{ containerType: 'inline-size' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/documents/${selectedDocId}/page-image/${selectedPage}?scale=1.5`}
                      alt={`Page ${selectedPage}`}
                      className="block w-full h-auto border border-gray-200"
                    />
                    {(() => {
                      let paraOrdinal = 0;
                      return detail.blocks.filter(b => b.bbox).map(b => {
                        const [x0, y0, x1, y1] = b.bbox!;
                        const { width: pw, height: ph } = detail.pageDims!;
                        const pn = b.type === 'paragraph' ? ++paraOrdinal : null;
                        return (
                          <div
                            key={b.order}
                            title={`[${b.order}] ${b.type}: ${b.text.slice(0, 140)}`}
                            onClick={b.type === 'figure' && b.text ? () => toggleFig(b.order) : undefined}
                            className={`absolute border ${BLOCK_COLORS[b.type] ?? BLOCK_COLORS.unknown}${b.type === 'figure' && b.text ? ' cursor-pointer' : ''}`}
                            style={{
                              left: `${(x0 / pw) * 100}%`,
                              top: `${(y0 / ph) * 100}%`,
                              width: `${((x1 - x0) / pw) * 100}%`,
                              height: `${((y1 - y0) / ph) * 100}%`,
                            }}
                          >
                            {showParaNums && pn !== null && (
                              <span className="absolute -top-2 -left-1 px-1 rounded bg-blue-600 text-white text-[9px] font-mono leading-3">
                                ¶{pn}
                              </span>
                            )}
                            {b.type === 'figure' && b.text && !(b.lines?.length) && !hiddenFigs.has(b.order) && (
                              <div className="absolute inset-0 overflow-y-auto p-1.5 bg-white/80 text-[10px] leading-tight text-gray-900 whitespace-pre-wrap">
                                {b.text}
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}
                    {/* Figure OCR lines aligned to their position in the image
                        (ink-band alignment; falls back to the block panel when
                        alignment was not possible) */}
                    {detail.blocks.filter(b => b.type === 'figure' && b.lines?.length && !hiddenFigs.has(b.order)).flatMap(b =>
                      b.lines!.filter(l => l.bbox).map((l, li) => {
                        const [x0, y0, x1, y1] = l.bbox!;
                        const { width: pw, height: ph } = detail.pageDims!;
                        return (
                          <div
                            key={`fig${b.order}-${li}`}
                            onClick={() => toggleFig(b.order)}
                            className="absolute bg-white/85 text-gray-900 leading-none whitespace-nowrap overflow-hidden cursor-pointer"
                            style={{
                              left: `${(x0 / pw) * 100}%`,
                              top: `${(y0 / ph) * 100}%`,
                              width: `${((x1 - x0) / pw) * 100}%`,
                              height: `${((y1 - y0) / ph) * 100}%`,
                              // cqw tracks the rendered page width, so glyphs
                              // scale with the image; band height in pt →
                              // fraction of page width → container units
                              fontSize: `${Math.max(0.8, ((y1 - y0) / pw) * 82)}cqw`,
                            }}
                            title={l.text}
                          >
                            {l.text}
                          </div>
                        );
                      }))}
                    {/* RR per-line rects labelled with printed line numbers */}
                    {detail.blocks.flatMap((b, bi) => (b.lines ?? [])
                      .filter(l => l.bbox && l.lineNumber != null)
                      .map(l => {
                        const [x0, y0, x1, y1] = l.bbox!;
                        const { width: pw, height: ph } = detail.pageDims!;
                        // one color per parent paragraph (speaker turn), cycling —
                        // adjacent turns never share a color, so line→paragraph
                        // membership is readable at a glance
                        const c = LINE_PALETTE[bi % LINE_PALETTE.length];
                        return (
                          <div
                            key={`${b.order}-l${l.lineNumber}`}
                            title={`${b.speaker ? b.speaker + ' · ' : ''}Line ${l.lineNumber}: ${l.text.slice(0, 120)}`}
                            className={`absolute border border-dashed ${c.border} ${c.bg}`}
                            style={{
                              left: `${(x0 / pw) * 100}%`,
                              top: `${(y0 / ph) * 100}%`,
                              width: `${((x1 - x0) / pw) * 100}%`,
                              height: `${((y1 - y0) / ph) * 100}%`,
                            }}
                          >
                            <span className={`absolute -left-6 top-0 text-[9px] font-mono ${c.label}`}>{l.lineNumber}</span>
                          </div>
                        );
                      }))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">Page dimensions unavailable — overlay disabled (blocks list still works).</p>
                )}
                <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                  {Object.entries(BLOCK_CHIP).filter(([t]) => detail.blocks.some(b => b.type === t)).map(([t, cls]) => (
                    <span key={t} className={`px-1.5 py-0.5 rounded ${cls}`}>{t}</span>
                  ))}
                </div>
                {/* RR line-color legend: one chip per block, in its overlay
                    color, labelled with speaker (or block type) + line range */}
                {detail.blocks.some(b => b.lines?.some(l => l.lineNumber != null)) && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                    {detail.blocks.map((b, bi) => {
                      if (!b.lines?.some(l => l.lineNumber != null)) return null;
                      const c = LINE_PALETTE[bi % LINE_PALETTE.length];
                      const range = b.lineStart != null
                        ? (b.lineStart === b.lineEnd ? ` L${b.lineStart}` : ` L${b.lineStart}–${b.lineEnd}`)
                        : '';
                      return (
                        <span key={b.order} className={`px-1.5 py-0.5 rounded border ${c.border} ${c.bg} ${c.label} font-medium`}>
                          {b.speaker ?? b.type}{range}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {detail && view === 'chunks' && (
              <div className="p-4 overflow-auto max-h-[70vh] grid grid-cols-1 xl:grid-cols-2 gap-4">
                {/* Stored chunks (what the vector store actually holds) */}
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-2">
                    Stored chunks — {pageChunks?.length ?? '…'} on this page (SAC prefix included)
                  </div>
                  <div className="space-y-3">
                    {(pageChunks ?? []).map(c => {
                      const sacEnd = c.text.startsWith('[') ? c.text.indexOf(']') + 1 : 0;
                      return (
                        <div key={c.id} className="border border-gray-200 rounded p-2">
                          <div className="flex flex-wrap items-center gap-2 text-[10px] mb-1">
                            <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 font-mono">#{c.chunkIndex}</span>
                            {c.startLine != null && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono">
                                L{c.startLine}{c.endLine !== c.startLine ? `–${c.endLine}` : ''}
                              </span>
                            )}
                            {c.isExhibit && <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800">exhibit</span>}
                            {c.readinessScore != null && c.readinessScore >= 0 && (
                              <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-mono">r{c.readinessScore}</span>
                            )}
                            <span className="text-gray-400 font-mono">{c.text.length} ch</span>
                          </div>
                          {sacEnd > 0 && (
                            <div className="text-[10px] text-amber-700 bg-amber-50 rounded px-1 py-0.5 mb-1 font-mono break-words">
                              {c.text.slice(0, sacEnd)}
                            </div>
                          )}
                          <div className="text-xs text-gray-800 whitespace-pre-wrap break-words">
                            {c.text.slice(sacEnd).trim()}
                          </div>
                        </div>
                      );
                    })}
                    {pageChunks?.length === 0 && (
                      <div className="text-xs text-gray-500">No chunks stored for this page.</div>
                    )}
                  </div>
                </div>
                {/* Parsed structure for comparison */}
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-2">
                    Page structure — {detail.blocks.length} blocks
                  </div>
                  <div className="space-y-2">
                    {detail.blocks.map(b => (
                      <div key={b.order} className="border border-gray-100 rounded p-2">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] ${BLOCK_CHIP[b.type] ?? BLOCK_CHIP.unknown}`}>{b.type}</span>
                          {b.speaker && <span className="text-[10px] text-indigo-700 font-medium">{b.speaker}</span>}
                          {b.lineStart != null && (
                            <span className="text-[10px] text-gray-500 font-mono">
                              L{b.lineStart}{b.lineEnd !== b.lineStart ? `–${b.lineEnd}` : ''}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-700 whitespace-pre-wrap break-words">
                          {b.text.slice(0, 600)}{b.text.length > 600 ? '…' : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {detail && view === 'blocks' && (
              <div className="overflow-auto max-h-[70vh]">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-600 w-10" title="Reading order (per page, resets each page)">#</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600 w-28">Type</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600">Text</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600 w-40 whitespace-nowrap">BBox (pt)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {detail.blocks.map(b => (
                      <tr key={b.order} className="align-top">
                        <td className="px-3 py-2 text-gray-400">{b.order}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${BLOCK_CHIP[b.type] ?? BLOCK_CHIP.unknown}`}>{b.type}</span>
                          {b.speaker && <div className="text-[10px] text-indigo-700 mt-0.5 font-medium">{b.speaker}</div>}
                          {b.lineStart != null && (
                            <div className="text-[10px] text-gray-500 mt-0.5 font-mono">
                              {b.lineStart === b.lineEnd ? `L${b.lineStart}` : `L${b.lineStart}–${b.lineEnd}`}
                            </div>
                          )}
                          {b.identifiers?.batesNumber && <div className="text-[10px] text-purple-700 mt-0.5 font-mono">{b.identifiers.batesNumber}</div>}
                        </td>
                        <td className="px-3 py-2 text-gray-800 whitespace-pre-wrap break-words">
                          {b.text.slice(0, 300)}{b.text.length > 300 ? '…' : ''}
                          {b.html && <div className="text-[10px] text-green-700 mt-1 font-mono">has table html ({b.html.length} chars)</div>}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500 font-mono whitespace-nowrap">
                          {b.bbox ? b.bbox.map(n => Math.round(n)).join(', ') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        )
      )}

      {!selectedDocId && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-500">
          Select a document to inspect its parsed structure — headings, paragraphs, tables,
          furniture, and bounding boxes as stored by the docparse structure stage.
        </div>
      )}
    </div>
  );
}

function VectorDocsPanel({ viewMode }: { viewMode: ViewMode }) {
  if (viewMode === 'tableview') {
    return (
      <div className="p-4 space-y-4">
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Table View</h4>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Browse all chunks stored in the LanceDB vector database. Each row represents a text chunk
            that has been embedded and indexed for semantic search.
          </p>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Filters</h4>
          <ul className="space-y-1.5">
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Filter by case, filing, or document to narrow results
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Use text search to find chunks containing specific keywords
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Set page range to view chunks from specific pages
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-gray-400 shrink-0">&#x2022;</span>
              Click a row to expand and see full chunk text and metadata
            </li>
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Chunk Structure</h4>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Documents are split into overlapping chunks for embedding. Each chunk has a page number,
            chunk index, and type (text or exhibit). Chunks are the atomic units used in vector search.
          </p>
        </div>
      </div>
    );
  }

  if (viewMode === 'breakdown') {
    return (
      <div className="p-4 space-y-4">
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Breakdown</h4>
          <p className="text-[11px] text-gray-600 leading-relaxed">
            Visual overview of how chunks are distributed across cases and documents in the vector database.
          </p>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Charts</h4>
          <ul className="space-y-1.5">
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-blue-400 shrink-0 font-bold">1</span>
              Chunks by Case &mdash; shows which cases have the most indexed content
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-green-400 shrink-0 font-bold">2</span>
              Chunks by Document &mdash; shows per-document chunk counts
            </li>
            <li className="text-[11px] text-gray-600 flex gap-1.5">
              <span className="text-amber-400 shrink-0 font-bold">3</span>
              Content Type &mdash; ratio of text chunks vs exhibit chunks
            </li>
          </ul>
        </div>
        <div className="bg-gray-50 rounded-md p-2.5">
          <p className="text-[10px] text-gray-400 mb-0.5">Tip</p>
          <p className="text-[11px] text-gray-600">
            Uneven distribution may indicate missing documents or processing errors for certain cases.
          </p>
        </div>
      </div>
    );
  }

  // pagereport
  return (
    <div className="p-4 space-y-4">
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Page Report</h4>
        <p className="text-[11px] text-gray-600 leading-relaxed">
          Verify per-page indexing status for a document. Identifies which pages have been successfully
          chunked and embedded, and which pages are missing from the vector database.
        </p>
      </div>
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Status Meanings</h4>
        <ul className="space-y-1.5">
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-green-500 shrink-0 font-bold">&#x2713;</span>
            Indexed &mdash; page has one or more chunks in the vector database
          </li>
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-red-500 shrink-0 font-bold">&#x2717;</span>
            Unindexed &mdash; no chunks found for this page; it may be blank, contain only images, or have failed extraction
          </li>
        </ul>
      </div>
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Source Column</h4>
        <ul className="space-y-1.5">
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-blue-400 shrink-0 font-bold">E</span>
            extract &mdash; text extracted directly from PDF
          </li>
          <li className="text-[11px] text-gray-600 flex gap-1.5">
            <span className="text-orange-400 shrink-0 font-bold">O</span>
            ocr &mdash; text recognized via OCR (may be lower quality)
          </li>
        </ul>
      </div>
      <div className="bg-gray-50 rounded-md p-2.5">
        <p className="text-[10px] text-gray-400 mb-0.5">Use Case</p>
        <p className="text-[11px] text-gray-600">
          Use this to verify indexing coverage for large documents like clerk&apos;s records.
          Unindexed pages won&apos;t appear in search results.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Sub-components
// ---------------------------------------------------------------------------

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-xs text-gray-500">
      <span className="font-medium">{label}:</span> {value}
    </p>
  );
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="flex items-center gap-4">
      <span className="text-sm text-gray-700 w-48 truncate" title={label}>{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-6 overflow-hidden">
        <div
          className={`${color} h-full rounded-full flex items-center justify-end pr-2 transition-all`}
          style={{ width: `${Math.max(10, (value / max) * 100)}%` }}
        >
          <span className="text-xs text-white font-medium">{value.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  loading,
  onPageChange,
  full = false,
}: {
  page: number;
  totalPages: number;
  loading: boolean;
  onPageChange: (p: number) => void;
  full?: boolean;
}) {
  const btnClass = 'px-3 py-1 text-sm border border-gray-300 rounded-md disabled:opacity-50 hover:bg-gray-50 transition-colors';
  return (
    <div className="flex items-center gap-2">
      {full && (
        <button onClick={() => onPageChange(1)} disabled={page <= 1 || loading} className={btnClass}>
          First
        </button>
      )}
      <button onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1 || loading} className={btnClass}>
        Previous
      </button>
      <span className="text-sm text-gray-600">
        Page {page} of {totalPages}
      </span>
      <button onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages || loading} className={btnClass}>
        Next
      </button>
      {full && (
        <button onClick={() => onPageChange(totalPages)} disabled={page >= totalPages || loading} className={btnClass}>
          Last
        </button>
      )}
    </div>
  );
}
