'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface VersionEntry {
  id: string;
  draftId: string;
  version: number;
  changeSummary?: string;
  createdAt: string;
}

interface DraftVersionHistoryProps {
  draftId: string;
  currentVersion: number;
  onRestore: () => void;
  onPreview?: (content: string | null) => void;
  caseId?: string;
  onImportComplete?: () => void;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatAbsolute(dateStr: string): string {
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

export default function DraftVersionHistory({
  draftId,
  currentVersion,
  onRestore,
  onPreview,
  caseId,
  onImportComplete,
}: DraftVersionHistoryProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const url = caseId ? `/api/drafts/export?caseId=${caseId}` : '/api/drafts/export';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `drafts-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert('Export failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
    setExporting(false);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/drafts/import', { method: 'POST', body: form });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Import failed');
      const msg = `Imported: ${result.imported}, Skipped: ${result.skipped}` +
        (result.errors?.length ? `\n\nWarnings:\n${result.errors.join('\n')}` : '');
      alert(msg);
      onImportComplete?.();
    } catch (e) {
      alert('Import failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCompact = async () => {
    if (versions.length <= 1) return;
    const confirmed = window.confirm(
      `Delete ${versions.length - 1} older version${versions.length - 1 === 1 ? '' : 's'}? Only the latest version (v${currentVersion}) will be kept. This cannot be undone.`
    );
    if (!confirmed) return;

    setCompacting(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}/versions/compact`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Compact failed');
      fetchVersions();
    } catch (e) {
      alert('Compact failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
    setCompacting(false);
  };

  const fetchVersions = useCallback(() => {
    if (!draftId) return;
    setLoading(true);
    fetch(`/api/drafts/${draftId}/versions`)
      .then(r => r.json())
      .then(data => setVersions(Array.isArray(data) ? data : []))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [draftId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const handlePreview = async (entry: VersionEntry) => {
    if (previewingId === entry.id) {
      // Toggle off
      setPreviewingId(null);
      onPreview?.(null);
      return;
    }

    setPreviewingId(entry.id);
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}/versions/${entry.id}`);
      if (res.ok) {
        const data = await res.json();
        onPreview?.(data.content);
      }
    } catch {}
    setPreviewLoading(false);
  };

  const handleRestore = async () => {
    if (!previewingId) return;
    const entry = versions.find(v => v.id === previewingId);
    if (!entry) return;

    const confirmed = window.confirm(
      `Restore to version ${entry.version}? Your current content will be saved as a new version.`
    );
    if (!confirmed) return;

    setRestoring(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}/versions/${previewingId}/restore`, {
        method: 'POST',
      });
      if (res.ok) {
        setPreviewingId(null);
        onPreview?.(null);
        onRestore();
        fetchVersions();
      }
    } catch {}
    setRestoring(false);
  };

  const handleBackToCurrent = () => {
    setPreviewingId(null);
    onPreview?.(null);
  };

  if (loading) {
    return (
      <div className="px-3 py-4 space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="animate-pulse flex gap-3">
            <div className="w-2 h-2 rounded-full bg-gray-200 mt-1.5 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 bg-gray-200 rounded w-1/3" />
              <div className="h-2.5 bg-gray-100 rounded w-2/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <svg className="w-10 h-10 text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm text-gray-400">No version history yet</p>
        <p className="text-xs text-gray-300 mt-1">Versions are created when you edit the document</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Preview bar */}
      {previewingId && (
        <div className="sticky top-0 z-10 px-3 py-2 bg-amber-50 border-b border-amber-200 shrink-0">
          <div className="flex items-center gap-2 text-xs">
            <svg className="w-3.5 h-3.5 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <span className="text-amber-700 font-medium">
              {previewLoading ? 'Loading preview...' : `Previewing v${versions.find(v => v.id === previewingId)?.version}`}
            </span>
            <div className="flex-1" />
            <button
              onClick={handleRestore}
              disabled={restoring || previewLoading}
              className="px-2 py-0.5 text-[11px] font-medium text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {restoring ? 'Restoring...' : 'Restore'}
            </button>
            <button
              onClick={handleBackToCurrent}
              className="px-2 py-0.5 text-[11px] text-gray-600 border border-gray-300 rounded hover:bg-gray-100"
            >
              Back to current
            </button>
          </div>
        </div>
      )}

      {/* Export / Import toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 shrink-0">
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {exporting ? (
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14m0 0l-4-4m4 4l4-4M5 19h14" />
            </svg>
          )}
          Export All
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={importing}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {importing ? (
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5m0 0l-4 4m4-4l4 4M5 5h14" />
            </svg>
          )}
          Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip"
          onChange={handleImport}
          className="hidden"
        />
        <button
          onClick={handleCompact}
          disabled={compacting || versions.length <= 1}
          title={versions.length <= 1 ? 'No older versions to delete' : `Delete ${versions.length - 1} older version${versions.length - 1 === 1 ? '' : 's'}`}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {compacting ? (
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 7l-7 7-7-7" />
              <path d="M19 13l-7 7-7-7" />
            </svg>
          )}
          Compact
        </button>
      </div>

      {/* Version list */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[5px] top-2 bottom-2 w-px bg-gray-200" />

          <div className="space-y-0.5">
            {versions.map((entry, i) => {
              const isCurrent = i === 0; // first entry is always the latest (sorted desc)
              const isPreviewing = entry.id === previewingId;

              return (
                <button
                  key={entry.id}
                  onClick={() => !isCurrent && handlePreview(entry)}
                  disabled={isCurrent}
                  title={formatAbsolute(entry.createdAt)}
                  className={`w-full text-left pl-5 pr-2 py-2 rounded-md relative transition-colors ${
                    isPreviewing
                      ? 'bg-blue-50'
                      : isCurrent
                        ? 'bg-gray-50'
                        : 'hover:bg-gray-50'
                  } ${isCurrent ? 'cursor-default' : 'cursor-pointer'}`}
                >
                  {/* Timeline dot */}
                  <div
                    className={`absolute left-0 top-3 w-[11px] h-[11px] rounded-full border-2 ${
                      isCurrent
                        ? 'border-blue-500 bg-blue-500'
                        : isPreviewing
                          ? 'border-blue-400 bg-blue-100'
                          : 'border-gray-300 bg-white'
                    }`}
                  />

                  <div className="flex items-center gap-1.5">
                    <span className={`text-xs font-semibold ${isCurrent ? 'text-blue-600' : isPreviewing ? 'text-blue-500' : 'text-gray-700'}`}>
                      v{entry.version}
                    </span>
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                        Current
                      </span>
                    )}
                    <span className="text-[11px] text-gray-400 ml-auto">
                      {relativeTime(entry.createdAt)}
                    </span>
                  </div>
                  <p className={`text-[11px] mt-0.5 truncate ${entry.changeSummary ? 'text-gray-500' : 'text-gray-400 italic'}`}>
                    {entry.changeSummary || 'Auto-saved'}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
