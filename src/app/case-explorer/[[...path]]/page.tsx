'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getCachedCases, setCachedCases, getCachedFilings, setCachedFilings, setPreference, getPreference } from '@/lib/indexed-db';
import { ContextMenu, type ContextMenuItem } from '@/components/context-menu';
import { getSharedDocumentMenuItems, FilingDialog, type DocumentTarget, FILING_TYPES as SHARED_FILING_TYPES } from '@/components/document-context-menu';

// Import pdfjs text layer CSS for selectable text overlay
import 'pdfjs-dist/web/pdf_viewer.css';

// Lazy-load pdfjs-dist only on the client (SSR doesn't have DOMMatrix)
let pdfjsLib: typeof import('pdfjs-dist') | null = null;
if (typeof window !== 'undefined') {
  import('pdfjs-dist').then(mod => {
    pdfjsLib = mod;
    mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  });
}

interface CaseRecord { id: string; name: string; caseNumber: string | null; }
interface DocumentRecord {
  id: string; fileName: string; filePath: string; status: string;
  documentType: string | null; exhibitLabel: string | null;
  pageCount: number | null; documentSummary: string | null; createdAt: string;
}
interface FilingRecord {
  id: string; filingType: string; title: string; slug: string;
  filingDate: string | null; description: string | null; documents: DocumentRecord[];
}
interface CaseWithFilings extends CaseRecord { filings: FilingRecord[]; }
interface OutlineItem { title: string; dest: any; items: OutlineItem[]; }
interface ExtractedHeading { text: string; page: number; }

const FILING_TYPES = [
  'Motion','Notice','Order','Brief','Letter','Petition','Affidavit','Subpoena',
  'Response','Reply','Judgment','Decree',"Clerk's Record","Reporter's Record",
  'Transcript','Settlement','Bill of Review','Return of Service','Demand Letter',
  'Objection','Request','Supplement','Designation','Other',
];

const FILING_TYPE_LABELS: Record<string, string> = {
  Motion:'Motions', Notice:'Notices', Order:'Orders', Brief:'Briefs', Letter:'Letters',
  Petition:'Petitions', Affidavit:'Affidavits', Subpoena:'Subpoenas', Response:'Responses',
  Reply:'Replies', Judgment:'Judgments', Decree:'Decrees', "Clerk's Record":"Clerk's Records",
  "Reporter's Record":"Reporter's Records", Transcript:'Transcripts', Settlement:'Settlements',
  'Bill of Review':'Bills of Review', 'Return of Service':'Returns of Service',
  'Demand Letter':'Demand Letters', Objection:'Objections', Request:'Requests',
  Supplement:'Supplements', Designation:'Designations', Other:'Others',
};

// URL path helpers for /case-explorer/{caseNumber}/{filingType}/{filingSlug}
const getCaseSlug = (c: { caseNumber: string | null; id: string }) => c.caseNumber || c.id;

const buildExplorerPath = (...segments: (string | undefined)[]) => {
  const parts = segments.filter(Boolean) as string[];
  return '/case-explorer' + (parts.length ? '/' + parts.map(encodeURIComponent).join('/') : '');
};

const parseExplorerPath = (pathname: string): string[] => {
  const prefix = '/case-explorer';
  if (!pathname.startsWith(prefix)) return [];
  return pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
};

export default function CaseExplorerPage() {
  const searchParams = useSearchParams();
  const [casesWithFilings, setCasesWithFilings] = useState<CaseWithFilings[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  // Tree expansion
  const [expandedCases, setExpandedCases] = useState<Set<string>>(new Set());
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [expandedFilings, setExpandedFilings] = useState<Set<string>>(new Set());

  // Selected document for PDF viewer
  const [selectedDoc, setSelectedDoc] = useState<(DocumentRecord & { caseName: string; filingTitle: string; filingType: string; caseId: string; filingId: string }) | null>(null);

  // PDF viewer state
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfOutline, setPdfOutline] = useState<OutlineItem[]>([]);
  const [extractedHeadings, setExtractedHeadings] = useState<ExtractedHeading[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const pageCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pageWrapperRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const textLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const annotationLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const renderingRef = useRef<Set<number>>(new Set());
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const renderPageRangeRef = useRef<(centerPage: number) => void>(() => {});
  const pushNavHistoryRef = useRef<(pageNum: number) => void>(() => {});
  // Default page dimensions (from page 1) used as placeholder size
  const [placeholderDims, setPlaceholderDims] = useState<{ w: number; h: number }>({ w: 612, h: 792 });

  // PDF toolbar
  const [pdfScale, setPdfScale] = useState(1.0);
  const [fitMode, setFitMode] = useState<'width' | 'page' | null>('page');
  const computedScaleRef = useRef(1.0);
  const [goToPageInput, setGoToPageInput] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  // Tracks whether the initial ?pageNum= from the URL has been consumed
  const initialPageConsumedRef = useRef(false);
  // Navigation history for back/forward
  const navHistoryRef = useRef<number[]>([1]);
  const navIndexRef = useRef(0);

  // Right panel tab
  const [rightTab, setRightTab] = useState<'toc' | 'docinfo'>('toc');

  // Resizable left pane — init from localStorage
  const [leftWidth, setLeftWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('case-explorer-left-width');
      if (saved) { const n = parseInt(saved, 10); if (n >= 200 && n <= 600) return n; }
    }
    return 320;
  });
  const [rightWidth, setRightWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('case-explorer-right-width');
      if (saved) { const n = parseInt(saved, 10); if (n >= 200 && n <= 500) return n; }
    }
    return 280;
  });
  const draggingRef = useRef<'left' | 'right' | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Context menu (filing-level)
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number;
    filing?: FilingRecord; caseId?: string;
  } | null>(null);
  const [editingFiling, setEditingFiling] = useState<{ filing: FilingRecord; caseId: string } | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editType, setEditType] = useState('');

  // Document-level context menu
  const [docContextMenu, setDocContextMenu] = useState<{
    x: number; y: number;
    doc: DocumentRecord;
    caseId: string;
    caseName: string;
    filing: FilingRecord;
  } | null>(null);

  // Filing dialog for document actions
  const [filingDialogOpen, setFilingDialogOpen] = useState(false);
  const [filingDialogCreateMode, setFilingDialogCreateMode] = useState(true);
  const [filingDialogTarget, setFilingDialogTarget] = useState<{ docId: string; caseId: string; filePath: string } | null>(null);
  const [filingDialogError, setFilingDialogError] = useState('');
  const [filingDialogLoading, setFilingDialogLoading] = useState(false);

  // URL navigation: update URL without triggering Next.js re-render
  const pushUrl = useCallback((...segments: (string | undefined)[]) => {
    const url = buildExplorerPath(...segments);
    window.history.pushState(null, '', url);
  }, []);

  // Update URL with current page number (debounced replaceState to avoid history spam)
  const pageUrlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!selectedDoc || !pdfDoc || currentPage < 1 || !initialPageConsumedRef.current) return;
    if (pageUrlTimerRef.current) clearTimeout(pageUrlTimerRef.current);
    pageUrlTimerRef.current = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('pageNum', String(currentPage));
      window.history.replaceState(null, '', url.toString());
    }, 200);
    return () => { if (pageUrlTimerRef.current) clearTimeout(pageUrlTimerRef.current); };
  }, [currentPage, selectedDoc, pdfDoc]);

  useEffect(() => { loadAll(); }, []);

  // Background refresh indicator (shows when stale cache is being revalidated)
  const [isRefreshing, setIsRefreshing] = useState(false);

  // SSE real-time updates: listen for filing/document changes with reconnection
  useEffect(() => {
    const sseConnections = new Map<string, EventSource>();
    const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const reconnectAttempts = new Map<string, number>();
    const MAX_RECONNECT_DELAY = 30000;

    const connectCase = (caseId: string) => {
      if (sseConnections.has(caseId)) return;
      try {
        const es = new EventSource(`/api/cases/${caseId}/watch`);
        sseConnections.set(caseId, es);

        // Reset reconnect counter on successful connection
        es.addEventListener('connected', () => {
          reconnectAttempts.set(caseId, 0);
        });

        const handleFilingEvent = () => {
          fetch(`/api/cases/${caseId}/filings`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
              if (!data?.filings) return;
              setCasesWithFilings(prev =>
                prev.map(c => c.id === caseId ? { ...c, filings: data.filings } : c)
              );
              setCachedFilings(caseId, data.filings).catch(() => {});
            })
            .catch(() => {});
        };

        es.addEventListener('filing_created', handleFilingEvent);
        es.addEventListener('filing_updated', handleFilingEvent);
        es.addEventListener('filing_deleted', handleFilingEvent);
        es.addEventListener('document_added', handleFilingEvent);
        es.addEventListener('document_status_changed', (e) => {
          try {
            const payload = JSON.parse(e.data);
            setCasesWithFilings(prev => {
              const updated = prev.map(c => {
                if (c.id !== caseId) return c;
                return {
                  ...c,
                  filings: c.filings.map(f => ({
                    ...f,
                    documents: f.documents.map(d =>
                      d.id === payload.documentId ? { ...d, status: payload.status } : d
                    ),
                  })),
                };
              });
              // Also persist the status change to IndexedDB cache
              const caseData = updated.find(c => c.id === caseId);
              if (caseData) {
                setCachedFilings(caseId, caseData.filings).catch(() => {});
              }
              return updated;
            });
          } catch { /* ignore */ }
        });

        es.onerror = () => {
          es.close();
          sseConnections.delete(caseId);
          // Reconnect with exponential backoff
          const attempt = (reconnectAttempts.get(caseId) || 0) + 1;
          reconnectAttempts.set(caseId, attempt);
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY);
          const timer = setTimeout(() => {
            reconnectTimers.delete(caseId);
            if (expandedCases.has(caseId)) {
              connectCase(caseId);
            }
          }, delay);
          reconnectTimers.set(caseId, timer);
        };
      } catch { /* SSE not available */ }
    };

    for (const caseId of expandedCases) {
      connectCase(caseId);
    }

    const handleFilingsChanged = () => loadAll();
    window.addEventListener('filings-changed', handleFilingsChanged);

    return () => {
      window.removeEventListener('filings-changed', handleFilingsChanged);
      for (const es of sseConnections.values()) {
        try { es.close(); } catch { /* ignore */ }
      }
      for (const timer of reconnectTimers.values()) {
        clearTimeout(timer);
      }
      sseConnections.clear();
      reconnectTimers.clear();
    };
  }, [expandedCases]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore expanded state from IndexedDB preferences
  useEffect(() => {
    getPreference<string[]>('explorer-expanded-cases').then(ids => {
      if (ids && ids.length > 0) setExpandedCases(new Set(ids));
    }).catch(() => {});
  }, []);

  // Persist expanded cases to preferences (debounced)
  const expandedCasesRef = useRef(expandedCases);
  expandedCasesRef.current = expandedCases;
  useEffect(() => {
    const t = setTimeout(() => {
      setPreference('explorer-expanded-cases', Array.from(expandedCasesRef.current)).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [expandedCases]);

  // Persist expanded types and filings
  useEffect(() => {
    const t = setTimeout(() => {
      setPreference('explorer-expanded-types', Array.from(expandedTypes)).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [expandedTypes]);

  useEffect(() => {
    const t = setTimeout(() => {
      setPreference('explorer-expanded-filings', Array.from(expandedFilings)).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [expandedFilings]);

  // Restore expanded types and filings
  useEffect(() => {
    getPreference<string[]>('explorer-expanded-types').then(ids => {
      if (ids && ids.length > 0) setExpandedTypes(new Set(ids));
    }).catch(() => {});
    getPreference<string[]>('explorer-expanded-filings').then(ids => {
      if (ids && ids.length > 0) setExpandedFilings(new Set(ids));
    }).catch(() => {});
  }, []);

  // Persist last viewed document per case
  useEffect(() => {
    if (selectedDoc) {
      setPreference(`explorer-last-doc:${selectedDoc.caseId}`, {
        id: selectedDoc.id,
        fileName: selectedDoc.fileName,
        filePath: selectedDoc.filePath,
        status: selectedDoc.status,
        documentType: selectedDoc.documentType,
        exhibitLabel: selectedDoc.exhibitLabel,
        pageCount: selectedDoc.pageCount,
        documentSummary: selectedDoc.documentSummary,
        createdAt: selectedDoc.createdAt,
        caseName: selectedDoc.caseName,
        filingTitle: selectedDoc.filingTitle,
        filingType: selectedDoc.filingType,
        caseId: selectedDoc.caseId,
        filingId: selectedDoc.filingId,
      }).catch(() => {});
    }
  }, [selectedDoc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save PDF scroll position (debounced) when the user scrolls the PDF container
  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const container = pdfContainerRef.current;
    if (!container || !selectedDoc) return;
    const handleScroll = () => {
      if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = setTimeout(() => {
        setPreference(`explorer-scroll:${selectedDoc.id}`, container.scrollTop).catch(() => {});
      }, 300);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
    };
  }, [selectedDoc?.id]);

  // Restore saved scroll position when PDF finishes loading
  // (URL ?pageNum= is handled in the scroll-driven rendering effect's doRender)
  const hasRestoredScrollRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pdfDoc || !selectedDoc || !pdfContainerRef.current) return;
    if (hasRestoredScrollRef.current === selectedDoc.id) return;
    // Skip scroll restore if URL has a pageNum (doRender handles it)
    const urlPageNum = new URLSearchParams(window.location.search).get('pageNum');
    if (urlPageNum && !initialPageConsumedRef.current) { hasRestoredScrollRef.current = selectedDoc.id; return; }
    hasRestoredScrollRef.current = selectedDoc.id;

    getPreference<number>(`explorer-scroll:${selectedDoc.id}`).then(pos => {
      if (pos != null && pos > 0 && pdfContainerRef.current) {
        setTimeout(() => {
          pdfContainerRef.current?.scrollTo({ top: pos });
        }, 200);
      }
    }).catch(() => {});
  }, [pdfDoc, pdfLoading, selectedDoc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL path-based navigation: expand tree to match /case-explorer/{case}/{type}/{filing}
  const hasHandledUrlPath = useRef(false);
  const applyUrlSegments = useCallback((segments: string[]) => {
    if (segments.length === 0) return;
    const [caseSlug, filingType, filingSlug] = segments;
    const c = casesWithFilings.find(cs => (cs.caseNumber || cs.id) === caseSlug);
    if (!c) return;

    setExpandedCases(prev => new Set([...prev, c.id]));

    if (filingType) {
      setExpandedTypes(prev => new Set([...prev, `${c.id}:${filingType}`]));

      if (filingSlug) {
        const filing = c.filings.find(f => f.slug === filingSlug && f.filingType === filingType);
        if (filing) {
          setExpandedFilings(prev => new Set([...prev, filing.id]));
          // Auto-open single document (inline selectFiling logic)
          if (filing.documents.length === 1) {
            const doc = filing.documents[0];
            setSelectedDoc({ ...doc, caseName: c.name, filingTitle: filing.title, filingType: filing.filingType, caseId: c.id, filingId: filing.id });
          }
        }
      }
    }
  }, [casesWithFilings]);

  useEffect(() => {
    if (hasHandledUrlPath.current || casesWithFilings.length === 0) return;
    const segments = parseExplorerPath(window.location.pathname);
    if (segments.length === 0) return;
    hasHandledUrlPath.current = true;
    applyUrlSegments(segments);
  }, [casesWithFilings, applyUrlSegments]);

  // Handle browser back/forward for URL path navigation
  useEffect(() => {
    const handlePopState = () => {
      applyUrlSegments(parseExplorerPath(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [applyUrlSegments]);

  // Deep-link: open document from ?doc= query parameter (filePath)
  const hasHandledDeepLink = useRef(false);
  useEffect(() => {
    if (hasHandledDeepLink.current || hasHandledUrlPath.current || casesWithFilings.length === 0) return;
    const docPath = searchParams.get('doc');
    if (!docPath) return;
    hasHandledDeepLink.current = true;
    // Find the document across all cases/filings by filePath
    for (const c of casesWithFilings) {
      for (const f of c.filings) {
        const doc = f.documents.find(d => d.filePath === docPath);
        if (doc) {
          // Expand the tree to show this document
          setExpandedCases(prev => new Set([...prev, c.id]));
          setExpandedTypes(prev => new Set([...prev, `${c.id}:${f.filingType}`]));
          setExpandedFilings(prev => new Set([...prev, f.id]));
          setSelectedDoc({ ...doc, caseName: c.name, filingTitle: f.title, filingType: f.filingType, caseId: c.id, filingId: f.id });
          return;
        }
      }
    }
  }, [casesWithFilings, searchParams]);

  // Restore last viewed document on initial load (once cases are loaded)
  const hasRestoredDocRef = useRef(false);
  useEffect(() => {
    // Skip restore if deep-link or URL path was handled
    if (hasRestoredDocRef.current || hasHandledDeepLink.current || hasHandledUrlPath.current || casesWithFilings.length === 0 || selectedDoc) return;
    hasRestoredDocRef.current = true;
    // Try to restore last viewed doc from the first expanded case
    const firstCaseId = expandedCases.size > 0 ? Array.from(expandedCases)[0] : casesWithFilings[0]?.id;
    if (!firstCaseId) return;
    getPreference<any>(`explorer-last-doc:${firstCaseId}`).then(lastDoc => {
      if (!lastDoc?.id) return;
      // Verify the document still exists in the tree
      const caseData = casesWithFilings.find(c => c.id === firstCaseId);
      if (!caseData) return;
      const docExists = caseData.filings.some(f => f.documents.some(d => d.id === lastDoc.id));
      if (docExists) {
        setSelectedDoc(lastDoc);
      }
    }).catch(() => {});
  }, [casesWithFilings, expandedCases]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadAll = async () => {
    setLoading(true);
    try {
      // Step 1: Try IndexedDB cache for instant render
      let usedCache = false;
      try {
        const cachedCases = await getCachedCases();
        if (cachedCases?.data && cachedCases.data.length > 0) {
          const caseRecords: CaseRecord[] = cachedCases.data.map(c => ({
            id: c.id, name: c.name, caseNumber: c.caseNumber ?? null,
          }));
          const cachedResults: CaseWithFilings[] = await Promise.all(
            caseRecords.map(async (c) => {
              try {
                const cf = await getCachedFilings(c.id);
                if (cf?.data) return { ...c, filings: cf.data as FilingRecord[] };
              } catch {}
              return { ...c, filings: [] };
            })
          );
          setCasesWithFilings(cachedResults);
          if (cachedResults.length > 0 && expandedCases.size === 0) {
            setExpandedCases(new Set([cachedResults[0].id]));
          }
          setLoading(false);
          usedCache = true;

          // If cache is fresh, skip API fetch
          if (!cachedCases.isStale) return;
          // Show background refresh indicator for stale cache
          setIsRefreshing(true);
        }
      } catch {
        // IndexedDB not available, fall through
      }

      // Step 2: Fetch from API (background if cache was used)
      const casesRes = await fetch('/api/cases');
      if (!casesRes.ok) return;
      const casesData = await casesRes.json();
      const cases: CaseRecord[] = casesData.cases || [];
      const results: CaseWithFilings[] = await Promise.all(
        cases.map(async (c) => {
          try {
            const res = await fetch(`/api/cases/${c.id}/filings`);
            if (res.ok) {
              const data = await res.json();
              const filings = data.filings || [];
              setCachedFilings(c.id, filings).catch(() => {});
              return { ...c, filings };
            }
          } catch {}
          return { ...c, filings: [] };
        })
      );
      setCasesWithFilings(results);
      if (results.length > 0 && !usedCache) setExpandedCases(new Set([results[0].id]));

      // Cache the case list
      setCachedCases(casesData.cases || []).catch(() => {});
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  // ── Resize handlers ──────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current === 'left') {
        setLeftWidth(Math.max(200, Math.min(600, e.clientX)));
      } else if (draggingRef.current === 'right') {
        setRightWidth(Math.max(200, Math.min(500, window.innerWidth - e.clientX)));
      }
    };
    const onUp = () => {
      if (draggingRef.current === 'left') {
        setLeftWidth(prev => { localStorage.setItem('case-explorer-left-width', String(prev)); return prev; });
      } else if (draggingRef.current === 'right') {
        setRightWidth(prev => { localStorage.setItem('case-explorer-right-width', String(prev)); return prev; });
      }
      draggingRef.current = null; setIsDragging(false); document.body.style.cursor = ''; document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const startDrag = (side: 'left' | 'right') => {
    draggingRef.current = side;
    setIsDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // ── PDF loading ──────────────────────────────────────────────────
  const loadPdf = useCallback(async (docId: string) => {
    setPdfLoading(true); setPdfError(null); setPdfOutline([]); setExtractedHeadings([]); setPdfPageCount(0);
    renderingRef.current.clear(); renderedPagesRef.current.clear();
    pageCanvasRefs.current.clear(); pageWrapperRefs.current.clear(); textLayerRefs.current.clear(); annotationLayerRefs.current.clear();
    navHistoryRef.current = [1]; navIndexRef.current = 0;
    try {
      if (!pdfjsLib) { const mod = await import('pdfjs-dist'); pdfjsLib = mod; mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'; }
      const doc = await pdfjsLib.getDocument({
        url: `/api/documents/${docId}/pdf`,
        wasmUrl: '/',
      }).promise;
      setPdfDoc(doc); setPdfPageCount(doc.numPages);

      // Get page 1 dimensions for placeholder sizing
      try {
        const p1 = await doc.getPage(1);
        const vp = p1.getViewport({ scale: 1.0 });
        setPlaceholderDims({ w: Math.floor(vp.width), h: Math.floor(vp.height) });
      } catch {}
      // Extract outline
      try {
        const outline = await doc.getOutline();
        if (outline?.length) { setPdfOutline(outline as OutlineItem[]); return; }
      } catch {}
      // Fallback: extract headings
      const headings: ExtractedHeading[] = [];
      for (let i = 1; i <= Math.min(doc.numPages, 100); i++) {
        try {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const items = content.items as any[];
          if (!items.length) continue;
          const fontSizes: Record<number, number> = {};
          for (const it of items) { if (it.str?.trim()) { const h = Math.round(it.height || it.transform?.[0] || 12); fontSizes[h] = (fontSizes[h] || 0) + it.str.length; } }
          const bodySizeNum = Number(Object.entries(fontSizes).sort((a, b) => b[1] - a[1])[0]?.[0] || 12);
          const lines: { text: string; fontSize: number }[] = [];
          let curLine = '', curSize = 0, curY = -1;
          for (const it of items) {
            if (!it.str) continue;
            const y = Math.round(it.transform?.[5] || 0), h = Math.round(it.height || it.transform?.[0] || 12);
            if (curY === -1 || Math.abs(y - curY) < 3) { curLine += it.str; curSize = Math.max(curSize, h); curY = y; }
            else { if (curLine.trim()) lines.push({ text: curLine.trim(), fontSize: curSize }); curLine = it.str; curSize = h; curY = y; }
          }
          if (curLine.trim()) lines.push({ text: curLine.trim(), fontSize: curSize });
          for (const ln of lines) {
            const t = ln.text.trim();
            if (t.length < 3 || t.length > 120) continue;
            if (/^(?:page\s+\d+|\d+$|\d{1,2}\/\d{1,2}\/\d{2,4})$/i.test(t)) continue;
            if (ln.fontSize > bodySizeNum + 1 || (t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && t.length > 4 && t.length < 80) || /^(?:\d+\.|\([a-z]\)|\([0-9]+\)|[IVXLC]+\.|[A-Z]\.)\s+\S/.test(t)) {
              if (headings.length && headings[headings.length - 1].text === t && headings[headings.length - 1].page === i) continue;
              headings.push({ text: t, page: i });
            }
          }
        } catch {}
      }
      setExtractedHeadings(headings);
    } catch (err) { setPdfError(err instanceof Error ? err.message : 'Failed to load PDF'); setPdfDoc(null); }
    finally { setPdfLoading(false); }
  }, []);

  // Auto-load PDF when doc selected
  useEffect(() => {
    if (selectedDoc) loadPdf(selectedDoc.id);
    else { setPdfDoc(null); setPdfOutline([]); setExtractedHeadings([]); setPdfPageCount(0); renderingRef.current.clear(); renderedPagesRef.current.clear(); pageWrapperRefs.current.clear(); textLayerRefs.current.clear(); annotationLayerRefs.current.clear(); }
  }, [selectedDoc?.id, loadPdf]);

  // Select a document and auto-load its PDF
  const selectDocument = useCallback((doc: DocumentRecord, c: CaseWithFilings, f: FilingRecord) => {
    setSelectedDoc({ ...doc, caseName: c.name, filingTitle: f.title, filingType: f.filingType, caseId: c.id, filingId: f.id });
  }, []);

  // Click a filing: if it has exactly 1 doc, auto-open it
  const selectFiling = useCallback((c: CaseWithFilings, f: FilingRecord) => {
    if (f.documents.length === 1) {
      selectDocument(f.documents[0], c, f);
    }
  }, [selectDocument]);

  const MAX_CONCURRENT_RENDERS = 20;
  // ── Render page to canvas + text layer (with server-side fallback) ──
  const renderPageToCanvas = useCallback(async (pageNum: number, canvas: HTMLCanvasElement) => {
    if (!pdfDoc || !pdfjsLib || renderingRef.current.has(pageNum)) return;
    // Skip if too many concurrent renders (let higher-priority renders finish first)
    if (renderingRef.current.size >= MAX_CONCURRENT_RENDERS) return;
    renderingRef.current.add(pageNum);
    try {
      const page = await pdfDoc.getPage(pageNum);
      let scale = pdfScale;
      if (fitMode && pdfContainerRef.current) {
        const baseViewport = page.getViewport({ scale: 1.0 });
        const containerW = pdfContainerRef.current.clientWidth - 32;
        if (fitMode === 'width') {
          scale = containerW / baseViewport.width;
        } else {
          const containerH = pdfContainerRef.current.clientHeight - 32;
          scale = Math.min(containerW / baseViewport.width, containerH / baseViewport.height);
        }
        computedScaleRef.current = scale;
      }
      const viewport = page.getViewport({ scale });
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);

      // Update wrapper dimensions early and hide placeholder spinner
      const wrapper = pageWrapperRefs.current.get(pageNum);
      if (wrapper) {
        wrapper.style.width = `${w}px`; wrapper.style.height = `${h}px`;
        const placeholder = wrapper.querySelector('.page-placeholder') as HTMLElement;
        if (placeholder) placeholder.style.display = 'none';
      }

      let clientRenderFailed = false;
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('No 2d context');
        canvas.width = w; canvas.height = h;
        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
        ctx.clearRect(0, 0, w, h); ctx.resetTransform();
        await page.render({ canvasContext: ctx, viewport } as any).promise;

        // Check if page rendered as blank (common JPEG2000 symptom).
        // Sample the CENTER of the page (margins are usually white).
        const sampleW = Math.min(w, 200);
        const sampleH = Math.min(h, 200);
        const sx = Math.max(0, Math.floor((w - sampleW) / 2));
        const sy = Math.max(0, Math.floor((h - sampleH) / 2));
        const sample = ctx.getImageData(sx, sy, sampleW, sampleH);
        let allWhite = true;
        for (let i = 0; i < sample.data.length; i += 4) {
          if (sample.data[i] < 250 || sample.data[i + 1] < 250 || sample.data[i + 2] < 250) {
            allWhite = false; break;
          }
        }
        const textContent = await page.getTextContent();
        const hasText = textContent.items.some((item: any) => item.str?.trim());
        if (allWhite && !hasText) {
          // Canvas is blank — likely JPEG2000 or other codec failure
          clientRenderFailed = true;
        } else {
          // Render succeeded — add selectable text layer
          canvas.style.display = '';
          const textLayerDiv = textLayerRefs.current.get(pageNum);
          if (textLayerDiv) {
            textLayerDiv.innerHTML = '';
            // pdfjs TextLayer CSS relies on these CSS vars (normally on .pdfViewer .page).
            textLayerDiv.style.setProperty('--total-scale-factor', String(scale));
            textLayerDiv.style.setProperty('--scale-round-x', '1px');
            textLayerDiv.style.setProperty('--scale-round-y', '1px');
            textLayerDiv.style.display = '';
            const textLayer = new pdfjsLib.TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            });
            await textLayer.render();
          }

          // Render annotation layer (clickable links)
          const annotLayerDiv = annotationLayerRefs.current.get(pageNum);
          if (annotLayerDiv && pdfDoc) {
            annotLayerDiv.innerHTML = '';
            // pdfjs annotation layer CSS uses these vars for sizing (same as textLayer)
            annotLayerDiv.style.setProperty('--total-scale-factor', String(scale));
            annotLayerDiv.style.setProperty('--scale-round-x', '1px');
            annotLayerDiv.style.setProperty('--scale-round-y', '1px');
            const annotations = await page.getAnnotations();
            if (annotations.length > 0) {
              // Minimal link service for handling PDF link clicks
              const linkService = {
                get pagesCount() { return pdfDoc!.numPages; },
                get page() { return pageNum; },
                set page(_v: number) {},
                get rotation() { return 0; },
                set rotation(_v: number) {},
                get isInPresentationMode() { return false; },
                get externalLinkEnabled() { return true; },
                set externalLinkEnabled(_v: boolean) {},
                async goToDestination(dest: any) {
                  try {
                    let explicitDest = dest;
                    if (typeof dest === 'string') {
                      explicitDest = await pdfDoc!.getDestination(dest);
                    }
                    if (!explicitDest) return;
                    const ref = explicitDest[0];
                    const pageIndex = await pdfDoc!.getPageIndex(ref);
                    const targetPage = pageIndex + 1;
                    pushNavHistoryRef.current(targetPage);
                    setCurrentPage(targetPage);
                    const w = pageWrapperRefs.current.get(targetPage);
                    if (w) w.scrollIntoView({ block: 'start' });
                    renderPageRangeRef.current(targetPage);
                  } catch {}
                },
                goToPage(val: number) {
                  pushNavHistoryRef.current(val);
                  setCurrentPage(val);
                  const w = pageWrapperRefs.current.get(val);
                  if (w) w.scrollIntoView({ block: 'start' });
                  renderPageRangeRef.current(val);
                },
                goToXY() {},
                addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean) {
                  link.href = url;
                  link.rel = 'noopener noreferrer nofollow';
                  if (newWindow || !url.startsWith('#')) link.target = '_blank';
                },
                getDestinationHash(dest: any) { return typeof dest === 'string' ? `#${dest}` : '#'; },
                getAnchorUrl(hash: string) { return hash; },
                setHash() {},
                executeNamedAction() {},
                executeSetOCGState() {},
              };
              const annotLayer = new pdfjsLib.AnnotationLayer({
                div: annotLayerDiv,
                page,
                viewport,
                accessibilityManager: null,
                annotationCanvasMap: null,
                annotationEditorUIManager: null,
                structTreeLayer: null,
                commentManager: null,
                linkService,
                annotationStorage: null,
              });
              await annotLayer.render({ annotations, div: annotLayerDiv, page, viewport, linkService, renderForms: false });
              annotLayerDiv.style.display = '';
            }
          }
        }
      } catch {
        clientRenderFailed = true;
      }

      // Fallback: load server-rendered image for JPEG2000 / failed pages
      if (clientRenderFailed && selectedDoc) {
        canvas.style.display = 'none'; // hide blank canvas
        const textLayerDiv = textLayerRefs.current.get(pageNum);
        if (textLayerDiv) textLayerDiv.style.display = 'none';
        const annotDiv = annotationLayerRefs.current.get(pageNum);
        if (annotDiv) annotDiv.style.display = 'none';

        // Check if fallback img already exists
        if (wrapper && !wrapper.querySelector('img.server-fallback')) {
          const img = document.createElement('img');
          img.className = 'server-fallback';
          img.style.width = `${w}px`;
          img.style.height = `${h}px`;
          img.style.display = 'block';
          img.alt = `Page ${pageNum}`;
          img.src = `/api/documents/${selectedDoc.id}/page-image/${pageNum}?scale=${scale}`;
          img.onerror = () => {
            // If server fallback also fails, show a placeholder
            img.style.background = '#f3f4f6';
            img.alt = `Page ${pageNum} - render unavailable`;
          };
          wrapper.appendChild(img);
        }
      }
    } catch (err) {
      console.error(`[PDF] renderPage ${pageNum} failed:`, err);
    } finally { renderingRef.current.delete(pageNum); }
  }, [pdfDoc, pdfScale, fitMode, selectedDoc]);

  // Clean up a rendered page to free memory (restore placeholder)
  const cleanupPage = useCallback((pageNum: number) => {
    if (!renderedPagesRef.current.has(pageNum)) return;
    renderedPagesRef.current.delete(pageNum);
    const canvas = pageCanvasRefs.current.get(pageNum);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0; canvas.height = 0;
      canvas.style.display = 'none';
    }
    const textLayerDiv = textLayerRefs.current.get(pageNum);
    if (textLayerDiv) { textLayerDiv.innerHTML = ''; textLayerDiv.style.display = 'none'; }
    const annotLayerDiv = annotationLayerRefs.current.get(pageNum);
    if (annotLayerDiv) { annotLayerDiv.innerHTML = ''; annotLayerDiv.style.display = 'none'; }
    const wrapper = pageWrapperRefs.current.get(pageNum);
    if (wrapper) {
      const oldImg = wrapper.querySelector('img.server-fallback');
      if (oldImg) oldImg.remove();
      // Restore placeholder spinner
      const placeholder = wrapper.querySelector('.page-placeholder') as HTMLElement;
      if (placeholder) placeholder.style.display = '';
    }
  }, []);

  /** How many pages above & below the viewport to pre-render */
  const PRELOAD_PAGES = 5;

  // Render a page + PRELOAD_PAGES neighbors, center page first then expand outward.
  // Also cleans up pages far outside the buffer to free memory.
  const renderPageRange = useCallback((centerPage: number) => {
    if (!pdfPageCount) return;
    const start = Math.max(1, centerPage - PRELOAD_PAGES);
    const end = Math.min(pdfPageCount, centerPage + PRELOAD_PAGES);

    // Render center first, then expand outward
    const renderOrder: number[] = [centerPage];
    for (let d = 1; d <= PRELOAD_PAGES; d++) {
      if (centerPage - d >= start) renderOrder.push(centerPage - d);
      if (centerPage + d <= end) renderOrder.push(centerPage + d);
    }
    for (const p of renderOrder) {
      if (!renderedPagesRef.current.has(p)) {
        const canvas = pageCanvasRefs.current.get(p);
        if (canvas) {
          canvas.style.display = '';
          renderedPagesRef.current.add(p);
          renderPageToCanvas(p, canvas);
        }
      }
    }

    // Clean up pages far outside the buffer (more than 2x PRELOAD_PAGES away)
    const cleanStart = Math.max(1, centerPage - PRELOAD_PAGES * 2);
    const cleanEnd = Math.min(pdfPageCount, centerPage + PRELOAD_PAGES * 2);
    for (const pageNum of [...renderedPagesRef.current]) {
      if (pageNum < cleanStart || pageNum > cleanEnd) {
        cleanupPage(pageNum);
      }
    }
  }, [pdfPageCount, renderPageToCanvas, cleanupPage]);
  renderPageRangeRef.current = renderPageRange;

  // Calculate which page is at the current scroll position using scroll ratio.
  const getPageAtScroll = useCallback((container: HTMLDivElement): number => {
    if (!pdfPageCount) return 1;
    const scrollH = container.scrollHeight - container.clientHeight;
    if (scrollH <= 0) return 1;
    const ratio = container.scrollTop / scrollH;
    return Math.max(1, Math.min(pdfPageCount, Math.round(ratio * (pdfPageCount - 1)) + 1));
  }, [pdfPageCount]);

  // Scroll-driven rendering: on scroll, determine current page, update display, render neighbors
  const scrollRafRef = useRef(0);

  useEffect(() => {
    if (!pdfDoc || !pdfPageCount || !pdfContainerRef.current) return;

    // On zoom/fit change, clean up all previously rendered pages so they re-render at new scale
    for (const pageNum of [...renderedPagesRef.current]) {
      cleanupPage(pageNum);
    }
    renderingRef.current.clear();

    const container = pdfContainerRef.current;

    // Flag to suppress scroll handler while programmatic scrollIntoView is happening
    let suppressScrollHandler = false;

    const doRender = () => {
      // On first render, jump to ?pageNum= if present in the URL
      if (!initialPageConsumedRef.current) {
        initialPageConsumedRef.current = true;
        const p = new URLSearchParams(window.location.search).get('pageNum');
        if (p) {
          const initPage = parseInt(p, 10);
          if (!isNaN(initPage) && initPage >= 1 && initPage <= pdfPageCount) {
            suppressScrollHandler = true;
            setCurrentPage(initPage);
            const wrapper = pageWrapperRefs.current.get(initPage);
            if (wrapper) {
              wrapper.scrollIntoView({ block: 'start' });
            }
            renderPageRange(initPage);
            setTimeout(() => { suppressScrollHandler = false; }, 200);
            return;
          }
        }
      }
      const page = getPageAtScroll(container);
      setCurrentPage(page);
      renderPageRange(page);
    };

    const handleScroll = () => {
      if (suppressScrollHandler) return;
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(doRender);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    // Initial render after a microtask to let canvas refs populate
    const t = setTimeout(doRender, 50);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(scrollRafRef.current);
      clearTimeout(t);
    };
    // pdfLoading is needed so the effect re-runs when loading finishes and the container mounts
  }, [pdfDoc, pdfPageCount, pdfScale, fitMode, pdfLoading, getPageAtScroll, renderPageRange, cleanupPage]);

  const setCanvasRef = useCallback((pageNum: number) => (el: HTMLCanvasElement | null) => { if (el) pageCanvasRefs.current.set(pageNum, el); }, []);
  const setWrapperRef = useCallback((pageNum: number) => (el: HTMLDivElement | null) => { if (el) pageWrapperRefs.current.set(pageNum, el); }, []);
  const setTextLayerRef = useCallback((pageNum: number) => (el: HTMLDivElement | null) => { if (el) textLayerRefs.current.set(pageNum, el); }, []);
  const setAnnotationLayerRef = useCallback((pageNum: number) => (el: HTMLDivElement | null) => { if (el) annotationLayerRefs.current.set(pageNum, el); }, []);

  // Zoom — when leaving a fit mode, seed pdfScale from the computed value
  const zoomIn = useCallback(() => {
    const base = fitMode ? computedScaleRef.current : pdfScale;
    setFitMode(null);
    setPdfScale(Math.min(Math.round((base + 0.25) * 100) / 100, 4.0));
  }, [fitMode, pdfScale]);
  const zoomOut = useCallback(() => {
    const base = fitMode ? computedScaleRef.current : pdfScale;
    setFitMode(null);
    setPdfScale(Math.max(Math.round((base - 0.25) * 100) / 100, 0.25));
  }, [fitMode, pdfScale]);
  const zoomFitWidth = useCallback(() => { setFitMode('width'); }, []);
  const zoomFitPage = useCallback(() => { setFitMode('page'); }, []);

  // Push a page to navigation history (for intentional jumps, not scroll)
  const pushNavHistory = useCallback((pageNum: number) => {
    const hist = navHistoryRef.current;
    const idx = navIndexRef.current;
    // Don't push if same as current
    if (hist[idx] === pageNum) return;
    // Truncate forward history
    navHistoryRef.current = hist.slice(0, idx + 1);
    navHistoryRef.current.push(pageNum);
    navIndexRef.current = navHistoryRef.current.length - 1;
  }, []);
  pushNavHistoryRef.current = pushNavHistory;

  const navBack = useCallback(() => {
    if (navIndexRef.current <= 0) return;
    navIndexRef.current--;
    const page = navHistoryRef.current[navIndexRef.current];
    setCurrentPage(page);
    const wrapper = pageWrapperRefs.current.get(page);
    if (wrapper) wrapper.scrollIntoView({ block: 'start' });
    renderPageRange(page);
  }, [renderPageRange]);

  const navForward = useCallback(() => {
    if (navIndexRef.current >= navHistoryRef.current.length - 1) return;
    navIndexRef.current++;
    const page = navHistoryRef.current[navIndexRef.current];
    setCurrentPage(page);
    const wrapper = pageWrapperRefs.current.get(page);
    if (wrapper) wrapper.scrollIntoView({ block: 'start' });
    renderPageRange(page);
  }, [renderPageRange]);

  const navigateToPage = useCallback((pageNum: number) => {
    pushNavHistory(pageNum);
    setCurrentPage(pageNum);
    const wrapper = pageWrapperRefs.current.get(pageNum);
    if (wrapper) wrapper.scrollIntoView({ block: 'start' });
    // Immediately start rendering target + neighbors (don't wait for observer)
    renderPageRange(pageNum);
  }, [renderPageRange, pushNavHistory]);

  const handleGoToPage = useCallback(() => {
    const n = parseInt(goToPageInput, 10);
    if (isNaN(n) || n < 1 || n > pdfPageCount) return;
    navigateToPage(n);
    setGoToPageInput('');
  }, [goToPageInput, pdfPageCount, navigateToPage]);

  const goToPage = useCallback(async (dest: any) => {
    if (!pdfDoc) return;
    try {
      let idx: number;
      if (typeof dest === 'string') { const ref = await pdfDoc.getDestination(dest); if (!ref) return; idx = await pdfDoc.getPageIndex(ref[0]); }
      else if (Array.isArray(dest)) { idx = await pdfDoc.getPageIndex(dest[0]); }
      else return;
      navigateToPage(idx + 1);
    } catch {}
  }, [pdfDoc, navigateToPage]);

  // ── Context menu handlers ────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent, filing: FilingRecord, caseId: string) => {
    e.preventDefault();
    setDocContextMenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY, filing, caseId });
  }, []);

  const handleDocContextMenu = useCallback((e: React.MouseEvent, doc: DocumentRecord, caseId: string, caseName: string, filing: FilingRecord) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu(null);
    setDocContextMenu({ x: e.clientX, y: e.clientY, doc, caseId, caseName, filing });
  }, []);

  useEffect(() => {
    const close = () => { setContextMenu(null); setDocContextMenu(null); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  // Document context menu: Index handler
  const handleIndexDocument = useCallback(async (target: DocumentTarget) => {
    try {
      await fetch(`/api/cases/${target.caseId}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: target.filePaths }),
      });
      loadAll();
    } catch { /* silent */ }
  }, []);

  // Document context menu: Add New Filing handler
  const handleAddNewFiling = useCallback((target: DocumentTarget) => {
    setFilingDialogTarget({ docId: '', caseId: target.caseId, filePath: target.filePaths[0] });
    setFilingDialogCreateMode(true);
    setFilingDialogError('');
    setFilingDialogOpen(true);
  }, []);

  // Document context menu: Add to Existing Filing handler
  const handleAddToExistingFiling = useCallback((target: DocumentTarget) => {
    setFilingDialogTarget({ docId: '', caseId: target.caseId, filePath: target.filePaths[0] });
    setFilingDialogCreateMode(false);
    setFilingDialogError('');
    setFilingDialogOpen(true);
  }, []);

  // Filing dialog submit: parse document then assign to filing
  const handleFilingDialogSubmit = useCallback(async (params: { filingId: string; isNew: boolean }) => {
    if (!filingDialogTarget) return;
    setFilingDialogLoading(true);
    setFilingDialogError('');
    try {
      // Parse the document first
      const parseRes = await fetch(`/api/cases/${filingDialogTarget.caseId}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: [filingDialogTarget.filePath] }),
      });
      if (parseRes.ok) {
        const parseData = await parseRes.json();
        const docResult = parseData.results?.[0];
        if (docResult?.documentId) {
          // Assign document to the filing
          await fetch(`/api/documents/${docResult.documentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filingId: params.filingId }),
          });
        }
      }
      setFilingDialogOpen(false);
      loadAll();
    } catch {
      setFilingDialogError('Network error');
    } finally {
      setFilingDialogLoading(false);
    }
  }, [filingDialogTarget]);

  // Build context menu items for a document
  const getDocMenuItems = useCallback((doc: DocumentRecord, caseId: string, filing: FilingRecord): ContextMenuItem[] => {
    const target: DocumentTarget = { filePaths: [doc.filePath], caseId };
    const actions = {
      onAddNewFiling: handleAddNewFiling,
      onAddToExistingFiling: handleAddToExistingFiling,
      onIndex: handleIndexDocument,
    };
    const isProcessingOrIndexed = doc.status === 'PROCESSING' || doc.status === 'INDEXED';
    return getSharedDocumentMenuItems(target, actions, {
      indexDisabled: isProcessingOrIndexed,
      indexLabel: isProcessingOrIndexed ? 'Index (already indexed)' : 'Index',
    });
  }, [handleAddNewFiling, handleAddToExistingFiling, handleIndexDocument]);

  const handleEditFiling = useCallback(async () => {
    if (!editingFiling) return;
    const { filing, caseId } = editingFiling;
    try {
      const res = await fetch(`/api/cases/${caseId}/filings/${filing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle, filingType: editType }),
      });
      if (res.ok) { setEditingFiling(null); loadAll(); }
    } catch {}
  }, [editingFiling, editTitle, editType]);

  const handleDeleteFiling = useCallback(async (filing: FilingRecord, caseId: string) => {
    try {
      await fetch(`/api/cases/${caseId}/filings/${filing.id}`, { method: 'DELETE' });
      loadAll();
    } catch {}
  }, []);

  // Filter tree
  const filteredCases = useMemo(() => {
    if (!searchQuery.trim()) return casesWithFilings;
    const q = searchQuery.toLowerCase();
    return casesWithFilings.map(c => {
      const caseMatch = c.name.toLowerCase().includes(q) || (c.caseNumber || '').toLowerCase().includes(q);
      const ff = c.filings.map(f => {
        const fm = f.title.toLowerCase().includes(q) || f.filingType.toLowerCase().includes(q);
        const fd = f.documents.filter(d => d.fileName.toLowerCase().includes(q));
        if (fm) return f;
        if (fd.length > 0) return { ...f, documents: fd };
        return null;
      }).filter(Boolean) as FilingRecord[];
      if (caseMatch) return c;
      if (ff.length > 0) return { ...c, filings: ff };
      return null;
    }).filter(Boolean) as CaseWithFilings[];
  }, [casesWithFilings, searchQuery]);

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set); if (next.has(key)) next.delete(key); else next.add(key); setter(next);
  };

  const statusColor = (s: string) => ({ QUEUED: 'bg-gray-200 text-gray-700', PROCESSING: 'bg-yellow-100 text-yellow-800', INDEXED: 'bg-green-100 text-green-800', ERROR: 'bg-red-100 text-red-800' }[s] || 'bg-gray-100 text-gray-600');

  const renderOutline = (items: OutlineItem[], depth = 0) => (
    <ul className={depth > 0 ? 'ml-3 border-l border-gray-200' : ''}>
      {items.map((item, i) => (
        <li key={`${depth}-${i}`}>
          <button onClick={() => goToPage(item.dest)} className="w-full text-left px-2 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded truncate block" title={item.title} style={{ paddingLeft: `${depth * 12 + 8}px` }}>{item.title}</button>
          {item.items?.length > 0 && renderOutline(item.items, depth + 1)}
        </li>
      ))}
    </ul>
  );

  if (loading) return <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" /></div>;

  return (
    <div className={`flex h-full${isDragging ? ' select-none' : ''}`}>
      {/* LEFT PANE: Tree browser */}
      <div className="flex flex-col flex-shrink-0 bg-gray-50 border-r border-gray-200" style={{ width: leftWidth }}>
        <div className="p-3 border-b border-gray-200">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Explorer</h2>
            {isRefreshing && (
              <div className="flex items-center gap-1" title="Refreshing data...">
                <div className="animate-spin rounded-full h-3 w-3 border-b border-blue-500" />
                <span className="text-[10px] text-blue-400">Syncing</span>
              </div>
            )}
          </div>
          <div className="relative">
            <svg className="absolute left-2 top-1.5 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search..." className="w-full pl-7 pr-7 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500" />
            {searchQuery && <button onClick={() => setSearchQuery('')} className="absolute right-1.5 top-1.5 text-gray-400 hover:text-gray-600"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg></button>}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {filteredCases.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">{casesWithFilings.length === 0 ? 'No cases' : 'No matches'}</p>
          ) : filteredCases.map(c => {
            const caseExp = expandedCases.has(c.id);
            const typeGroups: Record<string, FilingRecord[]> = {};
            for (const f of c.filings) { if (!typeGroups[f.filingType]) typeGroups[f.filingType] = []; typeGroups[f.filingType].push(f); }
            return (
              <div key={c.id}>
                {/* Case */}
                <div className={`flex items-center gap-1 px-2 py-1.5 cursor-pointer hover:bg-gray-100 ${selectedDoc?.caseId === c.id && !selectedDoc ? 'bg-blue-50' : ''}`}>
                  <button onClick={() => toggle(expandedCases, c.id, setExpandedCases)} className="p-0.5">
                    <svg className={`w-3 h-3 text-gray-400 transition-transform ${caseExp ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  </button>
                  <svg className="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                  <span onClick={() => { if (!caseExp) toggle(expandedCases, c.id, setExpandedCases); pushUrl(getCaseSlug(c)); }} className="text-sm text-gray-800 truncate flex-1" title={c.name}>{c.name}</span>
                  {c.caseNumber && <span className="text-[10px] text-gray-400 flex-shrink-0">{c.caseNumber}</span>}
                </div>
                {/* Filing type groups */}
                {caseExp && Object.keys(typeGroups).sort().map(typeKey => {
                  const typeId = `${c.id}:${typeKey}`;
                  const typeExp = expandedTypes.has(typeId);
                  const filingsInType = typeGroups[typeKey];
                  const totalDocs = filingsInType.reduce((s, f) => s + f.documents.length, 0);
                  return (
                    <div key={typeId}>
                      <div className="flex items-center gap-1 pl-7 pr-2 py-1 cursor-pointer hover:bg-gray-100">
                        <button onClick={() => toggle(expandedTypes, typeId, setExpandedTypes)} className="p-0.5">
                          <svg className={`w-3 h-3 text-gray-400 transition-transform ${typeExp ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                        </button>
                        <span onClick={() => { if (!typeExp) toggle(expandedTypes, typeId, setExpandedTypes); pushUrl(getCaseSlug(c), typeKey); }} className="text-xs font-medium text-gray-600 flex-1 truncate">{FILING_TYPE_LABELS[typeKey] || typeKey}</span>
                        <span className="text-[10px] text-gray-300">{totalDocs}</span>
                      </div>
                      {typeExp && filingsInType.map(f => {
                        const fExp = expandedFilings.has(f.id);
                        return (
                          <div key={f.id}>
                            <div className={`flex items-center gap-1 pl-12 pr-2 py-1 cursor-pointer hover:bg-gray-100 ${selectedDoc?.filingId === f.id ? 'bg-blue-50' : ''}`}
                              onContextMenu={e => handleContextMenu(e, f, c.id)}>
                              <button onClick={() => toggle(expandedFilings, f.id, setExpandedFilings)} className="p-0.5">
                                <svg className={`w-3 h-3 text-gray-400 transition-transform ${fExp ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                              </button>
                              <span onClick={() => { selectFiling(c, f); if (!fExp) toggle(expandedFilings, f.id, setExpandedFilings); pushUrl(getCaseSlug(c), f.filingType, f.slug); }} className="text-xs text-gray-700 flex-1 truncate" title={f.title}>{f.title}</span>
                              <span className="text-[10px] text-gray-300">{f.documents.length}</span>
                            </div>
                            {fExp && (
                              <div className="ml-14 border-l border-gray-200">
                                {f.documents.map(d => (
                                  <div key={d.id} onClick={() => { selectDocument(d, c, f); pushUrl(getCaseSlug(c), f.filingType, f.slug); }}
                                    onContextMenu={e => handleDocContextMenu(e, d, c.id, c.name, f)}
                                    className={`flex items-center gap-1.5 px-2 py-0.5 cursor-pointer hover:bg-blue-50 text-xs ${selectedDoc?.id === d.id ? 'bg-blue-100' : ''}`}>
                                    <svg className="w-3 h-3 text-red-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" /></svg>
                                    <span className="text-gray-600 truncate">{d.fileName}</span>
                                    <span className={`text-[9px] px-1 py-0 rounded-full flex-shrink-0 ${statusColor(d.status)}`}>{d.status}</span>
                                  </div>
                                ))}
                                {f.documents.length === 0 && <p className="px-2 py-0.5 text-xs text-gray-300 italic">No documents</p>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {caseExp && c.filings.length === 0 && <p className="pl-8 py-1 text-xs text-gray-300 italic">No filings</p>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Left resize handle */}
      <div className="w-1 cursor-col-resize bg-gray-200 hover:bg-blue-400 transition-colors flex-shrink-0" onMouseDown={() => startDrag('left')} />

      {/* CENTER PANE: PDF Viewer */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-100">
        {!selectedDoc ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <svg className="w-16 h-16 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              <p className="text-sm text-gray-400">Click a document to view</p>
            </div>
          </div>
        ) : pdfLoading ? (
          <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" /></div>
        ) : pdfError ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center px-4">
              <p className="text-sm text-red-500">{pdfError}</p>
              <button onClick={() => loadPdf(selectedDoc.id)} className="mt-2 text-xs text-blue-500 hover:underline">Retry</button>
            </div>
          </div>
        ) : (
          <>
            {/* PDF Toolbar */}
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 bg-white flex-shrink-0">
              <button onClick={zoomOut} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="Zoom out">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM13 10H7" /></svg>
              </button>
              <span className="text-xs text-gray-500 min-w-[3rem] text-center">{fitMode ? `${Math.round(computedScaleRef.current * 100)}%` : `${Math.round(pdfScale * 100)}%`}</span>
              <button onClick={zoomIn} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="Zoom in">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" /></svg>
              </button>
              <button onClick={zoomFitWidth} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${fitMode === 'width' ? 'bg-blue-100 text-blue-600' : 'hover:bg-gray-100 text-gray-500'}`} title="Fit to width">
                Width
              </button>
              <button onClick={zoomFitPage} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${fitMode === 'page' ? 'bg-blue-100 text-blue-600' : 'hover:bg-gray-100 text-gray-500'}`} title="Fit to page">
                Page
              </button>
              <div className="w-px h-4 bg-gray-200 mx-1" />
              <button onClick={navBack} className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-default" title="Back" disabled={navIndexRef.current <= 0}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
              <button onClick={navForward} className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30 disabled:cursor-default" title="Forward" disabled={navIndexRef.current >= navHistoryRef.current.length - 1}>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </button>
              <div className="w-px h-4 bg-gray-200 mx-1" />
              <span className="text-xs text-gray-500 font-medium">{currentPage}</span>
              <input type="text" value={goToPageInput} onChange={e => setGoToPageInput(e.target.value.replace(/\D/g, ''))} onKeyDown={e => { if (e.key === 'Enter') handleGoToPage(); }} placeholder="Go to..." className="w-16 px-1.5 py-0.5 border border-gray-300 rounded text-xs text-center focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <span className="text-xs text-gray-400">/ {pdfPageCount}</span>
              <div className="flex-1" />
              <span className="text-xs text-gray-500 truncate max-w-[200px]" title={selectedDoc.fileName}>{selectedDoc.fileName}</span>
            </div>
            {/* PDF Pages */}
            <div ref={pdfContainerRef} className="flex-1 overflow-auto p-4 space-y-2">
              {Array.from({ length: pdfPageCount }, (_, i) => i + 1).map(pageNum => {
                // Compute placeholder dimensions at current effective scale
                const effScale = fitMode ? computedScaleRef.current || 1 : pdfScale;
                const phW = Math.floor(placeholderDims.w * effScale);
                const phH = Math.floor(placeholderDims.h * effScale);
                return (
                  <div key={pageNum} className="flex flex-col items-center">
                    <div
                      ref={setWrapperRef(pageNum)}
                      data-page={pageNum}
                      className="relative shadow-md bg-white"
                      style={{ width: phW, minHeight: phH }}
                    >
                      {/* Loading spinner shown until canvas renders */}
                      <div className="page-placeholder absolute inset-0 flex items-center justify-center">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-400" />
                      </div>
                      <canvas ref={setCanvasRef(pageNum)} style={{ display: 'none' }} />
                      <div ref={setTextLayerRef(pageNum)} className="textLayer" style={{ display: 'none' }} />
                      <div ref={setAnnotationLayerRef(pageNum)} className="annotationLayer" style={{ display: 'none' }} />
                    </div>
                    <span className="text-[10px] text-gray-400 mt-1">Page {pageNum}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Right resize handle */}
      <div className="w-1 cursor-col-resize bg-gray-200 hover:bg-blue-400 transition-colors flex-shrink-0" onMouseDown={() => startDrag('right')} />

      {/* RIGHT PANE: TOC / Doc Info */}
      <div className="flex flex-col flex-shrink-0 bg-white border-l border-gray-200" style={{ width: rightWidth }}>
        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          <button onClick={() => setRightTab('toc')} className={`flex-1 px-3 py-2 text-xs font-medium ${rightTab === 'toc' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>TOC</button>
          <button onClick={() => setRightTab('docinfo')} className={`flex-1 px-3 py-2 text-xs font-medium ${rightTab === 'docinfo' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>Doc Info</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rightTab === 'toc' ? (
            !selectedDoc ? (
              <p className="text-xs text-gray-400 text-center py-8">Select a document</p>
            ) : pdfOutline.length > 0 ? (
              <div className="py-1">{renderOutline(pdfOutline)}</div>
            ) : extractedHeadings.length > 0 ? (
              <ul className="py-1">
                {extractedHeadings.map((h, i) => (
                  <li key={i}>
                    <button onClick={() => navigateToPage(h.page)} className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 truncate" title={`${h.text} (p.${h.page})`}>
                      <span className="text-gray-400 mr-1">{h.page}</span> {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-gray-400 text-center py-8">{pdfLoading ? 'Loading...' : 'No headings found'}</p>
            )
          ) : (
            !selectedDoc ? (
              <p className="text-xs text-gray-400 text-center py-8">Select a document</p>
            ) : (
              <div className="p-3 space-y-3 text-xs">
                <div><span className="text-gray-400">File</span><p className="text-gray-700 break-all">{selectedDoc.fileName}</p></div>
                <div><span className="text-gray-400">Case</span><p className="text-gray-700">{selectedDoc.caseName}</p></div>
                <div><span className="text-gray-400">Filing</span><p className="text-gray-700">{selectedDoc.filingTitle}</p></div>
                <div><span className="text-gray-400">Type</span><p className="text-gray-700">{selectedDoc.filingType}</p></div>
                <div><span className="text-gray-400">Status</span><p><span className={`px-1.5 py-0.5 rounded-full text-[10px] ${statusColor(selectedDoc.status)}`}>{selectedDoc.status}</span></p></div>
                {selectedDoc.pageCount && <div><span className="text-gray-400">Pages</span><p className="text-gray-700">{selectedDoc.pageCount}</p></div>}
                {selectedDoc.documentType && <div><span className="text-gray-400">Doc Type</span><p className="text-gray-700">{selectedDoc.documentType}</p></div>}
                {selectedDoc.documentSummary && <div><span className="text-gray-400">Summary</span><p className="text-gray-700">{selectedDoc.documentSummary}</p></div>}
                <div><span className="text-gray-400">Created</span><p className="text-gray-700">{new Date(selectedDoc.createdAt).toLocaleDateString()}</p></div>
              </div>
            )
          )}
        </div>
      </div>

      {/* Filing-level context menu */}
      {contextMenu && contextMenu.filing && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: 'Edit Filing',
              icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
              onClick: () => {
                setEditingFiling({ filing: contextMenu.filing!, caseId: contextMenu.caseId! });
                setEditTitle(contextMenu.filing!.title);
                setEditType(contextMenu.filing!.filingType);
              },
            },
            {
              label: 'Delete Filing',
              icon: <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
              onClick: () => handleDeleteFiling(contextMenu.filing!, contextMenu.caseId!),
              danger: true,
            },
          ]}
        />
      )}

      {/* Document-level context menu */}
      {docContextMenu && (
        <ContextMenu
          x={docContextMenu.x}
          y={docContextMenu.y}
          onClose={() => setDocContextMenu(null)}
          items={getDocMenuItems(docContextMenu.doc, docContextMenu.caseId, docContextMenu.filing)}
        />
      )}

      {/* Filing dialog for document actions */}
      {filingDialogTarget && (
        <FilingDialog
          open={filingDialogOpen}
          onClose={() => setFilingDialogOpen(false)}
          fileNames={[filingDialogTarget.filePath.split('/').pop() || filingDialogTarget.filePath]}
          caseId={filingDialogTarget.caseId}
          createMode={filingDialogCreateMode}
          onSubmit={handleFilingDialogSubmit}
          loading={filingDialogLoading}
          error={filingDialogError}
        />
      )}

      {/* Edit filing dialog overlay */}
      {editingFiling && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-lg shadow-xl p-5 w-96">
            <h3 className="text-sm font-semibold text-gray-800 mb-3">Edit Filing</h3>
            <label className="block text-xs text-gray-500 mb-1">Title</label>
            <input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm mb-3 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            <label className="block text-xs text-gray-500 mb-1">Filing Type</label>
            <select value={editType} onChange={e => setEditType(e.target.value)} className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm mb-4 focus:outline-none focus:ring-1 focus:ring-blue-500">
              {FILING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditingFiling(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded">Cancel</button>
              <button onClick={handleEditFiling} className="px-3 py-1.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
