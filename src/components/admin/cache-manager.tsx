'use client';

import { useState, useEffect, useCallback } from 'react';

interface DocEntry {
  id: string;
  fileName: string;
  status: string;
  pageCount: number | null;
  embeddingModel: string | null;
  documentType: string | null;
  ingestCheckpoint: string | null;
  filing: { id: string; title: string; filingType: string } | null;
  case: { id: string; name: string } | null;
}

interface CacheStatus {
  redis: {
    available: boolean;
    filings?: { keyCount: number; description: string };
    folders?: { keyCount: number; description: string };
    progress?: { keyCount: number; description: string };
    other?: { keyCount: number; description: string };
    totalKeys?: number;
  };
  documents: Record<string, number>;
  checkpointDocs: {
    id: string;
    fileName: string;
    status: string;
    pageCount: number | null;
    ingestCheckpoint: string | null;
  }[];
  pageCache: Record<string, { extract: number; ocr: number; total: number }>;
  totalPageCacheRows: number;
  allDocuments: DocEntry[];
}

/** Group documents by filing (or "Unfiled") */
function groupByFiling(docs: DocEntry[]): { label: string; filingType: string | null; docs: DocEntry[] }[] {
  const map = new Map<string, { label: string; filingType: string | null; docs: DocEntry[] }>();

  for (const doc of docs) {
    const key = doc.filing ? doc.filing.id : '__unfiled__';
    if (!map.has(key)) {
      map.set(key, {
        label: doc.filing ? `${doc.filing.filingType} — ${doc.filing.title}` : 'Unfiled Documents',
        filingType: doc.filing?.filingType ?? null,
        docs: [],
      });
    }
    map.get(key)!.docs.push(doc);
  }

  // Unfiled last
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (a.filingType === null) return 1;
    if (b.filingType === null) return -1;
    return a.label.localeCompare(b.label);
  });

  return groups;
}

export default function CacheManager() {
  const [status, setStatus] = useState<CacheStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [confirmClearVectors, setConfirmClearVectors] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/cache');
      if (res.ok) setStatus(await res.json());
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const doAction = async (action: string, extra: Record<string, unknown> = {}) => {
    console.log('[CacheManager] doAction called:', action, extra);
    setActionLoading(action);
    try {
      const body = JSON.stringify({ action, ...extra });
      console.log('[CacheManager] POST /api/admin/cache', body);
      const res = await fetch('/api/admin/cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const data = await res.json();
      console.log('[CacheManager] Response:', res.status, data);
      if (res.ok) {
        await loadStatus();
        if (action.startsWith('reindex') || action === 'delete_and_recache' || action === 'clear_all_vectors') setSelectedDocs(new Set());
      } else {
        console.error('[CacheManager] Action failed:', data.error);
      }
    } catch (err) {
      console.error('[CacheManager] Fetch error:', err);
    }
    setActionLoading('');
  };

  const toggleDoc = (id: string) => {
    setSelectedDocs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allDocs = status?.allDocuments ?? [];

  const toggleAll = () => {
    if (selectedDocs.size === allDocs.length && allDocs.length > 0) {
      setSelectedDocs(new Set());
    } else {
      setSelectedDocs(new Set(allDocs.map(d => d.id)));
    }
  };

  const parseCheckpoint = (cp: string | null) => {
    if (!cp) return null;
    try { return JSON.parse(cp); } catch { return null; }
  };

  if (loading) return <Spinner />;

  const filingGroups = groupByFiling(allDocs);

  return (
    <div className="space-y-6">
      {/* Redis Cache Section */}
      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Redis Caches</h3>
          <div className="flex gap-2">
            <button onClick={loadStatus} className="text-sm text-blue-600 hover:underline">Refresh</button>
            <button
              onClick={() => doAction('clear_redis_all')}
              disabled={!!actionLoading || !status?.redis?.available}
              className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {actionLoading === 'clear_redis_all' ? 'Clearing...' : 'Clear All Redis'}
            </button>
          </div>
        </div>

        {!status?.redis?.available ? (
          <p className="text-sm text-gray-500">Redis is not available.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { key: 'filings', action: 'clear_redis_filings', data: status.redis.filings },
              { key: 'folders', action: 'clear_redis_folders', data: status.redis.folders },
              { key: 'progress', action: 'clear_redis_progress', data: status.redis.progress },
              { key: 'other', action: null, data: status.redis.other },
            ].map(({ key, action, data }) => (
              <div key={key} className="border rounded-lg p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700 capitalize">{key}</span>
                  <span className="text-lg font-bold text-gray-900">{data?.keyCount ?? 0}</span>
                </div>
                <p className="text-xs text-gray-500 mb-2">{data?.description ?? ''}</p>
                {action && (
                  <button
                    onClick={() => doAction(action)}
                    disabled={!!actionLoading || (data?.keyCount ?? 0) === 0}
                    className="w-full px-2 py-1 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    {actionLoading === action ? 'Clearing...' : 'Clear'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Page Cache (per-page text persistence) */}
      {(status?.totalPageCacheRows ?? 0) > 0 && (
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-gray-900">Page Cache</h3>
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-500">{status!.totalPageCacheRows} cached pages across {Object.keys(status!.pageCache).length} documents</span>
              <button
                onClick={() => doAction('clear_page_cache')}
                disabled={!!actionLoading}
                className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {actionLoading === 'clear_page_cache' ? 'Clearing...' : 'Clear All'}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            {Object.entries(status!.pageCache).map(([docId, stats]) => {
              const doc = allDocs.find(d => d.id === docId);
              const cp = parseCheckpoint(doc?.ingestCheckpoint ?? null);
              return (
                <div key={docId} className="flex items-center gap-3 border rounded-lg p-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-700 truncate">{doc?.fileName ?? docId}</div>
                    <div className="flex gap-3 text-xs text-gray-500">
                      <span>Extracted: {stats.extract}</span>
                      <span>OCR: {stats.ocr}</span>
                      <span>Total: {stats.total} pages</span>
                      {cp?.lastCompletedStage && <span>Last stage: {cp.lastCompletedStage}</span>}
                    </div>
                  </div>
                  {doc?.pageCount && (
                    <div className="w-24 h-2 bg-gray-200 rounded-full overflow-hidden flex-shrink-0">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(100, Math.round((stats.total / doc.pageCount) * 100))}%` }} />
                    </div>
                  )}
                  <button
                    onClick={() => doAction('clear_page_cache', { documentIds: [docId] })}
                    disabled={!!actionLoading}
                    className="text-xs text-red-500 hover:underline flex-shrink-0"
                  >
                    Clear
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Document Index Manager */}
      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Document Index Manager</h3>
          <div className="flex gap-2">
            <button onClick={loadStatus} className="text-sm text-blue-600 hover:underline">Refresh</button>
            {selectedDocs.size > 0 && (
              <>
                <button
                  onClick={() => doAction('reindex_documents', { documentIds: Array.from(selectedDocs) })}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {actionLoading === 'reindex_documents' ? 'Reindexing...' : `Reindex Selected (${selectedDocs.size})`}
                </button>
                <button
                  onClick={() => doAction('delete_and_recache', { documentIds: Array.from(selectedDocs) })}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {actionLoading === 'delete_and_recache' ? 'Deleting...' : `Delete & Recache (${selectedDocs.size})`}
                </button>
              </>
            )}
            <button
              onClick={() => doAction('reindex_all')}
              disabled={!!actionLoading}
              className="px-3 py-1.5 bg-orange-600 text-white text-sm rounded-lg hover:bg-orange-700 disabled:opacity-50"
            >
              {actionLoading === 'reindex_all' ? 'Reindexing...' : 'Reindex All'}
            </button>
            {confirmClearVectors ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs text-red-600 font-medium">Drop all vectors & re-queue?</span>
                <button
                  onClick={() => { setConfirmClearVectors(false); doAction('clear_all_vectors'); }}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 bg-red-700 text-white text-sm rounded-lg hover:bg-red-800 disabled:opacity-50"
                >
                  {actionLoading === 'clear_all_vectors' ? 'Clearing...' : 'Yes, Clear'}
                </button>
                <button
                  onClick={() => setConfirmClearVectors(false)}
                  className="px-3 py-1.5 bg-gray-200 text-gray-700 text-sm rounded-lg hover:bg-gray-300"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmClearVectors(true)}
                disabled={!!actionLoading}
                className="px-3 py-1.5 bg-red-700 text-white text-sm rounded-lg hover:bg-red-800 disabled:opacity-50"
              >
                Clear All Vectors
              </button>
            )}
          </div>
        </div>

        {/* Status summary */}
        {status?.documents && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {Object.entries(status.documents).map(([s, count]) => (
              <div key={s} className="border rounded-lg p-2 text-center">
                <div className="text-xl font-bold text-gray-900">{count}</div>
                <div className="text-xs text-gray-500 uppercase">{s}</div>
              </div>
            ))}
          </div>
        )}

        {/* Document table grouped by filing */}
        {allDocs.length === 0 ? (
          <p className="text-sm text-gray-500">No documents found.</p>
        ) : (
          <div className="overflow-x-auto max-h-[500px] overflow-y-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr className="text-left text-gray-500 border-b">
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={selectedDocs.size > 0 && selectedDocs.size === allDocs.length}
                      onChange={toggleAll}
                      className="rounded border-gray-300 text-blue-600"
                    />
                  </th>
                  <th className="px-3 py-2">File</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Pages</th>
                  <th className="px-3 py-2">Page Cache</th>
                  <th className="px-3 py-2 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {filingGroups.map(group => (
                  <FilingGroup
                    key={group.label}
                    group={group}
                    selectedDocs={selectedDocs}
                    toggleDoc={toggleDoc}
                    pageCache={status?.pageCache ?? {}}
                    actionLoading={actionLoading}
                    onReindex={(docId) => doAction('reindex_documents', { documentIds: [docId] })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FilingGroup({
  group,
  selectedDocs,
  toggleDoc,
  pageCache,
  actionLoading,
  onReindex,
}: {
  group: { label: string; filingType: string | null; docs: DocEntry[] };
  selectedDocs: Set<string>;
  toggleDoc: (id: string) => void;
  pageCache: Record<string, { extract: number; ocr: number; total: number }>;
  actionLoading: string;
  onReindex: (docId: string) => void;
}) {
  return (
    <>
      {/* Filing group header */}
      <tr className="bg-gray-50 border-t">
        <td colSpan={6} className="px-3 py-1.5">
          <div className="flex items-center gap-2">
            {group.filingType && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium uppercase">
                {group.filingType}
              </span>
            )}
            <span className="text-xs font-semibold text-gray-600">{group.label}</span>
            <span className="text-[10px] text-gray-400">({group.docs.length})</span>
          </div>
        </td>
      </tr>
      {/* Document rows */}
      {group.docs.map(doc => {
        const pcStats = pageCache[doc.id];
        const isIndexed = doc.status === 'INDEXED';
        return (
          <tr key={doc.id} className="border-b border-gray-100 hover:bg-gray-50">
            <td className="px-3 py-1.5">
              <input
                type="checkbox"
                checked={selectedDocs.has(doc.id)}
                onChange={() => toggleDoc(doc.id)}
                className="rounded border-gray-300 text-blue-600"
              />
            </td>
            <td className="px-3 py-1.5 text-gray-700 truncate max-w-[250px]" title={doc.fileName}>
              {doc.fileName}
            </td>
            <td className="px-3 py-1.5">
              <StatusBadge status={doc.status} />
            </td>
            <td className="px-3 py-1.5 text-gray-600">{doc.pageCount ?? '-'}</td>
            <td className="px-3 py-1.5 text-xs text-gray-500">
              {pcStats ? `${pcStats.extract} ext / ${pcStats.ocr} ocr` : '-'}
            </td>
            <td className="px-3 py-1.5 text-right">
              {isIndexed && (
                <button
                  onClick={() => onReindex(doc.id)}
                  disabled={!!actionLoading}
                  className="text-xs text-blue-600 hover:underline disabled:opacity-50"
                >
                  Reindex
                </button>
              )}
              {doc.status === 'ERROR' && (
                <button
                  onClick={() => onReindex(doc.id)}
                  disabled={!!actionLoading}
                  className="text-xs text-orange-600 hover:underline disabled:opacity-50"
                >
                  Retry
                </button>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    INDEXED: 'bg-green-100 text-green-700',
    PROCESSING: 'bg-yellow-100 text-yellow-700',
    QUEUED: 'bg-blue-100 text-blue-700',
    ERROR: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colors[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-8">
      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500" />
    </div>
  );
}
