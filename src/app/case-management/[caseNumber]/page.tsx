'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { ContextMenu, type ContextMenuItem } from '@/components/context-menu';
import { getSharedDocumentMenuItems, type DocumentTarget, type DocumentContextMenuActions } from '@/components/document-context-menu';
import { getFiles, setFiles as idbSetFiles, getCachedFilings, setCachedFilings, getCachedTrackedFiles, setCachedTrackedFiles, setPreference, getPreference } from '@/lib/indexed-db';
import { persistActionLog } from '@/lib/action-log';

interface ActionLog {
  id: string;
  time: Date;
  action: string;
  file: string;
  status: 'pending' | 'success' | 'error' | 'cancelled';
  detail?: string;
}

interface CaseRecord {
  id: string;
  name: string;
  path: string;
  caseNumber: string | null;
  jurisdiction: string | null;
}

interface FilingRecord {
  id: string;
  filingType: string;
  title: string;
  slug: string;
}

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  children?: FileEntry[];
}

function escapeRegex(s: string): string {
  return s.split('').map(c => '.*+?^${}()|[]\\'.includes(c) ? '\\' + c : c).join('');
}
function globToRegex(pattern: string): RegExp {
  if (!pattern.includes('*')) return new RegExp(escapeRegex(pattern), 'i');
  return new RegExp(pattern.split('*').map(escapeRegex).join('.*'), 'i');
}
function filterTree(entries: FileEntry[], query: string): FileEntry[] {
  if (!query.trim()) return entries;
  const regex = globToRegex(query.trim());
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'file') {
      if (regex.test(entry.name) || regex.test(entry.path)) result.push(entry);
    } else if (entry.type === 'folder' && entry.children) {
      const kids = filterTree(entry.children, query);
      if (kids.length > 0) result.push({ ...entry, children: kids });
    }
  }
  return result;
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
  'Memorandum': { bg: 'bg-indigo-50', text: 'text-indigo-600' },
  'Stipulation': { bg: 'bg-emerald-50', text: 'text-emerald-600' },
  'Writ': { bg: 'bg-red-100', text: 'text-red-800' },
  'Summons': { bg: 'bg-amber-50', text: 'text-amber-600' },
  'Complaint': { bg: 'bg-rose-50', text: 'text-rose-600' },
  'Other': { bg: 'bg-gray-100', text: 'text-gray-600' },
};

function getFilingTypeColor(filingType: string) {
  return FILING_TYPE_COLORS[filingType] || FILING_TYPE_COLORS['Other'];
}

/** Status dot color: green=indexed, yellow=processing/queued, red=error */
function getStatusDotColor(status: string): string {
  switch (status) {
    case 'INDEXED': return 'bg-green-500';
    case 'PROCESSING': return 'bg-yellow-400 animate-pulse';
    case 'QUEUED': return 'bg-yellow-300';
    case 'ERROR': return 'bg-red-500';
    default: return 'bg-gray-300';
  }
}

type StatusFilter = 'all' | 'active' | 'INDEXED' | 'QUEUED' | 'PROCESSING' | 'ERROR';

export default function CaseDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const caseNumberParam = decodeURIComponent(params.caseNumber as string);
  const selectedDocId = searchParams.get('doc');

  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [trackedFiles, setTrackedFiles] = useState<Record<string, { status: string; fileName: string; documentId: string; filingId?: string; filingSlug?: string; filingTitle?: string }>>({});
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [filesLoading, setFilesLoading] = useState(false);
  const [parseLoading, setParseLoading] = useState(false);
  const [refreshFolderLoading, setRefreshFolderLoading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const lastClickedRef = useRef<string | null>(null);
  const flatFilesRef = useRef<string[]>([]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; filePath: string } | null>(null);

  // Dialog state
  const [showFilingDialog, setShowFilingDialog] = useState(false);
  const [showExhibitDialog, setShowExhibitDialog] = useState(false);
  const [dialogFilePath, setDialogFilePath] = useState('');
  const [filings, setFilings] = useState<FilingRecord[]>([]);
  const [selectedFilingId, setSelectedFilingId] = useState('');
  const [newFilingType, setNewFilingType] = useState('Motion');
  const [newFilingTitle, setNewFilingTitle] = useState('');
  const [newVolumeNumber, setNewVolumeNumber] = useState('');
  const [newFilingSupplemental, setNewFilingSupplemental] = useState(false);
  const [newFilingSupplementalOrder, setNewFilingSupplementalOrder] = useState('');
  const [exhibitLabel, setExhibitLabel] = useState('');
  const [dialogLoading, setDialogLoading] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [createNewFiling, setCreateNewFiling] = useState(false);

  // Rename dialog state
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameDocId, setRenameDocId] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);

  // Filing detection state
  const [detectingFiling, setDetectingFiling] = useState(false);
  const [detectionSource, setDetectionSource] = useState<string>('');
  const [detectionConfidence, setDetectionConfidence] = useState<number>(0);

  // Auto-add filings toggle (persisted per case via API + localStorage fallback)
  const [autoAddFilings, setAutoAddFilings] = useState(false);
  const [filingQueueProcessing, setFilingQueueProcessing] = useState(false);

  // Action log state
  const [actionLogs, setActionLogs] = useState<ActionLog[]>([]);
  const [logPanelOpen, setLogPanelOpen] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const addLog = useCallback((action: string, file: string): string => {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    abortControllersRef.current.set(id, controller);
    setActionLogs(prev => [...prev, { id, time: new Date(), action, file, status: 'pending' }]);
    return id;
  }, []);

  const updateLog = useCallback((id: string, status: 'success' | 'error', detail?: string) => {
    abortControllersRef.current.delete(id);
    setActionLogs(prev => {
      const log = prev.find(l => l.id === id);
      if (log && caseRecord) {
        persistActionLog({
          caseId: caseRecord.id,
          action: log.action,
          target: log.file,
          status,
          detail,
          logType: status === 'error' ? 'error' : 'general',
        });
      }
      return prev.map(l => l.id === id ? { ...l, status, detail } : l);
    });
  }, [caseRecord]);

  const cancelLog = useCallback((id: string) => {
    const controller = abortControllersRef.current.get(id);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(id);
    }
    setActionLogs(prev => {
      const log = prev.find(l => l.id === id && l.status === 'pending');
      if (log && caseRecord) {
        persistActionLog({
          caseId: caseRecord.id,
          action: log.action,
          target: log.file,
          status: 'cancelled',
          detail: 'Cancelled',
        });
      }
      return prev.map(l => l.id === id && l.status === 'pending' ? { ...l, status: 'cancelled', detail: 'Cancelled' } : l);
    });
  }, [caseRecord]);

  /** Get the AbortSignal for a log entry (pass to fetch calls) */
  const getLogSignal = useCallback((id: string): AbortSignal | undefined => {
    return abortControllersRef.current.get(id)?.signal;
  }, []);

  // Load persisted action logs for this case on mount
  useEffect(() => {
    if (!caseRecord) return;
    fetch(`/api/admin/action-logs?caseId=${caseRecord.id}&limit=50`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.logs?.length) {
          const historic: ActionLog[] = data.logs.reverse().map((l: any) => ({
            id: l.id,
            time: new Date(l.createdAt),
            action: l.action,
            file: l.target,
            status: l.status as ActionLog['status'],
            detail: l.detail || undefined,
          }));
          setActionLogs(prev => {
            // Merge: historic first, then any current session logs
            const currentIds = new Set(prev.map(p => p.id));
            const merged = historic.filter(h => !currentIds.has(h.id));
            return [...merged, ...prev];
          });
        }
      })
      .catch(() => { /* silent */ });
  }, [caseRecord]);

  // Auto-scroll log panel
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [actionLogs]);

  // Web Worker ref for SSE sync
  const workerRef = useRef<Worker | null>(null);

  // Lightweight status poll — fallback when SSE is not available
  // Also serves as a reconciliation mechanism
  useEffect(() => {
    if (!caseRecord) return;

    // Start Web Worker for SSE sync
    try {
      const worker = new Worker('/workers/file-sync-worker.js');
      workerRef.current = worker;

      worker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
          case 'connected':
            // SSE connected, we can reduce polling frequency
            break;
          case 'delta':
            // File system changes detected — refresh files from API
            // (The worker already updated IndexedDB)
            loadFiles(caseRecord.id);
            // Auto-add filings for new PDFs if enabled
            if (autoAddFilings && msg.added && msg.added.length > 0) {
              const newPdfs = msg.added
                .filter((f: { name: string; path: string }) => f.name.toLowerCase().endsWith('.pdf'))
                .map((f: { path: string }) => f.path);
              if (newPdfs.length > 0) {
                autoCreateFilings(newPdfs);
              }
            }
            break;
          case 'doc_status':
            // Document status change from parsing worker
            if (msg.documentId) {
              setTrackedFiles(prev => {
                const updated = { ...prev };
                for (const [fp, info] of Object.entries(updated)) {
                  if ((info as { documentId: string }).documentId === msg.documentId) {
                    updated[fp] = { ...(info as { status: string; fileName: string; documentId: string }), status: msg.status };
                    break;
                  }
                }
                return updated;
              });
            }
            break;
          case 'filings_changed':
            // Background filing queue completed — refresh sidebar and files
            window.dispatchEvent(new Event('filings-changed'));
            loadFiles(caseRecord.id);
            break;
          case 'filing_created':
          case 'filing_updated':
          case 'filing_deleted':
            // Real-time filing change from Redis pub/sub — refresh left sidebar
            window.dispatchEvent(new Event('filings-changed'));
            break;
          case 'document_added':
            // New document was added to this case — refresh file list
            loadFiles(caseRecord.id);
            window.dispatchEvent(new Event('filings-changed'));
            break;
          case 'document_status_changed':
            // Document parse status changed — update tracked files inline
            if (msg.documentId) {
              setTrackedFiles(prev => {
                const updated = { ...prev };
                for (const [fp, info] of Object.entries(updated)) {
                  if ((info as { documentId: string }).documentId === msg.documentId) {
                    updated[fp] = { ...(info as { status: string; fileName: string; documentId: string }), status: msg.status };
                    break;
                  }
                }
                return updated;
              });
            }
            break;
          case 'error':
            // SSE error, polling will handle updates
            break;
        }
      };

      worker.postMessage({
        type: 'connect',
        caseId: caseRecord.id,
        apiBase: window.location.origin,
      });
    } catch {
      // Web Worker not supported, fall back to polling only
    }

    // Fallback polling (less frequent when SSE is active)
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/cases/${caseRecord.id}/files?fresh=1`);
        if (res.ok) {
          const data = await res.json();
          if (data.files) setFiles(data.files);
          setTrackedFiles(data.trackedFiles || {});
        }
      } catch { /* silent */ }
    }, 5000);

    return () => {
      clearInterval(interval);
      if (workerRef.current) {
        workerRef.current.postMessage({ type: 'disconnect' });
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [caseRecord]);

  // Load case by caseNumber
  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    fetch(`/api/cases?caseNumber=${encodeURIComponent(caseNumberParam)}`)
      .then(res => { if (!res.ok) { setNotFound(true); setLoading(false); return null; } return res.json(); })
      .then(data => {
        if (data?.case) setCaseRecord(data.case);
        else setNotFound(true);
        setLoading(false);
      })
      .catch(() => { setNotFound(true); setLoading(false); });
  }, [caseNumberParam]);

  useEffect(() => { if (caseRecord) loadFiles(caseRecord.id); }, [caseRecord]);

  // Load auto-add preference from API (with localStorage fallback)
  useEffect(() => {
    if (!caseRecord) return;
    // Try API first
    fetch(`/api/cases/${caseRecord.id}/auto-filing`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setAutoAddFilings(data.enabled);
          localStorage.setItem(`autoAddFilings:${caseRecord.id}`, String(data.enabled));
        } else {
          // Fallback to localStorage
          const stored = localStorage.getItem(`autoAddFilings:${caseRecord.id}`);
          if (stored === 'true') setAutoAddFilings(true);
        }
      })
      .catch(() => {
        const stored = localStorage.getItem(`autoAddFilings:${caseRecord.id}`);
        if (stored === 'true') setAutoAddFilings(true);
      });
  }, [caseRecord]);

  const toggleAutoAddFilings = () => {
    setAutoAddFilings(prev => {
      const next = !prev;
      if (caseRecord) {
        localStorage.setItem(`autoAddFilings:${caseRecord.id}`, String(next));
        // Persist to API in background
        fetch(`/api/cases/${caseRecord.id}/auto-filing`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        }).catch(() => {});
      }
      return next;
    });
  };

  const autoCreateFilings = async (filePaths: string[]) => {
    if (!caseRecord || filePaths.length === 0) return;
    const logId = addLog('Auto Filing', `Queuing ${filePaths.length} new PDF(s)`);

    try {
      const res = await fetch(`/api/cases/${caseRecord.id}/filing-queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        updateLog(logId, 'error', data.error || 'Failed to queue');
        return;
      }
      updateLog(logId, 'success', `${filePaths.length} file(s) queued`);
      setFilingQueueProcessing(true);
      // Start polling for progress
      if (!filingQueuePollRef.current) {
        filingQueuePollRef.current = setInterval(pollFilingQueue, 1500);
      }
    } catch {
      updateLog(logId, 'error', 'Network error');
    }
  };

  // Sync initial selection from URL ?doc= param (only on first load / URL change, not on trackedFiles changes)
  const initialDocSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedDocId && selectedDocId !== initialDocSyncedRef.current) {
      initialDocSyncedRef.current = selectedDocId;
      setSelectedFiles(new Set([selectedDocId]));
    }
  }, [selectedDocId]);

  // Listen for filing click from sidebar to highlight its documents in the tree
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { filePaths: string[]; filingId: string } | undefined;
      if (detail?.filePaths?.length) {
        setSelectedFiles(new Set(detail.filePaths));
        // Expand parent folders so highlighted files are visible
        setExpandedFolders(prev => {
          const next = new Set(prev);
          for (const fp of detail.filePaths) {
            // Add all parent directory segments
            const parts = fp.split('/');
            for (let i = 1; i < parts.length; i++) {
              next.add(parts.slice(0, i).join('/'));
            }
          }
          return next;
        });
      }
    };
    window.addEventListener('select-filing-documents', handler);
    return () => window.removeEventListener('select-filing-documents', handler);
  }, []);

  const loadFiles = async (caseId: string) => {
    setFilesLoading(true);
    try {
      // Try IndexedDB first for instant load
      try {
        const cached = await getFiles(caseId);
        if (cached && cached.length > 0) {
          setFiles(cached as FileEntry[]);
          setFilesLoading(false);
          // Also restore cached trackedFiles for instant status display
          getCachedTrackedFiles(caseId).then(ct => {
            if (ct?.data) setTrackedFiles(ct.data);
          }).catch(() => {});
          // Still fetch from API in background for fresh data
          fetch(`/api/cases/${caseId}/files`)
            .then(res => res.ok ? res.json() : null)
            .then(data => {
              if (data) {
                setFiles(data.files);
                setTrackedFiles(data.trackedFiles || {});
                idbSetFiles(caseId, data.files).catch(() => {});
                setCachedTrackedFiles(caseId, data.trackedFiles || {}).catch(() => {});
              }
            })
            .catch(() => {});
          // Expand folders from cached data
          setExpandedFolders(prev => {
            if (prev.size > 0) return prev;
            const allFolders = new Set<string>();
            const collectFolders = (entries: FileEntry[]) => {
              for (const e of entries) {
                if (e.type === 'folder') { allFolders.add(e.path); if (e.children) collectFolders(e.children); }
              }
            };
            collectFolders(cached as FileEntry[]);
            return allFolders;
          });
          return;
        }
      } catch { /* IndexedDB not available, fall through to API */ }

      // Fetch from API
      const res = await fetch(`/api/cases/${caseId}/files`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files);
        setTrackedFiles(data.trackedFiles || {});
        // Cache all to IndexedDB for next load
        idbSetFiles(caseId, data.files).catch(() => {});
        setCachedTrackedFiles(caseId, data.trackedFiles || {}).catch(() => {});
        setExpandedFolders(prev => {
          if (prev.size > 0) return prev;
          const allFolders = new Set<string>();
          const collectFolders = (entries: FileEntry[]) => {
            for (const e of entries) {
              if (e.type === 'folder') { allFolders.add(e.path); if (e.children) collectFolders(e.children); }
            }
          };
          collectFolders(data.files);
          return allFolders;
        });
      }
    } finally { setFilesLoading(false); }
  };

  const loadFilings = async (skipCache = false) => {
    if (!caseRecord) return;
    // Try IndexedDB cache first for instant render (skip when explicitly refreshing)
    if (!skipCache) {
      try {
        const cached = await getCachedFilings(caseRecord.id);
        if (cached?.data && cached.data.length > 0) {
          setFilings(cached.data as FilingRecord[]);
          if (!cached.isStale) return;
        }
      } catch {}
    }
    const res = await fetch(`/api/cases/${caseRecord.id}/filings`);
    if (res.ok) {
      const data = await res.json();
      setFilings(data.filings || []);
      setCachedFilings(caseRecord.id, data.filings || []).catch(() => {});
    }
  };

  const buildFlatFiles = useCallback((entries: FileEntry[]): string[] => {
    const result: string[] = [];
    for (const e of entries) {
      if (e.type === 'file') result.push(e.path);
      else if (e.type === 'folder' && e.children && expandedFolders.has(e.path))
        result.push(...buildFlatFiles(e.children));
    }
    return result;
  }, [expandedFolders]);

  const filteredFiles = useMemo(() => filterTree(files, searchQuery), [files, searchQuery]);

  // Compute status counts from tracked files
  const statusCounts = useMemo(() => {
    const counts = { total: 0, indexed: 0, queued: 0, processing: 0, error: 0 };
    for (const info of Object.values(trackedFiles)) {
      counts.total++;
      switch (info.status) {
        case 'INDEXED': counts.indexed++; break;
        case 'QUEUED': counts.queued++; break;
        case 'PROCESSING': counts.processing++; break;
        case 'ERROR': counts.error++; break;
      }
    }
    return counts;
  }, [trackedFiles]);

  // Apply status filter to the file tree
  const statusFilteredFiles = useMemo(() => {
    if (statusFilter === 'all') return filteredFiles;
    if (statusFilter === 'active') {
      // "Active" = files that have any tracked status (not untracked)
      const filterByStatus = (entries: FileEntry[]): FileEntry[] => {
        const result: FileEntry[] = [];
        for (const entry of entries) {
          if (entry.type === 'file') {
            if (trackedFiles[entry.path]) result.push(entry);
          } else if (entry.type === 'folder' && entry.children) {
            const kids = filterByStatus(entry.children);
            if (kids.length > 0) result.push({ ...entry, children: kids });
          }
        }
        return result;
      };
      return filterByStatus(filteredFiles);
    }
    // Filter by specific status
    const filterByStatus = (entries: FileEntry[]): FileEntry[] => {
      const result: FileEntry[] = [];
      for (const entry of entries) {
        if (entry.type === 'file') {
          const tracked = trackedFiles[entry.path];
          if (tracked && tracked.status === statusFilter) result.push(entry);
        } else if (entry.type === 'folder' && entry.children) {
          const kids = filterByStatus(entry.children);
          if (kids.length > 0) result.push({ ...entry, children: kids });
        }
      }
      return result;
    };
    return filterByStatus(filteredFiles);
  }, [filteredFiles, statusFilter, trackedFiles]);

  useEffect(() => { flatFilesRef.current = buildFlatFiles(statusFilteredFiles); }, [statusFilteredFiles, expandedFolders, buildFlatFiles]);

  const handleFileClick = (filePath: string, e: React.MouseEvent) => {
    let isMultiSelect = false;
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (e.shiftKey && lastClickedRef.current) {
        isMultiSelect = true;
        const flat = flatFilesRef.current;
        const si = flat.indexOf(lastClickedRef.current), ei = flat.indexOf(filePath);
        if (si !== -1 && ei !== -1) {
          const [lo, hi] = si < ei ? [si, ei] : [ei, si];
          const range = flat.slice(lo, hi + 1);
          // If all in range are already selected, deselect them; otherwise select all
          const allSelected = range.every(f => next.has(f));
          for (const f of range) {
            if (allSelected) next.delete(f); else next.add(f);
          }
        }
      } else if (e.metaKey || e.ctrlKey) {
        isMultiSelect = true;
        if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
      } else {
        // Plain click: toggle if already the only selected item, otherwise select just this
        if (next.size === 1 && next.has(filePath)) {
          next.clear();
        } else {
          next.clear();
          next.add(filePath);
        }
      }
      lastClickedRef.current = filePath;
      return next;
    });
    // Only update URL for single-click (not shift/ctrl multi-select) to avoid resetting selection
    if (!isMultiSelect) {
      const np = new URLSearchParams(searchParams.toString());
      np.set('doc', filePath);
      initialDocSyncedRef.current = filePath; // prevent the sync effect from re-triggering
      router.replace(`/case-management/${encodeURIComponent(caseNumberParam)}?${np.toString()}`, { scroll: false });
    }
  };

  const handleContextMenu = (filePath: string, e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, filePath });
  };

  // Context menu actions
  const handleRunParser = async (filePath: string) => {
    if (!caseRecord) return;

    // If the right-clicked file is part of a multi-selection, parse all selected
    const filesToParse = selectedFiles.size > 1 && selectedFiles.has(filePath)
      ? Array.from(selectedFiles)
      : [filePath];

    const label = filesToParse.length === 1
      ? (filesToParse[0].split('/').pop() || filesToParse[0])
      : `${filesToParse.length} file(s)`;
    const logId = addLog('Run Parser', label);

    // Optimistic: mark as QUEUED
    setTrackedFiles(prev => {
      const next = { ...prev };
      for (const fp of filesToParse) {
        if (next[fp]) next[fp] = { ...next[fp], status: 'QUEUED' };
      }
      return next;
    });
    setParseLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseRecord.id}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: filesToParse }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.results) {
          setTrackedFiles(prev => {
            const next = { ...prev };
            for (const r of data.results) {
              if (r.documentId && r.filePath) {
                next[r.filePath] = { status: 'QUEUED', fileName: r.filePath.split('/').pop() || r.filePath, documentId: r.documentId };
              }
            }
            return next;
          });
        }
        updateLog(logId, 'success');
        window.dispatchEvent(new Event('filings-changed'));
      } else {
        updateLog(logId, 'error', 'API error');
      }
    } catch {
      updateLog(logId, 'error', 'Network error');
    } finally { setParseLoading(false); }
  };

  const openFilingDialog = async (filePath: string) => {
    setDialogFilePath(filePath);
    setDialogError('');
    setSelectedFilingId('');
    setCreateNewFiling(true); // Default to creating new filing
    setNewFilingType(''); // Empty until detection completes
    setNewFilingTitle('');
    setNewVolumeNumber('');
    setNewFilingSupplemental(false);
    setNewFilingSupplementalOrder('');
    setDetectionSource('');
    setDetectionConfidence(0);
    await loadFilings();
    setShowFilingDialog(true);

    // Auto-detect filing type and title from first 5 pages
    if (caseRecord) {
      setDetectingFiling(true);
      try {
        const res = await fetch(`/api/cases/${caseRecord.id}/detect-filing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.detection) {
            setNewFilingType(data.detection.filingType);
            setNewFilingTitle(data.detection.title);
            setDetectionSource(data.detection.source || '');
            setDetectionConfidence(data.detection.confidence || 0);
          } else {
            // No detection result -- fall back to Motion
            setNewFilingType('Motion');
          }
        } else {
          console.warn('Filing detection API error:', res.status);
          setNewFilingType('Motion');
        }
      } catch (err) {
        console.warn('Filing detection failed:', err);
        setNewFilingType('Motion');
      } finally { setDetectingFiling(false); }
    } else {
      setNewFilingType('Motion');
    }
  };

  const openExhibitDialog = async (filePath: string) => {
    setDialogFilePath(filePath);
    setDialogError('');
    setSelectedFilingId('');
    setExhibitLabel('');
    await loadFilings();
    setShowExhibitDialog(true);
  };

  const handleAddToFiling = async () => {
    if (!caseRecord) return;
    setDialogLoading(true);
    setDialogError('');
    const fileName = dialogFilePath.split('/').pop() || dialogFilePath;
    const logId = addLog('Add to Filing', fileName);
    try {
      let filingId = selectedFilingId;

      if (createNewFiling) {
        if (!newFilingTitle.trim()) { setDialogError('Title is required'); setDialogLoading(false); updateLog(logId, 'error', 'Title required'); return; }
        const res = await fetch(`/api/cases/${caseRecord.id}/filings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filingType: newFilingType,
            title: newFilingTitle.trim(),
            volumeNumber: newVolumeNumber.trim() ? parseInt(newVolumeNumber, 10) : null,
            isSupplemental: newFilingSupplemental,
            supplementalOrder: newFilingSupplemental && newFilingSupplementalOrder.trim()
              ? parseInt(newFilingSupplementalOrder, 10)
              : null,
          }),
        });
        if (!res.ok) { const d = await res.json(); setDialogError(d.error || 'Failed'); setDialogLoading(false); updateLog(logId, 'error', d.error); return; }
        const data = await res.json();
        filingId = data.filing.id;
      }

      if (!filingId) { setDialogError('Select a filing or create a new one'); setDialogLoading(false); updateLog(logId, 'error', 'No filing selected'); return; }

      // Pass filingId to parse endpoint so it doesn't auto-create a duplicate filing
      const parseRes = await fetch(`/api/cases/${caseRecord.id}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: [dialogFilePath], filingId }),
      });
      if (parseRes.ok) {
        const parseData = await parseRes.json();
        const docResult = parseData.results?.[0];
        if (docResult?.documentId) {
          // Optimistic: add to trackedFiles
          setTrackedFiles(prev => ({
            ...prev,
            [dialogFilePath]: { status: 'QUEUED', fileName, documentId: docResult.documentId },
          }));
        } else {
          setDialogError('Failed to create document record');
          setDialogLoading(false);
          updateLog(logId, 'error', 'No document created');
          return;
        }
      } else {
        setDialogError('Failed to parse file');
        setDialogLoading(false);
        updateLog(logId, 'error', 'Parse failed');
        return;
      }

      setShowFilingDialog(false);
      await loadFilings(true);
      updateLog(logId, 'success');
      window.dispatchEvent(new Event('filings-changed'));
    } catch { setDialogError('Network error'); updateLog(logId, 'error', 'Network error'); }
    finally { setDialogLoading(false); }
  };

  const handleAddAsExhibit = async () => {
    if (!caseRecord || !selectedFilingId) { setDialogError('Select a filing'); return; }
    setDialogLoading(true);
    setDialogError('');
    const fileName = dialogFilePath.split('/').pop() || dialogFilePath;
    const logId = addLog('Add as Exhibit', fileName);
    try {
      const parseRes = await fetch(`/api/cases/${caseRecord.id}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: [dialogFilePath] }),
      });
      if (parseRes.ok) {
        const parseData = await parseRes.json();
        const docResult = parseData.results?.[0];
        if (docResult?.documentId) {
          // Optimistic
          setTrackedFiles(prev => ({
            ...prev,
            [dialogFilePath]: { status: 'QUEUED', fileName, documentId: docResult.documentId },
          }));
          const res = await fetch(`/api/documents/${docResult.documentId}/exhibit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filingId: selectedFilingId, exhibitLabel: exhibitLabel.trim() || undefined }),
          });
          if (!res.ok) { const d = await res.json(); setDialogError(d.error || 'Failed'); setDialogLoading(false); updateLog(logId, 'error', d.error); return; }
        }
      }
      setShowExhibitDialog(false);
      updateLog(logId, 'success');
      window.dispatchEvent(new Event('filings-changed'));
    } catch { setDialogError('Network error'); updateLog(logId, 'error', 'Network error'); }
    finally { setDialogLoading(false); }
  };

  const handleDeleteDocument = async (filePath: string) => {
    const tracked = trackedFiles[filePath];
    if (!tracked || !caseRecord) return;
    if (!confirm(`Delete "${tracked.fileName}" from the database?`)) return;
    const logId = addLog('Delete', tracked.fileName);
    // Optimistic: remove from trackedFiles
    setTrackedFiles(prev => {
      const next = { ...prev };
      delete next[filePath];
      return next;
    });
    try {
      const res = await fetch(`/api/documents/${tracked.documentId}`, { method: 'DELETE' });
      if (res.ok) {
        updateLog(logId, 'success');
      } else {
        // Revert on failure
        setTrackedFiles(prev => ({ ...prev, [filePath]: tracked }));
        updateLog(logId, 'error', 'API error');
      }
    } catch {
      setTrackedFiles(prev => ({ ...prev, [filePath]: tracked }));
      updateLog(logId, 'error', 'Network error');
    }
  };

  const handleRename = async () => {
    if (!renameDocId || !renameValue.trim() || !caseRecord) return;
    setRenameLoading(true);
    const logId = addLog('Rename', renameValue.trim());
    // Find the filePath for this docId to do optimistic update
    const filePath = Object.keys(trackedFiles).find(fp => trackedFiles[fp].documentId === renameDocId);
    const oldName = filePath ? trackedFiles[filePath].fileName : '';
    // Optimistic update
    if (filePath) {
      setTrackedFiles(prev => ({
        ...prev,
        [filePath]: { ...prev[filePath], fileName: renameValue.trim() },
      }));
    }
    try {
      const res = await fetch(`/api/documents/${renameDocId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: renameValue.trim() }),
      });
      if (res.ok) {
        setShowRenameDialog(false);
        updateLog(logId, 'success');
      } else {
        // Revert
        if (filePath) setTrackedFiles(prev => ({ ...prev, [filePath]: { ...prev[filePath], fileName: oldName } }));
        updateLog(logId, 'error', 'API error');
      }
    } catch {
      if (filePath) setTrackedFiles(prev => ({ ...prev, [filePath]: { ...prev[filePath], fileName: oldName } }));
      updateLog(logId, 'error', 'Network error');
    } finally { setRenameLoading(false); }
  };

  const handleSelectAll = () => setSelectedFiles(new Set(flatFilesRef.current));

  /**
   * Rescan the case folder — invalidates the folder cache + restarts the
   * FileWatcher so renames/moves are picked up without restarting the master.
   * After completion, reload the file tree so the UI reflects the new layout.
   */
  const handleRefreshFolder = async () => {
    if (!caseRecord) return;
    const logId = addLog('Refresh folder', caseRecord.path);
    setRefreshFolderLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseRecord.id}/rescan`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        updateLog(logId, 'error', data?.error || `HTTP ${res.status}`);
        return;
      }
      const parts: string[] = [];
      if (typeof data.scannedFiles === 'number') parts.push(`${data.scannedFiles} files`);
      if (typeof data.relocated === 'number' && data.relocated > 0) parts.push(`${data.relocated} relocated`);
      if (typeof data.markedMissing === 'number' && data.markedMissing > 0) parts.push(`${data.markedMissing} marked missing`);
      if (data.restartedWatcher) parts.push('watcher restarted');
      updateLog(logId, 'success', parts.join(' · ') || 'ok');
      // Refetch the file tree so the UI shows the renamed folders.
      try {
        await loadFiles(caseRecord.id);
      } catch { /* tree refresh best-effort */ }
    } catch (err) {
      updateLog(logId, 'error', (err as Error).message);
    } finally {
      setRefreshFolderLoading(false);
    }
  };

  // Filing queue polling
  const filingQueuePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollFilingQueue = useCallback(async () => {
    if (!caseRecord) return;
    try {
      const res = await fetch(`/api/cases/${caseRecord.id}/filing-queue`);
      if (!res.ok) return;
      const state = await res.json();

      if (state.status === 'processing') {
        setFilingQueueProcessing(true);
        setActionLogs(prev => {
          const existing = prev.find(l => l.action === 'Filing Queue' && l.status === 'pending');
          if (existing) {
            return prev.map(l => l.id === existing.id
              ? { ...l, file: `${state.processed}/${state.total} — ${state.currentFile}` }
              : l);
          }
          return prev;
        });
      } else if (state.status === 'done' || state.status === 'cancelled') {
        setFilingQueueProcessing(false);
        // Update the log entry
        setActionLogs(prev => prev.map(l =>
          l.action === 'Filing Queue' && l.status === 'pending'
            ? { ...l, status: state.failed > 0 ? 'error' : 'success',
                detail: `${state.created}/${state.total} created${state.failed > 0 ? `, ${state.failed} failed` : ''}${state.status === 'cancelled' ? ' (cancelled)' : ''}` }
            : l
        ));
        window.dispatchEvent(new Event('filings-changed'));
        if (caseRecord) loadFiles(caseRecord.id);
        // Stop polling
        if (filingQueuePollRef.current) {
          clearInterval(filingQueuePollRef.current);
          filingQueuePollRef.current = null;
        }
      }
    } catch { /* silent */ }
  }, [caseRecord]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check for in-progress queue on mount
  useEffect(() => {
    if (!caseRecord) return;
    fetch(`/api/cases/${caseRecord.id}/filing-queue`)
      .then(r => r.ok ? r.json() : null)
      .then(state => {
        if (state?.status === 'processing') {
          setFilingQueueProcessing(true);
          const logId = addLog('Filing Queue', `${state.processed}/${state.total} — ${state.currentFile}`);
          // Start polling
          filingQueuePollRef.current = setInterval(pollFilingQueue, 1500);
        }
      })
      .catch(() => {});
    return () => {
      if (filingQueuePollRef.current) clearInterval(filingQueuePollRef.current);
    };
  }, [caseRecord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAddToFilingQueue = async () => {
    if (!caseRecord || selectedFiles.size === 0) return;
    setFilingQueueProcessing(true);
    const filePaths = Array.from(selectedFiles);
    const logId = addLog('Filing Queue', `0/${filePaths.length} file(s)`);

    try {
      const res = await fetch(`/api/cases/${caseRecord.id}/filing-queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths }),
      });
      if (!res.ok) {
        const data = await res.json();
        updateLog(logId, 'error', data.error || 'Failed to start queue');
        setFilingQueueProcessing(false);
        return;
      }
      // Start polling for progress
      filingQueuePollRef.current = setInterval(pollFilingQueue, 1500);
    } catch {
      updateLog(logId, 'error', 'Network error');
      setFilingQueueProcessing(false);
    }
  };

  const handleCancelFilingQueue = async () => {
    if (!caseRecord) return;
    try {
      await fetch(`/api/cases/${caseRecord.id}/filing-queue`, { method: 'DELETE' });
    } catch { /* silent */ }
  };
  const handleDeselectAll = () => {
    setSelectedFiles(new Set());
    router.replace(`/case-management/${encodeURIComponent(caseNumberParam)}`, { scroll: false });
  };
  const toggleFolder = (fp: string) => {
    setExpandedFolders(prev => { const n = new Set(prev); if (n.has(fp)) n.delete(fp); else n.add(fp); return n; });
  };
  const handleParseSelected = async () => {
    if (!caseRecord || selectedFiles.size === 0) return;
    setParseLoading(true);
    const filePaths = Array.from(selectedFiles);
    const logId = addLog('Parse Selected', `${filePaths.length} file(s)`);
    // Optimistic: mark all selected as QUEUED
    setTrackedFiles(prev => {
      const next = { ...prev };
      for (const fp of filePaths) {
        if (next[fp]) next[fp] = { ...next[fp], status: 'QUEUED' };
      }
      return next;
    });
    try {
      const res = await fetch(`/api/cases/${caseRecord.id}/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths }),
      });
      if (res.ok) {
        const data = await res.json();
        // Update trackedFiles with actual response data
        if (data.results) {
          setTrackedFiles(prev => {
            const next = { ...prev };
            for (const r of data.results) {
              if (r.documentId && r.filePath) {
                next[r.filePath] = { status: 'QUEUED', fileName: r.filePath.split('/').pop() || r.filePath, documentId: r.documentId };
              }
            }
            return next;
          });
        }
        updateLog(logId, 'success');
        // Parse creates filings — notify sidebar
        window.dispatchEvent(new Event('filings-changed'));
      } else {
        updateLog(logId, 'error', 'API error');
      }
    } catch {
      updateLog(logId, 'error', 'Network error');
    } finally { setParseLoading(false); }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };
  const getStatusBadge = (status: string) => {
    const c: Record<string, string> = { QUEUED: 'bg-gray-200 text-gray-700', PROCESSING: 'bg-yellow-100 text-yellow-800', INDEXED: 'bg-green-100 text-green-800', ERROR: 'bg-red-100 text-red-800' };
    return c[status] || 'bg-gray-100 text-gray-600';
  };

  const handleCancelParsing = async (filePath: string) => {
    if (!caseRecord) return;

    // If the right-clicked file is part of a multi-selection, cancel all selected
    const filesToCancel = selectedFiles.size > 1 && selectedFiles.has(filePath)
      ? Array.from(selectedFiles).filter(fp => {
          const t = trackedFiles[fp];
          return t && (t.status === 'PROCESSING' || t.status === 'QUEUED');
        })
      : [filePath];

    if (filesToCancel.length === 0) return;

    const label = filesToCancel.length === 1
      ? (trackedFiles[filesToCancel[0]]?.fileName || filesToCancel[0])
      : `${filesToCancel.length} file(s)`;
    const logId = addLog('Cancel Parsing', label);

    // Optimistic: save old statuses and set ERROR
    const oldStatuses: Record<string, string> = {};
    setTrackedFiles(prev => {
      const next = { ...prev };
      for (const fp of filesToCancel) {
        if (next[fp]) {
          oldStatuses[fp] = next[fp].status;
          next[fp] = { ...next[fp], status: 'ERROR' };
        }
      }
      return next;
    });

    try {
      const results = await Promise.allSettled(
        filesToCancel.map(fp =>
          fetch(`/api/documents/${trackedFiles[fp].documentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ERROR' }),
          })
        )
      );

      const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
      if (failed.length === 0) {
        updateLog(logId, 'success');
      } else {
        updateLog(logId, failed.length < filesToCancel.length ? 'success' : 'error',
          failed.length > 0 ? `${failed.length} failed` : undefined);
        // Rollback failed
        setTrackedFiles(prev => {
          const next = { ...prev };
          results.forEach((r, i) => {
            if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)) {
              const fp = filesToCancel[i];
              if (next[fp] && oldStatuses[fp]) next[fp] = { ...next[fp], status: oldStatuses[fp] };
            }
          });
          return next;
        });
      }
    } catch {
      setTrackedFiles(prev => {
        const next = { ...prev };
        for (const fp of filesToCancel) {
          if (next[fp] && oldStatuses[fp]) next[fp] = { ...next[fp], status: oldStatuses[fp] };
        }
        return next;
      });
      updateLog(logId, 'error', 'Network error');
    }
  };

  const handleReparseDocument = async (filePath: string) => {
    if (!caseRecord) return;

    // If the right-clicked file is part of a multi-selection, reparse all selected
    const filesToReparse = selectedFiles.size > 1 && selectedFiles.has(filePath)
      ? Array.from(selectedFiles).filter(fp => {
          const t = trackedFiles[fp];
          return t && t.status !== 'QUEUED'; // skip already queued
        })
      : [filePath];

    if (filesToReparse.length === 0) return;

    const label = filesToReparse.length === 1
      ? (trackedFiles[filesToReparse[0]]?.fileName || filesToReparse[0])
      : `${filesToReparse.length} file(s)`;
    const logId = addLog('Reparse', label);

    // Optimistic: mark all as QUEUED, save old statuses for rollback
    const oldStatuses: Record<string, string> = {};
    setTrackedFiles(prev => {
      const next = { ...prev };
      for (const fp of filesToReparse) {
        if (next[fp]) {
          oldStatuses[fp] = next[fp].status;
          next[fp] = { ...next[fp], status: 'QUEUED' };
        }
      }
      return next;
    });

    try {
      const results = await Promise.allSettled(
        filesToReparse.map(fp =>
          fetch(`/api/documents/${trackedFiles[fp].documentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'QUEUED' }),
          })
        )
      );

      const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
      if (failed.length === 0) {
        updateLog(logId, 'success');
      } else if (failed.length < filesToReparse.length) {
        updateLog(logId, 'success', `${failed.length} failed`);
      } else {
        updateLog(logId, 'error', 'All requests failed');
      }

      // Rollback failed ones
      if (failed.length > 0) {
        setTrackedFiles(prev => {
          const next = { ...prev };
          results.forEach((r, i) => {
            if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok)) {
              const fp = filesToReparse[i];
              if (next[fp] && oldStatuses[fp]) {
                next[fp] = { ...next[fp], status: oldStatuses[fp] };
              }
            }
          });
          return next;
        });
      }
    } catch {
      // Rollback all
      setTrackedFiles(prev => {
        const next = { ...prev };
        for (const fp of filesToReparse) {
          if (next[fp] && oldStatuses[fp]) {
            next[fp] = { ...next[fp], status: oldStatuses[fp] };
          }
        }
        return next;
      });
      updateLog(logId, 'error', 'Network error');
    }
  };

  const getContextMenuItems = (filePath: string): ContextMenuItem[] => {
    const tracked = trackedFiles[filePath];
    const status = tracked?.status;
    const isMulti = selectedFiles.size > 1 && selectedFiles.has(filePath);
    const multiCount = isMulti ? selectedFiles.size : 0;
    // Build shared items from unified component
    const cmTarget: DocumentTarget = { filePaths: isMulti ? Array.from(selectedFiles) : [filePath], caseId: caseRecord?.id || '' };
    const cmActions: DocumentContextMenuActions = {
      onAddNewFiling: () => openFilingDialog(filePath),
      onAddToExistingFiling: () => { setDialogFilePath(filePath); setDialogError(''); setSelectedFilingId(''); setCreateNewFiling(false); loadFilings().then(() => setShowFilingDialog(true)); },
      onIndex: () => handleRunParser(filePath),
    };
    const cmShared = getSharedDocumentMenuItems(cmTarget, cmActions, { indexDisabled: status === 'PROCESSING' || status === 'INDEXED', indexLabel: status === 'INDEXED' ? 'Index (already indexed)' : 'Index' });
    return [
      ...cmShared,
      { label: '', onClick: () => {}, separator: true },
      {
        label: isMulti ? `Run Parser (${multiCount})` : 'Run Parser',
        icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
        onClick: () => handleRunParser(filePath),
        disabled: status === 'PROCESSING' || status === 'INDEXED',
      },
      {
        label: isMulti ? `Parse Again (${multiCount})` : 'Parse Again',
        icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
        onClick: () => handleReparseDocument(filePath),
        disabled: !tracked || status === 'QUEUED',
      },
      {
        label: isMulti ? `Cancel Parsing (${multiCount})` : 'Cancel Parsing',
        icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>,
        onClick: () => handleCancelParsing(filePath),
        disabled: !tracked || (status !== 'PROCESSING' && status !== 'QUEUED'),
        danger: true,
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Update file path',
        icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>,
        onClick: async () => {
          if (!tracked) return;
          const logId = addLog('Update file path', filePath);
          try {
            const res = await fetch(`/api/documents/${tracked.documentId}/refresh-path`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              updateLog(logId, 'error', data?.error || `HTTP ${res.status}`);
              return;
            }
            const action = data.action || 'updated';
            const msg = action === 'path_updated' ? `relocated → ${data.newPath}`
              : action === 'path_still_valid' ? 'path still valid — no change'
              : action === 'marked_error' ? 'file not found in case tree'
              : action;
            updateLog(logId, 'success', msg);
            if (caseRecord) {
              try { await loadFiles(caseRecord.id); } catch { /* best-effort */ }
            }
          } catch (err) {
            updateLog(logId, 'error', (err as Error).message);
          }
        },
        disabled: !tracked,
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Edit Name',
        icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>,
        onClick: () => {
          if (tracked) {
            setRenameDocId(tracked.documentId);
            setRenameValue(tracked.fileName);
            setShowRenameDialog(true);
          }
        },
        disabled: !tracked,
      },
      {
        label: 'Delete',
        icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
        onClick: () => handleDeleteDocument(filePath),
        disabled: !tracked,
        danger: true,
      },

      {
        label: 'Add as Exhibit',
        icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>,
        onClick: () => openExhibitDialog(filePath),
      },
    ];
  };

  const renderFileTree = (entries: FileEntry[], depth: number = 0) => {
    return entries.map(entry => {
      if (entry.type === 'folder') {
        const isExpanded = expandedFolders.has(entry.path);
        return (
          <div key={entry.path}>
            <div className="flex items-center gap-2 py-1.5 px-2 hover:bg-gray-50 cursor-pointer rounded"
              style={{ paddingLeft: `${depth * 20 + 8}px` }} onClick={() => toggleFolder(entry.path)}>
              <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <svg className="w-4 h-4 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
              <span className="text-sm text-gray-700">{entry.name}</span>
            </div>
            {isExpanded && entry.children && renderFileTree(entry.children, depth + 1)}
          </div>
        );
      }

      const isSelected = selectedFiles.has(entry.path);
      const tracked = trackedFiles[entry.path];
      const status = tracked?.status;

      return (
        <div
          key={entry.path}
          draggable
          onDragStart={(e) => {
            const paths = isSelected && selectedFiles.size > 1
              ? Array.from(selectedFiles)
              : [entry.path];
            e.dataTransfer.setData('application/x-court-lens-paths', JSON.stringify(paths));
            e.dataTransfer.setData('text/plain', paths.join('\n'));
            e.dataTransfer.effectAllowed = 'copy';
          }}
          className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer select-none group/file ${isSelected ? 'bg-blue-50 ring-1 ring-blue-300' : 'hover:bg-gray-50'}`}
          style={{ paddingLeft: `${depth * 20 + 28}px` }}
          onClick={(e) => handleFileClick(entry.path, e)}
          onContextMenu={(e) => handleContextMenu(entry.path, e)}
        >
          {/* Status dot indicator */}
          {status ? (
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${getStatusDotColor(status)}`} title={status} />
          ) : (
            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 bg-gray-200" title="Not tracked" />
          )}
          <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
          </svg>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-gray-800 truncate" title={entry.name}>
                {tracked?.fileName && tracked.fileName !== entry.name ? tracked.fileName : entry.name}
              </span>
              {/* Filing type badge/pill */}
              {tracked?.filingSlug && tracked?.filingTitle && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push(`/case-management/${encodeURIComponent(caseNumberParam)}/${encodeURIComponent(tracked.filingSlug!)}`);
                  }}
                  className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 transition-colors cursor-pointer ${
                    getFilingTypeColor(tracked.filingTitle.split(' ').slice(0, 2).join(' ')).bg
                  } ${
                    getFilingTypeColor(tracked.filingTitle.split(' ').slice(0, 2).join(' ')).text
                  } hover:opacity-80`}
                  title={tracked.filingTitle}
                >
                  {tracked.filingTitle.length > 20 ? tracked.filingTitle.slice(0, 20) + '...' : tracked.filingTitle}
                </button>
              )}
            </div>
            {tracked?.fileName && tracked.fileName !== entry.name && (
              <span className="text-xs text-gray-400 block truncate" title={entry.name}>{entry.name}</span>
            )}
          </div>
          {entry.size && <span className="text-xs text-gray-400 flex-shrink-0">{formatSize(entry.size)}</span>}
          {status && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${getStatusBadge(status)}`}>{status.toLowerCase()}</span>
              {(status === 'PROCESSING' || status === 'QUEUED') && (
                <button onClick={(e) => { e.stopPropagation(); handleCancelParsing(entry.path); }}
                  className="p-0.5 text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover/file:opacity-100" title="Cancel Parsing">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              )}
              {(status === 'INDEXED' || status === 'ERROR') && (
                <button onClick={(e) => { e.stopPropagation(); handleReparseDocument(entry.path); }}
                  className="p-0.5 text-gray-300 hover:text-orange-500 transition-colors opacity-0 group-hover/file:opacity-100" title="Parse Again">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                </button>
              )}
            </div>
          )}
        </div>
      );
    });
  };

  if (loading) return <div className="flex-1 flex items-center justify-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div></div>;
  if (notFound) return <div className="flex-1 flex items-center justify-center"><div className="text-center"><p className="text-gray-500 text-lg">Case not found</p><p className="text-gray-400 text-sm mt-1">No case with number &quot;{caseNumberParam}&quot;</p></div></div>;
  if (!caseRecord) return null;

  return (
    <>
      {/* Header */}
      <div className="border-b border-gray-200">
        <div className="p-4 pb-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{caseRecord.name}</h2>
            <p className="text-xs text-gray-400 truncate" title={caseRecord.path}>{caseRecord.path}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer px-2 py-1 rounded hover:bg-gray-100">
              <input type="checkbox" checked={autoAddFilings} onChange={toggleAutoAddFilings}
                className="h-3.5 w-3.5 rounded text-blue-600" />
              Auto Add Filings
            </label>
            {filingQueueProcessing ? (
              <button onClick={handleCancelFilingQueue}
                className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 transition-colors">
                Cancel Queue
              </button>
            ) : (
              <button onClick={handleAddToFilingQueue} disabled={selectedFiles.size === 0}
                className="px-3 py-1.5 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                Filing Queue ({selectedFiles.size})
              </button>
            )}
            <button onClick={handleSelectAll} className="px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded">Select All</button>
            <button onClick={handleDeselectAll} className="px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded">Deselect All</button>
            <button onClick={handleRefreshFolder} disabled={refreshFolderLoading}
              className="px-3 py-1.5 bg-slate-600 text-white text-sm rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
              title="Re-scan the case folder for renames or new files">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {refreshFolderLoading ? 'Refreshing...' : 'Refresh folder'}
            </button>
            <button onClick={handleParseSelected} disabled={selectedFiles.size === 0 || parseLoading}
              className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {parseLoading ? 'Parsing...' : `Parse Selected (${selectedFiles.size})`}
            </button>
          </div>
        </div>
          {/* Status filter bar */}
          <div className="flex items-center gap-1.5 mt-3">
            <button onClick={() => setStatusFilter('all')} className={`px-2.5 py-1 text-xs rounded-full transition-colors ${statusFilter === 'all' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>All</button>
            <button onClick={() => setStatusFilter('active')} className={`px-2.5 py-1 text-xs rounded-full transition-colors ${statusFilter === 'active' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>Active {statusCounts.total > 0 && <span className="ml-0.5 opacity-75">{statusCounts.total}</span>}</button>
            <button onClick={() => setStatusFilter('INDEXED')} className={`px-2.5 py-1 text-xs rounded-full transition-colors flex items-center gap-1 ${statusFilter === 'INDEXED' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}><span className={`w-1.5 h-1.5 rounded-full ${statusFilter === 'INDEXED' ? 'bg-white' : 'bg-green-500'}`} />Indexed {statusCounts.indexed > 0 && <span className="opacity-75">{statusCounts.indexed}</span>}</button>
            <button onClick={() => setStatusFilter('QUEUED')} className={`px-2.5 py-1 text-xs rounded-full transition-colors flex items-center gap-1 ${statusFilter === 'QUEUED' ? 'bg-yellow-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}><span className={`w-1.5 h-1.5 rounded-full ${statusFilter === 'QUEUED' ? 'bg-white' : 'bg-yellow-400'}`} />Queued {statusCounts.queued > 0 && <span className="opacity-75">{statusCounts.queued}</span>}</button>
            {statusCounts.processing > 0 && <button onClick={() => setStatusFilter('PROCESSING')} className={`px-2.5 py-1 text-xs rounded-full transition-colors flex items-center gap-1 ${statusFilter === 'PROCESSING' ? 'bg-yellow-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}><span className={`w-1.5 h-1.5 rounded-full animate-pulse ${statusFilter === 'PROCESSING' ? 'bg-white' : 'bg-yellow-500'}`} />Processing {statusCounts.processing}</button>}
            {statusCounts.error > 0 && <button onClick={() => setStatusFilter('ERROR')} className={`px-2.5 py-1 text-xs rounded-full transition-colors flex items-center gap-1 ${statusFilter === 'ERROR' ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}><span className={`w-1.5 h-1.5 rounded-full ${statusFilter === 'ERROR' ? 'bg-white' : 'bg-red-500'}`} />Errors {statusCounts.error}</button>}
          </div>
          {/* Search bar */}
          <div className="relative mt-2">
            <svg className="absolute left-2.5 top-2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search files... (e.g. Signed* or *.jpg, blob patterns supported)"
              className="w-full pl-8 pr-8 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-1 mb-1">Click to select. Shift+click for range. Cmd/Ctrl+click to toggle. Right-click for actions.</p>
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto p-2">
        {filesLoading ? (
          <div className="flex items-center justify-center h-32"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div></div>
        ) : statusFilteredFiles.length === 0 ? (
          <div className="flex items-center justify-center h-32"><p className="text-gray-500 text-sm">{searchQuery || statusFilter !== 'all' ? 'No files match your filters' : 'No PDF files found in this folder'}</p></div>
        ) : renderFileTree(statusFilteredFiles)}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={getContextMenuItems(contextMenu.filePath)} onClose={() => setContextMenu(null)} />
      )}

      {/* Add to Filing Dialog */}
      {showFilingDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowFilingDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">
              {createNewFiling ? 'Add New Filing' : 'Add to Existing Filing'}
            </h3>
            <p className="text-xs text-gray-500 mb-4 truncate">{dialogFilePath.split('/').pop()}</p>

            {createNewFiling ? (
              <>
                {detectingFiling && (
                  <div className="flex items-center gap-2 text-xs text-blue-600 mb-3">
                    <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-500" />
                    Analyzing first 5 pages...
                  </div>
                )}
                {!detectingFiling && detectionSource && (
                  <div className="flex items-center gap-2 text-xs mb-2">
                    <span className="text-gray-400">
                      Detected via {detectionSource === 'cache' ? 'cache' : detectionSource === 'semantic' ? 'AI' : 'pattern matching'}
                    </span>
                    {detectionConfidence > 0 && (
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                        detectionConfidence >= 0.85 ? 'bg-green-100 text-green-700' :
                        detectionConfidence >= 0.6 ? 'bg-yellow-100 text-yellow-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {Math.round(detectionConfidence * 100)}% confidence
                      </span>
                    )}
                  </div>
                )}
                <label className="block text-sm font-medium text-gray-700 mb-1">Filing Type</label>
                <select value={newFilingType} onChange={e => setNewFilingType(e.target.value)}
                  disabled={detectingFiling}
                  className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500 ${detectingFiling ? 'opacity-50' : ''}`}>
                  {!newFilingType && <option value="">Detecting...</option>}
                  {FILING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input type="text" value={newFilingTitle} onChange={e => setNewFilingTitle(e.target.value)}
                  placeholder="e.g. Motion to Compel Discovery"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {(newFilingType === "Clerk's Record" || newFilingType === "Reporter's Record") && (
                  <>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Volume Number</label>
                    <input type="number" min="1" value={newVolumeNumber} onChange={e => setNewVolumeNumber(e.target.value)}
                      placeholder="e.g. 2"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    <div className="flex items-center gap-3 mb-3">
                      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newFilingSupplemental}
                          onChange={e => setNewFilingSupplemental(e.target.checked)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        Supplemental Record
                      </label>
                      {newFilingSupplemental && (
                        <div className="flex items-center gap-1.5">
                          <label className="text-xs text-gray-500">Order:</label>
                          <input
                            type="number"
                            min="1"
                            value={newFilingSupplementalOrder}
                            onChange={e => setNewFilingSupplementalOrder(e.target.value)}
                            placeholder="1"
                            className="w-16 px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
                <button onClick={() => setCreateNewFiling(false)} className="text-sm text-gray-500 hover:underline mb-3">← Add to existing filing instead</button>
              </>
            ) : (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-2">Select existing filing</label>
                {filings.length === 0 ? (
                  <p className="text-sm text-gray-400 mb-3">No filings yet for this case</p>
                ) : (
                  <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg mb-3">
                    {filings.map(f => (
                      <div key={f.id}
                        onClick={() => setSelectedFilingId(f.id)}
                        className={`p-2 cursor-pointer text-sm ${selectedFilingId === f.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50 text-gray-700'}`}>
                        <span className="text-xs text-gray-400 mr-2">{f.filingType}</span>{f.title}
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={() => setCreateNewFiling(true)} className="text-sm text-blue-600 hover:underline mb-3">+ Create new filing instead</button>
              </>
            )}

            {dialogError && <p className="text-sm text-red-600 mb-3">{dialogError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowFilingDialog(false)} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleAddToFiling} disabled={dialogLoading || (!createNewFiling && !selectedFilingId)}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {dialogLoading ? 'Adding...' : 'Add to Filing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add as Exhibit Dialog */}
      {showExhibitDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowExhibitDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Add as Exhibit</h3>
            <p className="text-xs text-gray-500 mb-4 truncate">{dialogFilePath.split('/').pop()}</p>

            <label className="block text-sm font-medium text-gray-700 mb-2">Attach to filing</label>
            {filings.length === 0 ? (
              <p className="text-sm text-gray-400 mb-3">No filings yet — create one first via &quot;Add to Filing&quot;</p>
            ) : (
              <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg mb-3">
                {filings.map(f => (
                  <div key={f.id}
                    onClick={() => setSelectedFilingId(f.id)}
                    className={`p-2 cursor-pointer text-sm ${selectedFilingId === f.id ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-50 text-gray-700'}`}>
                    <span className="text-xs text-gray-400 mr-2">{f.filingType}</span>{f.title}
                  </div>
                ))}
              </div>
            )}

            <label className="block text-sm font-medium text-gray-700 mb-1">Exhibit Label (optional, auto-assigned if empty)</label>
            <input type="text" value={exhibitLabel} onChange={e => setExhibitLabel(e.target.value)}
              placeholder="e.g. Exhibit A"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500" />

            {dialogError && <p className="text-sm text-red-600 mb-3">{dialogError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowExhibitDialog(false)} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleAddAsExhibit} disabled={dialogLoading || !selectedFilingId}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {dialogLoading ? 'Adding...' : 'Add as Exhibit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Dialog */}
      {showRenameDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowRenameDialog(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Edit Document Name</h3>
            <input type="text" value={renameValue} onChange={e => setRenameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRename(); }}
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowRenameDialog(false)} className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleRename} disabled={renameLoading || !renameValue.trim()}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {renameLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Action Log Panel */}
      <div className="border-t border-gray-200 bg-gray-50">
        <div className="flex items-center">
          <button
            onClick={() => setLogPanelOpen(prev => !prev)}
            className="flex-1 flex items-center justify-between px-4 py-1.5 text-xs text-gray-500 hover:bg-gray-100 transition-colors"
          >
            <span className="flex items-center gap-2">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Action Log ({actionLogs.length})
              {actionLogs.some(l => l.status === 'pending') && (
                <span className="inline-block w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
              )}
            </span>
            <svg className={`w-3.5 h-3.5 transition-transform ${logPanelOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
            </svg>
          </button>
          {logPanelOpen && actionLogs.length > 0 && (
            <button
              onClick={() => setActionLogs(prev => prev.filter(l => l.status === 'pending'))}
              className="px-2 py-1 mr-2 text-[10px] text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors flex-shrink-0"
              title="Clear completed logs"
            >
              Clear
            </button>
          )}
        </div>
        {logPanelOpen && (
          <div className="max-h-36 overflow-y-auto px-4 pb-2">
            {actionLogs.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">No actions yet</p>
            ) : (
              <div className="space-y-0.5">
                {actionLogs.map(log => (
                  <div key={log.id} className="flex items-center gap-2 text-xs py-0.5">
                    {log.status === 'pending' && (
                      <div className="w-3.5 h-3.5 flex-shrink-0">
                        <div className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-blue-500" />
                      </div>
                    )}
                    {log.status === 'success' && (
                      <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {log.status === 'error' && (
                      <svg className="w-3.5 h-3.5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    )}
                    {log.status === 'cancelled' && (
                      <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      </svg>
                    )}
                    <span className="text-gray-400 flex-shrink-0">{log.time.toLocaleTimeString()}</span>
                    <span className="text-gray-600 font-medium flex-shrink-0">{log.action}</span>
                    <span className="text-gray-500 truncate">{log.file}</span>
                    {log.detail && <span className={`flex-shrink-0 ${log.status === 'cancelled' ? 'text-gray-400' : 'text-red-400'}`}>{log.detail}</span>}
                    {log.status === 'pending' && log.action === 'Filing Queue' && filingQueueProcessing && (
                      <button
                        onClick={() => { handleCancelFilingQueue(); }}
                        className="ml-auto flex-shrink-0 px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-700 hover:bg-red-50 rounded border border-red-200 transition-colors"
                        title="Cancel filing queue"
                      >
                        Cancel Queue
                      </button>
                    )}
                    {log.status === 'pending' && log.action !== 'Filing Queue' && (
                      <button
                        onClick={() => cancelLog(log.id)}
                        className="ml-auto flex-shrink-0 px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
                        title="Cancel"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
