'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { ContextMenu, type ContextMenuItem } from '@/components/context-menu';
import { SearchableCombo } from '@/components/searchable-combo';
import { getCachedCases, setCachedCases, getCachedFilings, setCachedFilings } from '@/lib/indexed-db';
import { formatFilingLabel } from '@/lib/filings/format-filing-label';
import { TagPanel } from '@/components/case/tag-panel';
import { TAG_SPEC_BY_KIND, type EntityKind } from '@/components/case/tag-spec';
import {
  read as hsRead,
  commit as hsCommit,
  firstRow as hsFirstRow,
  gridHasError as hsGridHasError,
} from '@/lib/haystack-client';
import { classifyFilingEntityKind } from '@/lib/filings/classify-entity-kind';

/**
 * Mirror Filing-row volume/supplemental fields onto the per-type entity's
 * tags JSON. Only writes keys whose tag spec exists on `entityKind`
 * (today: `volume` + `supplemental` live on clerksRecord / reportersRecord;
 * `supplementalOrder` is not a spec on any kind, so it's always dropped).
 * Returns null when no relevant spec exists so the caller can skip the
 * hsCommit altogether.
 */
function buildFilingEntityTagPatch(
  entityKind: EntityKind,
  vals: { volume: number | null; isSupplemental: boolean; supplementalOrder: number | null },
): Record<string, unknown> | null {
  const specs = TAG_SPEC_BY_KIND[entityKind];
  if (!specs) return null;
  const names = new Set(specs.map(s => s.name));
  const patch: Record<string, unknown> = {};
  if (names.has('volume')) patch.volume = vals.volume;
  if (names.has('supplemental')) patch.supplemental = vals.isSupplemental ? { _kind: 'marker' } : null;
  if (names.has('supplementalOrder')) patch.supplementalOrder = vals.supplementalOrder;
  return Object.keys(patch).length ? patch : null;
}

interface CaseRecord {
  id: string;
  name: string;
  path: string;
  caseNumber: string | null;
  jurisdiction: string | null;
  county: string | null;
  state: string | null;
  country: string | null;
  totalDocuments: number;
  createdAt: string;
}

interface FilingRecord {
  id: string;
  filingType: string;
  title: string;
  slug: string;
  volumeNumber: number | null;
  isSupplemental: boolean;
  supplementalOrder: number | null;
  documents: DocumentRecord[];
}

interface DocumentRecord {
  id: string;
  fileName: string;
  filePath: string;
  status: string;
  exhibitLabel: string | null;
}

const FILING_TYPES = [
  'Motion', 'Counter Motion', 'Notice', 'Supplemental Notice', 'Letter', 'Order',
  'Petition', 'Affidavit', 'Subpoena', 'Brief', 'Response', 'Reply',
  'Judgment', 'Decree', "Clerk's Record", "Reporter's Record",
  'Transcript', 'Settlement', 'Bill of Review', 'Return of Service',
  'Demand Letter', 'Objection', 'Request', 'Supplement', 'Designation',
  'Memorandum', 'Stipulation', 'Writ', 'Summons', 'Complaint',
  'Other',
];

/** Color mapping for filing type badges */
const FILING_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  'Motion': { bg: 'bg-blue-100', text: 'text-blue-700' },
  'Counter Motion': { bg: 'bg-blue-200', text: 'text-blue-800' },
  'Notice': { bg: 'bg-amber-100', text: 'text-amber-700' },
  'Supplemental Notice': { bg: 'bg-amber-200', text: 'text-amber-800' },
  'Letter': { bg: 'bg-gray-100', text: 'text-gray-700' },
  'Order': { bg: 'bg-purple-100', text: 'text-purple-700' },
  'Petition': { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  'Affidavit': { bg: 'bg-teal-100', text: 'text-teal-700' },
  'Subpoena': { bg: 'bg-red-100', text: 'text-red-700' },
  'Brief': { bg: 'bg-cyan-100', text: 'text-cyan-700' },
  'Response': { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  'Reply': { bg: 'bg-lime-100', text: 'text-lime-700' },
  'Judgment': { bg: 'bg-orange-100', text: 'text-orange-700' },
  'Decree': { bg: 'bg-orange-200', text: 'text-orange-800' },
  "Clerk's Record": { bg: 'bg-slate-100', text: 'text-slate-700' },
  "Reporter's Record": { bg: 'bg-slate-200', text: 'text-slate-700' },
  'Transcript': { bg: 'bg-violet-100', text: 'text-violet-700' },
  'Settlement': { bg: 'bg-green-100', text: 'text-green-700' },
  'Bill of Review': { bg: 'bg-rose-100', text: 'text-rose-700' },
  'Return of Service': { bg: 'bg-sky-100', text: 'text-sky-700' },
  'Demand Letter': { bg: 'bg-red-50', text: 'text-red-600' },
  'Objection': { bg: 'bg-pink-100', text: 'text-pink-700' },
  'Request': { bg: 'bg-fuchsia-100', text: 'text-fuchsia-700' },
  'Supplement': { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  'Designation': { bg: 'bg-zinc-100', text: 'text-zinc-700' },
  'Other': { bg: 'bg-gray-100', text: 'text-gray-600' },
};

function getFilingTypeColor(filingType: string) {
  return FILING_TYPE_COLORS[filingType] || FILING_TYPE_COLORS['Other'];
}

/** Compute aggregate status icon for a filing based on its documents */
function getFilingStatusIcon(docs: DocumentRecord[]): { icon: string; color: string; title: string; animate?: boolean } {
  if (docs.length === 0) return { icon: 'empty', color: 'text-gray-300', title: 'No documents' };
  const statuses = docs.map(d => d.status);
  if (statuses.some(s => s === 'PROCESSING')) return { icon: 'processing', color: 'text-yellow-500', title: 'Processing', animate: true };
  if (statuses.some(s => s === 'QUEUED')) return { icon: 'queued', color: 'text-yellow-400', title: 'Queued for parsing' };
  if (statuses.some(s => s === 'ERROR')) return { icon: 'error', color: 'text-red-500', title: 'Has errors' };
  if (statuses.every(s => s === 'INDEXED')) return { icon: 'indexed', color: 'text-green-500', title: 'All indexed' };
  return { icon: 'partial', color: 'text-blue-400', title: 'Partially indexed' };
}

function FilingStatusIcon({ docs }: { docs: DocumentRecord[] }) {
  const { icon, color, title, animate } = getFilingStatusIcon(docs);
  const cls = `w-3.5 h-3.5 flex-shrink-0 ${color} ${animate ? 'animate-pulse' : ''}`;
  const svgEl = (() => {
    switch (icon) {
      case 'processing':
        return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>;
      case 'queued':
        return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
      case 'error':
        return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>;
      case 'indexed':
        return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>;
      case 'partial':
        return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>;
      default:
        return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" strokeWidth={2} /></svg>;
    }
  })();
  return <span title={title}>{svgEl}</span>;
}

const FILING_CATEGORIES = [
  { key: 'all', label: 'All Filings' },
  { key: 'Motion', label: 'Motions' },
  { key: 'Notice', label: 'Notices' },
  { key: 'Order', label: 'Orders' },
  { key: 'Brief', label: 'Briefs' },
  { key: "Clerk's Record", label: "Clerk's Records" },
  { key: "Reporter's Record", label: "Reporter's Records" },
  { key: 'Other', label: 'Others' },
];

export default function CaseManagementLayout({ children }: { children: React.ReactNode }) {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [filings, setFilings] = useState<FilingRecord[]>([]);
  const [activeCategory, setActiveCategory] = useState('all');
  const [expandedFilings, setExpandedFilings] = useState<Set<string>>(new Set());
  const [selectedFilings, setSelectedFilings] = useState<Set<string>>(new Set());
const [copiedFilings, setCopiedFilings] = useState<Set<string>>(new Set());
  const lastSelectedFilingRef = useRef<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [caseName, setCaseName] = useState('');
  const [caseNumber, setCaseNumber] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [addError, setAddError] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [county, setCounty] = useState('');
  const [state, setState] = useState('');
  const [country, setCountry] = useState('United States');
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [browseDir, setBrowseDir] = useState('');
  const [browseFolders, setBrowseFolders] = useState<Array<{ name: string; path: string }>>([]);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  // Tracks the entity currently selected in the children pages, for the
  // right-hand TagPanel. Child pages may override via 'selected-entity-changed'
  // CustomEvents; otherwise we fall back to URL-derived selection below.
  const [selectedOverride, setSelectedOverride] = useState<{ kind: EntityKind; id: string; label?: string } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind: EntityKind; id: string; label?: string } | null;
      setSelectedOverride(detail);
    };
    window.addEventListener('selected-entity-changed', handler);
    return () => window.removeEventListener('selected-entity-changed', handler);
  }, []);

  // Reset override when navigating to a different case
  useEffect(() => {
    setSelectedOverride(null);
  }, [pathname]);

  // Resizable sidebar state
  const SIDEBAR_MIN = 240;
  const SIDEBAR_MAX = 600;
  const SIDEBAR_DEFAULT = 320;
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const isResizing = useRef(false);

  // Load persisted sidebar width from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('case-sidebar-width');
    if (saved) {
      const w = parseInt(saved, 10);
      if (w >= SIDEBAR_MIN && w <= SIDEBAR_MAX) setSidebarWidth(w);
    }
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist on drag end
      setSidebarWidth(prev => {
        localStorage.setItem('case-sidebar-width', String(prev));
        return prev;
      });
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Context menu state for sidebar
  const [sidebarContextMenu, setSidebarContextMenu] = useState<{
    x: number; y: number;
    type: 'case' | 'document' | 'filing';
    caseRecord?: CaseRecord;
    document?: DocumentRecord;
    filing?: FilingRecord;
  } | null>(null);

  // Filing edit dialog state
  const [showEditFilingDialog, setShowEditFilingDialog] = useState(false);
  const [editFilingId, setEditFilingId] = useState('');
  const [editFilingType, setEditFilingType] = useState('');
  const [editFilingTitle, setEditFilingTitle] = useState('');
  const [editFilingVolume, setEditFilingVolume] = useState('');
  const [editFilingSupplemental, setEditFilingSupplemental] = useState(false);
  const [editFilingSupplementalOrder, setEditFilingSupplementalOrder] = useState('');
  const [editFilingLoading, setEditFilingLoading] = useState(false);

  // Case edit dialog state
  const [showEditCaseDialog, setShowEditCaseDialog] = useState(false);
  const [editCaseRecord, setEditCaseRecord] = useState<CaseRecord | null>(null);
  const [editCaseName, setEditCaseName] = useState('');
  const [editCaseNumber, setEditCaseNumber] = useState('');
  const [editCaseJurisdiction, setEditCaseJurisdiction] = useState('');
  const [editCasePath, setEditCasePath] = useState('');
  const [editCaseCounty, setEditCaseCounty] = useState('');
  const [editCaseState, setEditCaseState] = useState('');
  const [editCaseCountry, setEditCaseCountry] = useState('');
  const [editCaseLoading, setEditCaseLoading] = useState(false);
  const [editCaseError, setEditCaseError] = useState('');

  // Location data for searchable combos
  const [stateOptions, setStateOptions] = useState<string[]>([]);
  const [countyOptions, setCountyOptions] = useState<string[]>([]);
  const [countryOptions, setCountryOptions] = useState<string[]>([]);

  useEffect(() => { loadCases(); }, []);

  // Load location data on mount
  useEffect(() => {
    fetch('/api/locations?type=states').then(r => r.ok ? r.json() : []).then(setStateOptions).catch(() => {});
    fetch('/api/locations?type=countries').then(r => r.ok ? r.json() : []).then(setCountryOptions).catch(() => {});
  }, []);

  // Load counties when state changes (for add dialog)
  useEffect(() => {
    const s = state || editCaseState;
    if (s) {
      fetch(`/api/locations?type=counties&state=${encodeURIComponent(s)}`)
        .then(r => r.ok ? r.json() : []).then(setCountyOptions).catch(() => {});
    } else {
      setCountyOptions([]);
    }
  }, [state, editCaseState]);

  const loadCases = async () => {
    // Try IndexedDB first for instant render
    try {
      const cached = await getCachedCases();
      if (cached?.data && cached.data.length > 0) {
        setCases(cached.data as CaseRecord[]);
        if (!cached.isStale) return;
      }
    } catch { /* IndexedDB unavailable */ }
    // Fetch fresh from API
    const res = await fetch('/api/cases');
    if (res.ok) {
      const data = await res.json();
      setCases(data.cases);
      setCachedCases(data.cases).catch(() => {});
    }
  };

  // Determine which case is selected from the URL
  const pathParts = pathname.split('/').filter(Boolean);
  const activeCaseNumber = pathParts.length > 1 ? decodeURIComponent(pathParts[1]) : null;
  const activeCase = cases.find(c => (c.caseNumber || c.id) === activeCaseNumber);

  // Load filings when active case changes
  useEffect(() => {
    if (activeCase) {
      loadFilings(activeCase.id);
    } else {
      setFilings([]);
    }
  }, [activeCase?.id]);

  // Listen for filing changes from child pages
  useEffect(() => {
    const handler = () => {
      if (activeCase) loadFilings(activeCase.id, true);
    };
    window.addEventListener('filings-changed', handler);
    return () => window.removeEventListener('filings-changed', handler);
  }, [activeCase?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadFilings = async (caseId: string, skipCache = false) => {
    // Try IndexedDB first for instant render (skip when explicitly refreshing)
    if (!skipCache) {
      try {
        const cached = await getCachedFilings(caseId);
        if (cached?.data && cached.data.length > 0) {
          setFilings(cached.data as FilingRecord[]);
          if (!cached.isStale) return;
        }
      } catch { /* IndexedDB unavailable */ }
    }
    // Fetch fresh from API
    try {
      const res = await fetch(`/api/cases/${caseId}/filings`);
      if (res.ok) {
        const data = await res.json();
        setFilings(data.filings || []);
        setCachedFilings(caseId, data.filings || []).catch(() => {});
      }
    } catch { setFilings([]); }
  };

  // Auto-fill form fields when folder path changes
  useEffect(() => {
    if (!folderPath.trim()) {
      setCaseName(''); setCaseNumber(''); setJurisdiction('');
      return;
    }
    const folderName = (folderPath.replace(/\/+$/, '').split('/').pop() || '').trim();
    const match = folderName.match(/^(.+?)\s*-\s*([A-Z0-9][\w-]+.*)$/i);
    if (match) {
      setCaseName(match[1].trim());
      setCaseNumber(match[2].trim());
      const jurisMatch = match[2].trim().match(/^([A-Z](?:-\d+)?-[A-Z]+)/i);
      setJurisdiction(jurisMatch ? jurisMatch[1] : '');
    } else {
      setCaseName(folderName); setCaseNumber(''); setJurisdiction('');
    }
  }, [folderPath]);

  const handleAddCase = async () => {
    setAddError('');
    setAddLoading(true);
    try {
      // TODO: switch to haystackClient.create() once it lands.
      // For now we POST directly to the haystack-proxy /commit endpoint with
      // id: 'new', which Agent A's commit handler maps to a Prisma create.
      const patch = {
        name: caseName.trim(),
        caseNumber: caseNumber.trim(),
        path: folderPath.trim(),
        jurisdiction: jurisdiction.trim(),
        county: county.trim(),
        state: state.trim(),
        country: country.trim(),
      };
      const res = await fetch('/api/haystack-proxy/commit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'new', kind: 'case', patch }),
      });
      if (!res.ok) {
        setAddError(`Failed to add case (HTTP ${res.status})`);
        return;
      }
      const grid = await res.json();
      const gridErr = hsGridHasError(grid);
      if (gridErr) { setAddError(gridErr); return; }
      const row = hsFirstRow<{ id?: string; caseNumber?: string | null }>(grid);
      if (!row?.id) { setAddError('Create returned no row'); return; }
      setShowAddDialog(false);
      setFolderPath('');
      await loadCases();
      const cn = row.caseNumber || row.id;
      router.push(`/case-management/${encodeURIComponent(cn)}`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Network error');
    } finally { setAddLoading(false); }
  };

  const browseTo = async (dirPath?: string) => {
    setBrowseLoading(true);
    try {
      const url = dirPath ? `/api/browse?path=${encodeURIComponent(dirPath)}` : '/api/browse';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setBrowseDir(data.current);
        setBrowseFolders(data.folders);
        setBrowseParent(data.parent);
      }
    } catch { /* ignore */ }
    finally { setBrowseLoading(false); }
  };

  const openFolderPicker = () => {
    setShowFolderPicker(true);
    browseTo(folderPath.trim() || undefined);
  };

  const selectBrowseFolder = (folderFullPath: string) => {
    setFolderPath(folderFullPath);
    setShowFolderPicker(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Try to get the folder path from the dropped items
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const item = items[0];
      // webkitGetAsEntry gives us the full path for local files
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        // fullPath from webkitGetAsEntry is relative, but the File API gives us the name
        // For local Electron/browser apps, we use the file path from dataTransfer
        const files = e.dataTransfer.files;
        if (files.length > 0) {
          // The path property is available in Electron but not standard browsers
          const file = files[0] as File & { path?: string };
          if (file.path) {
            setFolderPath(file.path);
            return;
          }
        }
        // Fallback: use the entry name
        setFolderPath(entry.fullPath || entry.name);
      }
    }
  };

  const handleDeleteCase = async (c: CaseRecord) => {
    if (!confirm('Delete this case and all its documents?')) return;
    const res = await fetch(`/api/cases/${c.id}`, { method: 'DELETE' });
    if (res.ok) {
      const cn = c.caseNumber || c.id;
      if (activeCaseNumber === cn) router.push('/case-management');
      await loadCases();
    }
  };

  const handleDeleteDocument = async (doc: DocumentRecord) => {
    if (!confirm(`Remove "${doc.fileName}" from the database?`)) return;
    const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
    if (res.ok && activeCase) {
      await loadFilings(activeCase.id);
    }
  };

  const handleCaseContextMenu = (c: CaseRecord, e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarContextMenu({ x: e.clientX, y: e.clientY, type: 'case', caseRecord: c });
  };

  const handleDocContextMenu = (doc: DocumentRecord, e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarContextMenu({ x: e.clientX, y: e.clientY, type: 'document', document: doc });
  };

  const handleFilingContextMenu = (filing: FilingRecord, e: React.MouseEvent) => {
    e.preventDefault();
    setSidebarContextMenu({ x: e.clientX, y: e.clientY, type: 'filing', filing });
  };

  const handleDeleteFiling = async (filing: FilingRecord) => {
    if (!activeCase) {
      console.error('handleDeleteFiling: no activeCase');
      return;
    }
    try {
      const res = await fetch(`/api/cases/${activeCase.id}/filings/${filing.id}`, { method: 'DELETE' });
      if (res.ok) {
        await loadFilings(activeCase.id);
        window.dispatchEvent(new Event('filings-changed'));
        if (pathname.includes(encodeURIComponent(filing.slug))) {
          router.push(`/case-management/${encodeURIComponent(activeCaseNumber!)}`);
        }
      } else {
        console.error('Failed to delete filing:', await res.text().catch(() => res.statusText));
      }
    } catch (err) {
      console.error('Network error deleting filing:', err);
    }
  };

  const handleEditFilingSave = async () => {
    if (!activeCase || !editFilingId) return;
    setEditFilingLoading(true);
    try {
      // Filing-level columns must go to the dedicated PATCH route — hsCommit
      // routes per-type kinds (e.g. 'order') to the motionAttachment table,
      // which has no title/filingType/etc columns, so the patch silently
      // disappears into its `tags` JSON and Filing.title never updates.
      const volume = editFilingVolume.trim() ? parseInt(editFilingVolume, 10) : null;
      const suppOrder = editFilingSupplementalOrder.trim()
        ? parseInt(editFilingSupplementalOrder, 10)
        : null;
      // Mirror volume/supplemental/supplementalOrder onto the per-type
      // entity's tags JSON so the right-hand tag panel reflects the
      // dialog edit without a refresh. Filing-level columns remain the
      // source of truth (don't roll back the Filing PATCH on tag-sync
      // failure — surface a non-blocking warning instead).
      const { entityKind: targetEntityKind } = classifyFilingEntityKind(editFilingType);
      const tagPatch = buildFilingEntityTagPatch(targetEntityKind, {
        volume,
        isSupplemental: editFilingSupplemental,
        supplementalOrder: suppOrder,
      });
      const filingPatchP = fetch(`/api/cases/${activeCase.id}/filings/${editFilingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editFilingTitle.trim(),
          filingType: editFilingType,
          volumeNumber: volume,
          isSupplemental: editFilingSupplemental,
          supplementalOrder: suppOrder,
        }),
      });
      const tagPatchP = tagPatch
        ? hsCommit({ id: editFilingId, kind: targetEntityKind, patch: tagPatch }).then(grid => {
            const err = hsGridHasError(grid);
            if (err) console.warn('Edit filing: entity-tag sync failed:', err);
            return grid;
          }).catch(err => {
            console.warn('Edit filing: entity-tag sync error:', err);
            return null;
          })
        : Promise.resolve(null);
      const [res] = await Promise.all([filingPatchP, tagPatchP]);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Edit filing failed:', err);
        return;
      }
      const data = await res.json() as { filing: { slug?: string | null } };
      setShowEditFilingDialog(false);
      await loadFilings(activeCase.id);
      window.dispatchEvent(new Event('filings-changed'));
      // If slug changed and we're on this filing's page, navigate to the new slug.
      if (data.filing?.slug && pathname.includes(editFilingId)) {
        router.push(`/case-management/${encodeURIComponent(activeCaseNumber!)}/${encodeURIComponent(data.filing.slug)}`);
      }
    } catch (err) {
      console.error('Edit filing error:', err);
    } finally { setEditFilingLoading(false); }
  };

  const openEditCaseDialog = (c: CaseRecord) => {
    // Optimistic-fill from the sidebar's cached record so the dialog renders
    // instantly. The effect below will overwrite with fresh Haystack data.
    setEditCaseRecord(c);
    setEditCaseName(c.name);
    setEditCaseNumber(c.caseNumber || '');
    setEditCaseJurisdiction(c.jurisdiction || '');
    setEditCasePath(c.path);
    setEditCaseCounty(c.county || '');
    setEditCaseState(c.state || '');
    setEditCaseCountry(c.country || 'United States');
    setEditCaseError('');
    setShowEditCaseDialog(true);
  };

  // Re-hydrate the Edit Case form from Haystack whenever it opens. This makes
  // the dialog see the same authoritative columns the tag panel reads from.
  useEffect(() => {
    if (!showEditCaseDialog || !editCaseRecord?.id) return;
    let cancelled = false;
    hsRead({ filter: 'case', id: editCaseRecord.id })
      .then(grid => {
        if (cancelled) return;
        if (hsGridHasError(grid)) return;
        const row = hsFirstRow<CaseRecord & Record<string, unknown>>(grid);
        if (!row) return;
        setEditCaseName(typeof row.name === 'string' ? row.name : '');
        setEditCaseNumber(typeof row.caseNumber === 'string' ? row.caseNumber : '');
        setEditCasePath(typeof row.path === 'string' ? row.path : '');
        setEditCaseJurisdiction(typeof row.jurisdiction === 'string' ? row.jurisdiction : '');
        setEditCaseCounty(typeof row.county === 'string' ? row.county : '');
        setEditCaseState(typeof row.state === 'string' ? row.state : '');
        setEditCaseCountry(typeof row.country === 'string' ? row.country : 'United States');
        setEditCaseRecord(prev => (prev ? { ...prev, ...row } : prev));
      })
      .catch(() => { /* keep optimistic fill */ });
    return () => { cancelled = true; };
  }, [showEditCaseDialog, editCaseRecord?.id]);

  const handleEditCaseSave = async () => {
    if (!editCaseRecord || !editCaseName.trim()) return;
    setEditCaseLoading(true);
    setEditCaseError('');
    try {
      const patch: Record<string, unknown> = {
        name: editCaseName.trim(),
        caseNumber: editCaseNumber.trim(),
        jurisdiction: editCaseJurisdiction.trim(),
        county: editCaseCounty.trim(),
        state: editCaseState.trim(),
        country: editCaseCountry.trim(),
      };
      // Only send path when the user actually changed it — otherwise the
      // server's path-existence check can block unrelated field edits when
      // the case folder isn't currently mounted.
      if (editCasePath.trim() !== (editCaseRecord.path || '').trim()) {
        patch.path = editCasePath.trim();
      }
      const pathChanged = patch.path !== undefined;
      const grid = await hsCommit({ id: editCaseRecord.id, kind: 'case', patch });
      const gridErr = hsGridHasError(grid);
      if (gridErr) { setEditCaseError(gridErr); return; }
      const row = hsFirstRow<CaseRecord & { id: string }>(grid);
      setShowEditCaseDialog(false);
      // Refresh local state from response so sidebar + form stay in sync.
      if (row) {
        setEditCaseRecord(prev => (prev ? { ...prev, ...row } : prev));
      }
      await loadCases();
      // When the case path changed, the FileWatcher has been re-attached
      // server-side (applyCaseSideEffects in /api/haystack/commit). The
      // indexing badges in the sidebar are derived from filing/document
      // status, which the FileWatcher refreshes asynchronously as it
      // re-scans the new directory. Force a filings refetch now so the
      // sidebar picks up any status changes already in the DB, and again
      // shortly afterwards to catch the re-scan results.
      if (pathChanged && activeCase) {
        await loadFilings(activeCase.id, true);
        window.dispatchEvent(new Event('filings-changed'));
        // Re-poll once after the watcher has had a chance to re-scan. The
        // file-watcher's polling interval defaults to ~5s — refetch a bit
        // after that so freshly-discovered documents surface without forcing
        // a full page reload.
        setTimeout(() => {
          if (activeCase) {
            loadFilings(activeCase.id, true).catch(() => {});
            window.dispatchEvent(new Event('filings-changed'));
          }
        }, 6000);
      }
      // If case number changed, navigate to the new URL
      const oldCn = editCaseRecord.caseNumber || editCaseRecord.id;
      const newCn = (row?.caseNumber as string | null | undefined) || row?.id || oldCn;
      if (activeCaseNumber === oldCn && newCn !== oldCn) {
        router.push(`/case-management/${encodeURIComponent(newCn)}`);
      }
    } catch (err) {
      setEditCaseError(err instanceof Error ? err.message : 'Network error');
    } finally { setEditCaseLoading(false); }
  };

  const getSidebarContextMenuItems = (): ContextMenuItem[] => {
    if (!sidebarContextMenu) return [];
    if (sidebarContextMenu.type === 'case' && sidebarContextMenu.caseRecord) {
      const c = sidebarContextMenu.caseRecord;
      return [
        {
          label: 'Edit Case',
          icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
          onClick: () => openEditCaseDialog(c),
        },
        { label: '', onClick: () => {}, separator: true },
        {
          label: 'Delete Case',
          icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
          onClick: () => handleDeleteCase(c),
          danger: true,
        },
      ];
    }
    if (sidebarContextMenu.type === 'document' && sidebarContextMenu.document) {
      const doc = sidebarContextMenu.document;
      return [
        {
          label: 'Remove from Database',
          icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
          onClick: () => handleDeleteDocument(doc),
        },
      ];
    }
    if (sidebarContextMenu.type === 'filing' && sidebarContextMenu.filing) {
      const f = sidebarContextMenu.filing;
      return [
        {
          label: 'Edit Filing',
          icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
          onClick: () => {
            setEditFilingId(f.id);
            setEditFilingType(f.filingType);
            setEditFilingTitle(f.title);
            setEditFilingVolume(f.volumeNumber != null ? String(f.volumeNumber) : '');
            setEditFilingSupplemental(f.isSupplemental || false);
            setEditFilingSupplementalOrder(f.supplementalOrder != null ? String(f.supplementalOrder) : '');
            setShowEditFilingDialog(true);
          },
        },
        { label: '', onClick: () => {}, separator: true },
        {
          label: 'Delete Filing',
          icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
          onClick: () => handleDeleteFiling(f),
          danger: true,
        },
      ];
    }
    return [];
  };

  const handleCaseClick = (c: CaseRecord) => {
    const cn = c.caseNumber || c.id;
    router.push(`/case-management/${encodeURIComponent(cn)}`);
  };

  const toggleFiling = (filingId: string) => {
    setExpandedFilings(prev => {
      const next = new Set(prev);
      if (next.has(filingId)) next.delete(filingId); else next.add(filingId);
      return next;
    });
  };

  const handleFilingClick = (filing: FilingRecord) => {
    if (!activeCaseNumber) return;
    router.push(`/case-management/${encodeURIComponent(activeCaseNumber)}/${encodeURIComponent(filing.slug)}`);
  };

  const handleFilingSelect = (filing: FilingRecord, e: React.MouseEvent) => {
    const id = filing.id;
    if (e.metaKey || e.ctrlKey) {
      // Toggle individual selection
      setSelectedFilings(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      lastSelectedFilingRef.current = id;
    } else if (e.shiftKey && lastSelectedFilingRef.current) {
      // Range select
      const ids = filteredFilings.map(f => f.id);
      const lastIdx = ids.indexOf(lastSelectedFilingRef.current);
      const curIdx = ids.indexOf(id);
      if (lastIdx >= 0 && curIdx >= 0) {
        const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        const range = ids.slice(start, end + 1);
        setSelectedFilings(prev => {
          const next = new Set(prev);
          range.forEach(r => next.add(r));
          return next;
        });
      }
    } else {
      // Single click without modifier — navigate and highlight filing docs in tree
      handleFilingClick(filing);
      setSelectedFilings(new Set());
      lastSelectedFilingRef.current = id;
      // Dispatch event so the child page can highlight these documents in the file tree
      if (filing.documents.length > 0) {
        const filePaths = filing.documents.map(d => d.filePath);
        window.dispatchEvent(new CustomEvent('select-filing-documents', { detail: { filePaths, filingId: filing.id } }));
      }
    }
  };

  const handleDeleteSelectedFilings = async () => {
    if (!activeCase || selectedFilings.size === 0) return;
    for (const fId of selectedFilings) {
      await fetch(`/api/cases/${activeCase.id}/filings/${fId}`, { method: 'DELETE' });
    }
    setSelectedFilings(new Set());
    await loadFilings(activeCase.id);
    window.dispatchEvent(new Event('filings-changed'));
  };

  // Keyboard shortcut: Delete/Backspace to delete selected filings
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFilings.size > 0) {
        // Don't trigger if user is typing in an input
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        e.preventDefault();
        handleDeleteSelectedFilings();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedFilings, activeCase]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExhibitClick = (filing: FilingRecord, doc: DocumentRecord) => {
    if (!activeCaseNumber) return;
    router.push(`/case-management/${encodeURIComponent(activeCaseNumber)}/${encodeURIComponent(filing.slug)}/${encodeURIComponent(doc.exhibitLabel || doc.id)}`);
  };

  // Filter filings by category
  const filteredFilings = activeCategory === 'all'
    ? filings
    : filings.filter(f => {
        if (activeCategory === 'Other') {
          // "Others" catches everything not in the named categories
          const named = FILING_CATEGORIES.filter(c => c.key !== 'all' && c.key !== 'Other').map(c => c.key);
          return !named.includes(f.filingType);
        }
        return f.filingType === activeCategory;
      });

  // Count filings per category for badges
  const categoryCounts: Record<string, number> = { all: filings.length };
  const namedKeys = FILING_CATEGORIES.filter(c => c.key !== 'all' && c.key !== 'Other').map(c => c.key);
  for (const f of filings) {
    if (namedKeys.includes(f.filingType)) {
      categoryCounts[f.filingType] = (categoryCounts[f.filingType] || 0) + 1;
    } else {
      categoryCounts['Other'] = (categoryCounts['Other'] || 0) + 1;
    }
  }

  return (
    <div className="flex h-full">
      {/* Left panel: Case list + Filings sidebar */}
      <div style={{ width: sidebarWidth, minWidth: SIDEBAR_MIN, maxWidth: SIDEBAR_MAX }} className="border-r border-gray-200 bg-gray-50 flex flex-col flex-shrink-0 select-none">
        {/* Case selector header */}
        <div className="p-3 border-b border-gray-200">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Cases</h2>
            <button
              onClick={() => { setShowAddDialog(true); setAddError(''); setFolderPath(''); setCaseName(''); setCaseNumber(''); setJurisdiction(''); setCounty(''); setState(''); setCountry('United States'); }}
              className="p-1 text-gray-400 hover:text-blue-600 transition-colors" title="Add Case"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
          {/* Case list as compact items */}
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {cases.length === 0 ? (
              <p className="text-xs text-gray-400 py-2 text-center">No cases yet</p>
            ) : (
              cases.map(c => {
                const cn = c.caseNumber || c.id;
                const isActive = activeCaseNumber === cn;
                return (
                  <div key={c.id} className="flex items-center group">
                    <div
                      onClick={() => handleCaseClick(c)}
                      onContextMenu={(e) => handleCaseContextMenu(c, e)}
                      className={`flex-1 px-2 py-1.5 rounded text-sm cursor-pointer truncate transition-colors ${
                        isActive ? 'bg-blue-100 text-blue-800 font-medium' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                      title={`${c.name} - ${c.caseNumber || ''}`}
                    >
                      {c.name} {c.caseNumber ? `- ${c.caseNumber}` : ''}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteCase(c); }}
                      className="p-1 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                      title="Delete case"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Filing category tabs - only show when a case is selected */}
        {activeCase && (
          <>
            <div className="px-2 py-2 border-b border-gray-200 flex flex-wrap gap-1">
              {FILING_CATEGORIES.map(cat => {
                const count = categoryCounts[cat.key] || 0;
                const isActive = activeCategory === cat.key;
                return (
                  <button
                    key={cat.key}
                    onClick={() => setActiveCategory(cat.key)}
                    className={`px-2 py-1 text-xs rounded-full transition-colors ${
                      isActive
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {cat.label}{count > 0 ? ` (${count})` : ''}
                  </button>
                );
              })}
            </div>

            {/* Filings list with exhibit hierarchy */}
            <div className="flex-1 overflow-y-auto">
              {selectedFilings.size > 0 && (
                <div className="flex items-center justify-between px-3 py-1.5 bg-blue-50 border-b border-blue-100">
                  <span className="text-xs text-blue-700">{selectedFilings.size} selected</span>
                  <button onClick={handleDeleteSelectedFilings}
                    className="text-xs text-red-600 hover:text-red-800 font-medium">
                    Delete
                  </button>
                </div>
              )}
              {filteredFilings.length === 0 ? (
                <div className="p-4 text-center">
                  <p className="text-sm text-gray-400">
                    {filings.length === 0 ? 'No filings yet' : `No ${activeCategory === 'all' ? '' : activeCategory.toLowerCase() + ' '}filings`}
                  </p>
                  <p className="text-xs text-gray-300 mt-1">Parse documents to auto-create filings</p>
                </div>
              ) : (
                <div className="py-1">
                  {filteredFilings.map((filing, idx) => {
                    const isExpanded = expandedFilings.has(filing.id);
                    const isSelected = selectedFilings.has(filing.id);
                    const exhibits = filing.documents.filter(d => d.exhibitLabel);
                    const mainDocs = filing.documents.filter(d => !d.exhibitLabel);
                    const label = formatFilingLabel(filing);
                    const isCopied = copiedFilings.has(filing.id);
                    const rowBg = isSelected
                      ? 'bg-blue-100'
                      : idx % 2 === 0
                        ? 'bg-gray-50'
                        : 'bg-white';
                    return (
                      <div key={filing.id}>
                        {/* Filing row */}
                        <div className={`flex items-start gap-1 px-2 py-1.5 cursor-pointer group ${rowBg} hover:bg-gray-100`}
                          onClick={(e) => handleFilingSelect(filing, e)}
                          onContextMenu={(e) => handleFilingContextMenu(filing, e)}>
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleFiling(filing.id); }}
                            className="p-0.5 text-gray-400 hover:text-gray-600 mt-0.5"
                          >
                            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </button>
                          <div className="mt-0.5">
                            <FilingStatusIcon docs={filing.documents} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1">
                              <span
                                className="text-sm text-gray-800 truncate flex-1 hover:text-blue-600"
                                title={label}
                              >
                                {label}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigator.clipboard.writeText(label);
                                  setCopiedFilings(prev => {
                                    const next = new Set(prev);
                                    next.add(filing.id);
                                    return next;
                                  });
                                  setTimeout(() => {
                                    setCopiedFilings(prev => {
                                      const next = new Set(prev);
                                      next.delete(filing.id);
                                      return next;
                                    });
                                  }, 1500);
                                }}
                                className="p-0.5 text-gray-300 hover:text-blue-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                                title="Copy filing label"
                              >
                                {isCopied ? (
                                  <svg className="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                ) : (
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h4a2 2 0 002-2M8 5a2 2 0 012-2h4a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                                  </svg>
                                )}
                              </button>
                              <span className="text-xs text-gray-300 flex-shrink-0">{filing.documents.length}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteFiling(filing); }}
                                className="p-0.5 text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                                title="Delete filing"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full leading-tight inline-block ${getFilingTypeColor(filing.filingType).bg} ${getFilingTypeColor(filing.filingType).text}`}>{filing.filingType}</span>
                          </div>
                        </div>

                        {/* Expanded: documents + exhibits */}
                        {isExpanded && (
                          <div className="ml-6 border-l border-gray-200">
                            {mainDocs.map(doc => (
                              <div key={doc.id} className="flex items-center gap-2 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 cursor-grab active:cursor-grabbing"
                                draggable
                                onDragStart={(e) => {
                                  e.dataTransfer.setData('application/x-court-lens-doc-ids', JSON.stringify([doc.id]));
                                  e.dataTransfer.setData('application/x-court-lens-paths', JSON.stringify([doc.filePath]));
                                  e.dataTransfer.setData('text/plain', doc.fileName);
                                  e.dataTransfer.effectAllowed = 'move';
                                }}
                                onContextMenu={(e) => handleDocContextMenu(doc, e)}>
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                  doc.status === 'INDEXED' ? 'bg-green-500' :
                                  doc.status === 'PROCESSING' ? 'bg-yellow-400 animate-pulse' :
                                  doc.status === 'QUEUED' ? 'bg-yellow-300' :
                                  doc.status === 'ERROR' ? 'bg-red-500' : 'bg-gray-300'
                                }`} title={doc.status} />
                                <svg className="w-3 h-3 text-red-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                  <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                                </svg>
                                <span className="truncate">{doc.fileName}</span>
                              </div>
                            ))}
                            {exhibits.length > 0 && (
                              <div className="mt-0.5">
                                {exhibits.map(doc => (
                                  <div
                                    key={doc.id}
                                    draggable
                                    onDragStart={(e) => {
                                      e.dataTransfer.setData('application/x-court-lens-doc-ids', JSON.stringify([doc.id]));
                                      e.dataTransfer.setData('application/x-court-lens-paths', JSON.stringify([doc.filePath]));
                                      e.dataTransfer.setData('text/plain', doc.fileName);
                                      e.dataTransfer.effectAllowed = 'move';
                                    }}
                                    onClick={() => handleExhibitClick(filing, doc)}
                                    onContextMenu={(e) => handleDocContextMenu(doc, e)}
                                    className="flex items-center gap-2 px-3 py-1 text-xs hover:bg-blue-50 cursor-grab active:cursor-grabbing"
                                  >
                                    <span className="text-blue-600 font-medium flex-shrink-0">{doc.exhibitLabel}</span>
                                    <span className="text-gray-600 truncate">{doc.fileName}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {filing.documents.length === 0 && (
                              <p className="px-3 py-1 text-xs text-gray-300 italic">No documents</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* Show empty state when no case selected */}
        {!activeCase && cases.length > 0 && (
          <div className="flex-1 flex items-center justify-center p-4">
            <p className="text-sm text-gray-400 text-center">Select a case to view filings</p>
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="w-1 cursor-col-resize hover:bg-blue-400 active:bg-blue-500 transition-colors flex-shrink-0"
      />

      {/* Middle panel: children (case detail or empty state) */}
      <div className="flex-1 flex flex-col bg-white min-w-0">
        {children}
      </div>

      {/* Right panel: context-aware XETO/Haystack tags */}
      {(() => {
        // Selection: prefer explicit override from child page; otherwise
        // derive from URL — filing slug if present else active case.
        let kind: EntityKind | null = null;
        let id: string | null = null;
        let label: string | undefined = undefined;
        if (selectedOverride) {
          kind = selectedOverride.kind;
          id = selectedOverride.id;
          label = selectedOverride.label;
        } else if (activeCase) {
          const filingSlug = pathParts.length > 2 ? decodeURIComponent(pathParts[2]) : null;
          if (filingSlug) {
            const f = filings.find(x => x.slug === filingSlug);
            kind = 'motion';
            id = f ? f.id : filingSlug;
            label = f ? formatFilingLabel(f) : filingSlug;
          } else {
            kind = 'case';
            id = activeCase.id;
            label = `${activeCase.name}${activeCase.caseNumber ? ` — ${activeCase.caseNumber}` : ''}`;
          }
        }
        const handleRename = async (newTitle: string): Promise<void> => {
          if (!id || !kind) throw new Error('No entity selected');
          if (kind === 'case') {
            const res = await fetch(`/api/cases/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: newTitle }),
            });
            if (!res.ok) {
              const b = await res.json().catch(() => null) as { error?: string } | null;
              throw new Error(b?.error || `HTTP ${res.status}`);
            }
            await loadCases();
            return;
          }
          // Filing rename — kind is one of the per-type EntityKinds.
          if (!activeCase) throw new Error('No active case');
          const res = await fetch(
            `/api/cases/${encodeURIComponent(activeCase.id)}/filings/${encodeURIComponent(id)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: newTitle }),
            },
          );
          if (!res.ok) {
            const b = await res.json().catch(() => null) as { error?: string } | null;
            throw new Error(b?.error || `HTTP ${res.status}`);
          }
          const data = await res.json().catch(() => null) as { filing?: { slug?: string } } | null;
          await loadFilings(activeCase.id, true);
          // If the slug changed, route to the new URL so the page reloads
          // its filing data.
          const newSlug = data?.filing?.slug;
          const currentSlug = pathParts.length > 2 ? decodeURIComponent(pathParts[2]) : null;
          if (newSlug && currentSlug && newSlug !== currentSlug) {
            router.replace(`/case-management/${encodeURIComponent(pathParts[1])}/${encodeURIComponent(newSlug)}`);
          }
        };
        return <TagPanel entityKind={kind} entityId={id} entityLabel={label} onRename={handleRename} />;
      })()}

      {/* Sidebar Context Menu */}
      {sidebarContextMenu && (
        <ContextMenu
          x={sidebarContextMenu.x}
          y={sidebarContextMenu.y}
          items={getSidebarContextMenuItems()}
          onClose={() => setSidebarContextMenu(null)}
        />
      )}

      {/* Add Case Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => { setShowAddDialog(false); setShowFolderPicker(false); }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Court Case</h3>

            {/* Drop zone + folder path input */}
            <label className="block text-sm font-medium text-gray-700 mb-1">Folder Path</label>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`relative border-2 border-dashed rounded-lg p-3 mb-2 transition-colors ${
                dragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-300 bg-gray-50'
              }`}
            >
              {dragOver && (
                <div className="absolute inset-0 flex items-center justify-center bg-blue-50/80 rounded-lg z-10">
                  <span className="text-sm text-blue-600 font-medium">Drop folder here</span>
                </div>
              )}
              <div className="flex gap-2">
                <input type="text" value={folderPath} onChange={e => setFolderPath(e.target.value)}
                  placeholder="Paste path or drop a folder here"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white" autoFocus />
                <button onClick={openFolderPicker} type="button"
                  className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition-colors flex items-center gap-1.5 flex-shrink-0">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  Browse
                </button>
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">Drag & drop a folder from Finder, or click Browse to navigate</p>
            </div>

            {/* Inline folder picker */}
            {showFolderPicker && (
              <div className="border border-gray-200 rounded-lg mb-4 max-h-52 overflow-hidden flex flex-col">
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs">
                  {browseParent && (
                    <button onClick={() => browseTo(browseParent)} className="text-blue-600 hover:text-blue-800 flex-shrink-0">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                  )}
                  <span className="text-gray-600 truncate font-mono">{browseDir}</span>
                  <button onClick={() => selectBrowseFolder(browseDir)}
                    className="ml-auto px-2 py-0.5 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-700 flex-shrink-0">
                    Select This
                  </button>
                </div>
                <div className="overflow-y-auto flex-1">
                  {browseLoading ? (
                    <div className="p-3 text-xs text-gray-400 text-center">Loading...</div>
                  ) : browseFolders.length === 0 ? (
                    <div className="p-3 text-xs text-gray-400 text-center">No subfolders</div>
                  ) : (
                    browseFolders.map(f => (
                      <button key={f.path} onClick={() => browseTo(f.path)}
                        onDoubleClick={() => selectBrowseFolder(f.path)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-blue-50 transition-colors">
                        <svg className="w-4 h-4 text-yellow-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                        </svg>
                        <span className="text-gray-700 truncate">{f.name}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            <label className="block text-sm font-medium text-gray-700 mb-1">Case Name</label>
            <input type="text" value={caseName} onChange={e => setCaseName(e.target.value)}
              placeholder="e.g. Bill of Review"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4" />
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Number</label>
                <input type="text" value={caseNumber} onChange={e => setCaseNumber(e.target.value)}
                  placeholder="e.g. D-1-FM-25-000222"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Jurisdiction</label>
                <input type="text" value={jurisdiction} onChange={e => setJurisdiction(e.target.value)}
                  placeholder="e.g. D-1-FM"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
                <SearchableCombo value={country} onChange={setCountry} options={countryOptions} placeholder="Select country" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                <SearchableCombo value={state} onChange={setState} options={stateOptions} placeholder="Select state" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">County</label>
                <SearchableCombo value={county} onChange={setCounty} options={countyOptions}
                  placeholder={state ? 'Select county' : 'Select state first'} />
              </div>
            </div>
            {addError && <p className="text-sm text-red-600 mb-4">{addError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowAddDialog(false); setShowFolderPicker(false); }}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
              <button onClick={handleAddCase} disabled={!folderPath.trim() || addLoading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {addLoading ? 'Adding...' : 'Add Case'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Edit Filing Dialog */}
      {showEditFilingDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditFilingDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Edit Filing</h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">Filing Type</label>
            <select value={editFilingType} onChange={e => setEditFilingType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4">
              {FILING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
            <input type="text" value={editFilingTitle} onChange={e => setEditFilingTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && editFilingTitle.trim()) handleEditFilingSave(); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4" autoFocus />
            {(editFilingType === "Clerk's Record" || editFilingType === "Reporter's Record") && (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1">Volume Number</label>
                <input type="number" min="1" value={editFilingVolume} onChange={e => setEditFilingVolume(e.target.value)}
                  placeholder="e.g. 2"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3" />
                <div className="flex items-center gap-3 mb-3">
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editFilingSupplemental}
                      onChange={e => setEditFilingSupplemental(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    Supplemental Record
                  </label>
                  {editFilingSupplemental && (
                    <div className="flex items-center gap-1.5">
                      <label className="text-xs text-gray-500">Order:</label>
                      <input
                        type="number"
                        min="1"
                        value={editFilingSupplementalOrder}
                        onChange={e => setEditFilingSupplementalOrder(e.target.value)}
                        placeholder="1"
                        className="w-16 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEditFilingDialog(false)}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
              <button onClick={handleEditFilingSave} disabled={!editFilingTitle.trim() || editFilingLoading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {editFilingLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Case Dialog */}
      {showEditCaseDialog && editCaseRecord && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditCaseDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Edit Court Case</h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">Folder Path</label>
            <input type="text" value={editCasePath} onChange={e => setEditCasePath(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 font-mono text-xs" />
            <label className="block text-sm font-medium text-gray-700 mb-1">Case Name</label>
            <input type="text" value={editCaseName} onChange={e => setEditCaseName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && editCaseName.trim()) handleEditCaseSave(); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4" autoFocus />
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Case Number</label>
                <input type="text" value={editCaseNumber} onChange={e => setEditCaseNumber(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Jurisdiction</label>
                <input type="text" value={editCaseJurisdiction} onChange={e => setEditCaseJurisdiction(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
                <SearchableCombo value={editCaseCountry} onChange={setEditCaseCountry} options={countryOptions} placeholder="Select country" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                <SearchableCombo value={editCaseState} onChange={setEditCaseState} options={stateOptions} placeholder="Select state" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">County</label>
                <SearchableCombo value={editCaseCounty} onChange={setEditCaseCounty} options={countyOptions}
                  placeholder={editCaseState ? 'Select county' : 'Select state first'} />
              </div>
            </div>
            {editCaseError && <p className="text-sm text-red-600 mb-4">{editCaseError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEditCaseDialog(false)}
                className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">Cancel</button>
              <button onClick={handleEditCaseSave} disabled={!editCaseName.trim() || editCaseLoading}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {editCaseLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
