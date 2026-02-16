'use client';

import { useEffect, useRef, useState } from 'react';
import PipelineStageIndicator from './pipeline-stage-indicator';

interface StageProgress {
  stage: string;
  detail: string;
  progress: number;
  stageIndex: number;
  totalStages: number;
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
  stageProgress?: StageProgress;
}

interface DocumentGridProps {
  caseId: string;
  initialDocuments: Document[];
  onDocumentsUpdate?: (documents: Document[]) => void;
  partialDocumentIds?: string[];
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function DocumentCard({
  doc,
  onClick,
  isRetrying,
  isSelected,
  isPartial,
  onRetry,
}: {
  doc: Document;
  onClick: (e: React.MouseEvent) => void;
  isRetrying: boolean;
  isSelected: boolean;
  isPartial?: boolean;
  onRetry?: () => void;
}) {
  const bgColors = {
    QUEUED: 'bg-gray-50',
    PROCESSING: 'bg-yellow-50',
    INDEXED: isPartial ? 'bg-amber-50' : 'bg-green-50',
    ERROR: 'bg-red-50',
    STOPPED: 'bg-gray-100',
  } as const;

  const dotColors = {
    QUEUED: 'bg-gray-400',
    PROCESSING: 'bg-yellow-400',
    INDEXED: isPartial ? 'bg-amber-400' : 'bg-green-500',
    ERROR: 'bg-red-500',
    STOPPED: 'bg-gray-500',
  } as const;

  const textColors = {
    QUEUED: 'text-gray-700',
    PROCESSING: 'text-yellow-700',
    INDEXED: isPartial ? 'text-amber-700' : 'text-green-700',
    ERROR: 'text-red-700',
    STOPPED: 'text-gray-700',
  } as const;

  return (
    <div
      onClick={onClick}
      className={`
        ${bgColors[doc.status]}
        border-2 rounded-lg p-4 cursor-pointer
        hover:shadow-lg transition-all duration-200
        ${isSelected ? 'border-blue-500 ring-2 ring-blue-200' : doc.status === 'PROCESSING' ? 'border-yellow-300 animate-pulse' : 'border-gray-200'}
      `}
    >
      {/* Status indicator */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center">
          {isSelected ? (
            <span className="w-4 h-4 rounded bg-blue-500 mr-2 flex items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </span>
          ) : (
            <span className={`w-2.5 h-2.5 rounded-full ${dotColors[doc.status]} mr-2`}></span>
          )}
          <span className={`text-xs font-semibold uppercase ${textColors[doc.status]}`}>
            {isPartial && doc.status === 'INDEXED' ? 'PARTIAL' : doc.status}
          </span>
        </div>
        <span className="text-xs text-gray-400">{relativeTime(doc.updatedAt)}</span>
      </div>

      {/* File name */}
      <h3 className="font-medium text-gray-900 text-sm mb-2 truncate" title={doc.fileName}>
        {doc.fileName}
      </h3>

      {/* Metadata */}
      <div className="space-y-1 text-xs text-gray-600">
        {doc.pageCount !== null && (
          <div className="flex items-center">
            <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{doc.pageCount} {doc.pageCount === 1 ? 'page' : 'pages'}</span>
          </div>
        )}
        {doc.detectedExhibits > 0 && (
          <div className="flex items-center">
            <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span>{doc.detectedExhibits} {doc.detectedExhibits === 1 ? 'exhibit' : 'exhibits'}</span>
          </div>
        )}
      </div>

      {/* Processing stage detail */}
      {doc.status === 'PROCESSING' && doc.stageProgress && (
        <PipelineStageIndicator
          stage={doc.stageProgress.stage}
          detail={doc.stageProgress.detail}
          progress={doc.stageProgress.progress}
          stageIndex={doc.stageProgress.stageIndex ?? 0}
          totalStages={doc.stageProgress.totalStages ?? 10}
        />
      )}

      {doc.status === 'PROCESSING' && !doc.stageProgress && (
        <div className="mt-2">
          <div className="text-xs text-yellow-600">Starting...</div>
        </div>
      )}

      {/* Error message preview + retry */}
      {doc.status === 'ERROR' && (
        <div className="mt-2">
          {doc.errorMessage && (
            <div className="text-xs text-red-600 truncate mb-2" title={doc.errorMessage}>
              {doc.errorMessage}
            </div>
          )}
          {onRetry && (
            <button
              onClick={(e) => { e.stopPropagation(); onRetry(); }}
              disabled={isRetrying}
              className="text-xs px-2.5 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded transition-colors disabled:opacity-50"
            >
              {isRetrying ? 'Retrying...' : 'Retry'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function DocumentGrid({ caseId, initialDocuments, onDocumentsUpdate, partialDocumentIds }: DocumentGridProps) {
  const [documents, setDocuments] = useState<Document[]>(initialDocuments);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [reparseInProgress, setReparseInProgress] = useState(false);
  const [addToQueueInProgress, setAddToQueueInProgress] = useState(false);
  const [deleteIndexInProgress, setDeleteIndexInProgress] = useState(false);
  const [stopIndexInProgress, setStopIndexInProgress] = useState(false);
  const [removeFromQueueInProgress, setRemoveFromQueueInProgress] = useState(false);
  const [removeStoppedInProgress, setRemoveStoppedInProgress] = useState(false);
  const lastClickedRef = useRef<string | null>(null);
  const partialSet = new Set(partialDocumentIds || []);

  // Reset selection when case changes (polling effect handles fresh data fetch)
  useEffect(() => {
    setDocuments(initialDocuments);
    setSelectedIds(new Set());
  }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for document updates every 2 seconds
  useEffect(() => {
    // Fetch immediately on case switch (initialDocuments may be stale)
    let cancelled = false;
    fetch(`/api/documents?caseId=${caseId}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!cancelled && data?.documents) {
          setDocuments(data.documents);
          onDocumentsUpdate?.(data.documents);
        }
      })
      .catch(() => {});

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/documents?caseId=${caseId}`);
        if (response.ok) {
          const data = await response.json();
          setDocuments(data.documents);
          onDocumentsUpdate?.(data.documents);
        }
      } catch (error) {
        console.error('Failed to fetch document updates:', error);
      }
    }, 2000);

    return () => { cancelled = true; clearInterval(pollInterval); };
  }, [caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Partition documents into groups
  const indexed = documents.filter((d) => d.status === 'INDEXED');
  const pending = documents.filter((d) => d.status === 'QUEUED' || d.status === 'PROCESSING');
  const stopped = documents.filter((d) => d.status === 'STOPPED');
  const errored = documents.filter((d) => d.status === 'ERROR');

  // All documents in flat order for shift-click range selection
  const allDocs = [...indexed, ...pending, ...stopped, ...errored];

  const handleCardClick = (doc: Document, e: React.MouseEvent) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);

      if (e.shiftKey && lastClickedRef.current) {
        // Shift+Click: range selection
        const lastIdx = allDocs.findIndex((d) => d.id === lastClickedRef.current);
        const currIdx = allDocs.findIndex((d) => d.id === doc.id);
        if (lastIdx !== -1 && currIdx !== -1) {
          const [lo, hi] = lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx];
          const range = allDocs.slice(lo, hi + 1);
          const allSelected = range.every((d) => next.has(d.id));
          for (const d of range) {
            if (allSelected) next.delete(d.id);
            else next.add(d.id);
          }
        }
      } else if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl+Click: toggle individual
        if (next.has(doc.id)) next.delete(doc.id);
        else next.add(doc.id);
      } else {
        // Plain click: select only this, or deselect if already only selection
        if (next.size === 1 && next.has(doc.id)) {
          next.clear();
        } else {
          next.clear();
          next.add(doc.id);
        }
      }

      lastClickedRef.current = doc.id;
      return next;
    });
  };

  const handleRetry = async (docId: string) => {
    setRetrying((prev) => new Set(prev).add(docId));
    try {
      await fetch(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'QUEUED', preserveCache: true }),
      });
    } catch (error) {
      console.error('Failed to retry document:', error);
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(docId);
        return next;
      });
    }
  };

  const handleRetryAll = async () => {
    const ids = errored.map((d) => d.id);
    ids.forEach((id) => setRetrying((prev) => new Set(prev).add(id)));
    await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/documents/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'QUEUED' }),
        })
      )
    );
    setRetrying((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };

  const handleAddToQueueSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setAddToQueueInProgress(true);
    try {
      await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/documents/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'QUEUED' }),
          })
        )
      );
      setSelectedIds(new Set());
    } catch (error) {
      console.error('Failed to add documents to queue:', error);
    } finally {
      setAddToQueueInProgress(false);
    }
  };

  const handleReparseSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setReparseInProgress(true);
    try {
      await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/documents/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'QUEUED' }),
          })
        )
      );
      setSelectedIds(new Set());
    } catch (error) {
      console.error('Failed to reparse documents:', error);
    } finally {
      setReparseInProgress(false);
    }
  };

  const handleStopIndexSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setStopIndexInProgress(true);
    try {
      await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/documents/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'STOPPED' }),
          })
        )
      );
      setSelectedIds(new Set());
    } catch (error) {
      console.error('Failed to stop documents:', error);
    } finally {
      setStopIndexInProgress(false);
    }
  };

  const handleRemoveFromQueue = async () => {
    const ids = Array.from(selectedIds).filter(id => {
      const doc = documents.find(d => d.id === id);
      return doc && (doc.status === 'QUEUED' || doc.status === 'PROCESSING');
    });
    if (ids.length === 0) return;

    setRemoveFromQueueInProgress(true);
    try {
      await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/documents/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'STOPPED' }),
          })
        )
      );
      setSelectedIds(new Set());
    } catch (error) {
      console.error('Failed to remove documents from queue:', error);
    } finally {
      setRemoveFromQueueInProgress(false);
    }
  };

  const handleDeleteIndexSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setDeleteIndexInProgress(true);
    try {
      await Promise.allSettled(
        ids.map((id) =>
          fetch(`/api/documents/${id}/clear-index`, {
            method: 'POST',
          })
        )
      );
      setSelectedIds(new Set());
    } catch (error) {
      console.error('Failed to clear document indexes:', error);
    } finally {
      setDeleteIndexInProgress(false);
    }
  };

  const handleRemoveAllStopped = async () => {
    if (stopped.length === 0) return;
    setRemoveStoppedInProgress(true);
    try {
      await Promise.allSettled(
        stopped.map((doc) =>
          fetch(`/api/documents/${doc.id}`, { method: 'DELETE' })
        )
      );
    } catch (error) {
      console.error('Failed to remove stopped documents:', error);
    } finally {
      setRemoveStoppedInProgress(false);
    }
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
    lastClickedRef.current = null;
  };

  // Categorize selected docs for the action bar
  const selectedDocs = documents.filter((d) => selectedIds.has(d.id));
  const selectedStatuses = {
    processing: selectedDocs.filter((d) => d.status === 'PROCESSING').length,
    error: selectedDocs.filter((d) => d.status === 'ERROR').length,
    indexed: selectedDocs.filter((d) => d.status === 'INDEXED').length,
    queued: selectedDocs.filter((d) => d.status === 'QUEUED').length,
    stopped: selectedDocs.filter((d) => d.status === 'STOPPED').length,
  };

  if (documents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-gray-500 text-lg">No documents found</p>
          <p className="text-gray-400 text-sm mt-2">
            Documents will appear here once they are detected
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden">
      {/* Selection action bar */}
      {selectedIds.size > 0 && (
        <div className="flex-none bg-blue-50 border-b border-blue-200 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-blue-800">
              {selectedIds.size} selected
            </span>
            {(selectedStatuses.processing > 0 || selectedStatuses.error > 0 || selectedStatuses.indexed > 0 || selectedStatuses.stopped > 0) && (
              <span className="text-xs text-blue-600">
                {[
                  selectedStatuses.processing > 0 && `${selectedStatuses.processing} processing`,
                  selectedStatuses.error > 0 && `${selectedStatuses.error} errored`,
                  selectedStatuses.indexed > 0 && `${selectedStatuses.indexed} indexed`,
                  selectedStatuses.queued > 0 && `${selectedStatuses.queued} queued`,
                  selectedStatuses.stopped > 0 && `${selectedStatuses.stopped} stopped`,
                ].filter(Boolean).join(', ')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleAddToQueueSelected}
              disabled={addToQueueInProgress}
              className="text-sm px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              {addToQueueInProgress ? 'Queuing...' : 'Add to Queue Selected'}
            </button>
            {(selectedStatuses.queued > 0 || selectedStatuses.processing > 0) && (
              <button
                onClick={handleRemoveFromQueue}
                disabled={removeFromQueueInProgress}
                className="text-sm px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 12H6" />
                </svg>
                {removeFromQueueInProgress ? 'Removing...' : `Remove from Queue (${selectedStatuses.queued + selectedStatuses.processing})`}
              </button>
            )}
            <button
              onClick={handleReparseSelected}
              disabled={reparseInProgress}
              className="text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {reparseInProgress ? 'Reparsing...' : 'Reparse Selected'}
            </button>
            <button
              onClick={handleStopIndexSelected}
              disabled={stopIndexInProgress}
              className="text-sm px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
              </svg>
              {stopIndexInProgress ? 'Stopping...' : 'Stop Index Selected'}
            </button>
            <button
              onClick={handleDeleteIndexSelected}
              disabled={deleteIndexInProgress}
              className="text-sm px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              {deleteIndexInProgress ? 'Clearing...' : 'Delete Index Selected'}
            </button>
            <button
              onClick={handleDeselectAll}
              className="text-sm px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 border border-gray-300 rounded-md transition-colors"
            >
              Deselect All
            </button>
          </div>
        </div>
      )}

      {/* Hint */}
      {selectedIds.size === 0 && (pending.length > 0 || errored.length > 0 || stopped.length > 0) && (
        <div className="flex-none px-6 py-2 text-xs text-gray-400 border-b border-gray-100">
          Tip: ⌘+Click to select multiple documents, Shift+Click for range
        </div>
      )}

      {/* Document grid */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-full">
          {/* Indexed Column */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center">
                <span className="w-3 h-3 rounded-full bg-green-500 mr-2"></span>
                <h3 className="text-sm font-semibold text-green-800">Indexed</h3>
              </div>
              <span className="text-xs font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                {indexed.length}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {indexed.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-sm">No indexed documents yet</p>
                </div>
              ) : (
                indexed.map((doc) => (
                  <DocumentCard
                    key={doc.id}
                    doc={doc}
                    onClick={(e) => handleCardClick(doc, e)}
                    isRetrying={false}
                    isSelected={selectedIds.has(doc.id)}
                    isPartial={partialSet.has(doc.id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Queued / Processing Column */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center">
                <span className="w-3 h-3 rounded-full bg-yellow-400 mr-2"></span>
                <h3 className="text-sm font-semibold text-yellow-800">Queued / Processing</h3>
              </div>
              <span className="text-xs font-semibold text-yellow-700 bg-yellow-100 px-2 py-0.5 rounded-full">
                {pending.length}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {pending.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm">Nothing in the queue</p>
                </div>
              ) : (
                pending.map((doc) => (
                  <DocumentCard
                    key={doc.id}
                    doc={doc}
                    onClick={(e) => handleCardClick(doc, e)}
                    isRetrying={false}
                    isSelected={selectedIds.has(doc.id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Stopped Column */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center">
                <span className="w-3 h-3 rounded-full bg-gray-500 mr-2"></span>
                <h3 className="text-sm font-semibold text-gray-700">Stopped</h3>
              </div>
              <div className="flex items-center gap-2">
                {stopped.length > 0 && (
                  <button
                    onClick={handleRemoveAllStopped}
                    disabled={removeStoppedInProgress}
                    className="text-xs px-2 py-0.5 bg-red-100 hover:bg-red-200 text-red-700 rounded transition-colors disabled:opacity-50"
                  >
                    {removeStoppedInProgress ? 'Removing...' : 'Remove All'}
                  </button>
                )}
                <span className="text-xs font-semibold text-gray-600 bg-gray-200 px-2 py-0.5 rounded-full">
                  {stopped.length}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {stopped.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                  </svg>
                  <p className="text-sm">No stopped documents</p>
                </div>
              ) : (
                stopped.map((doc) => (
                  <DocumentCard
                    key={doc.id}
                    doc={doc}
                    onClick={(e) => handleCardClick(doc, e)}
                    isRetrying={false}
                    isSelected={selectedIds.has(doc.id)}
                  />
                ))
              )}
            </div>
          </div>

          {/* Errored Column */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center">
                <span className="w-3 h-3 rounded-full bg-red-500 mr-2"></span>
                <h3 className="text-sm font-semibold text-red-800">Errors</h3>
              </div>
              <div className="flex items-center gap-2">
                {errored.length > 1 && (
                  <button
                    onClick={handleRetryAll}
                    className="text-xs px-2 py-0.5 bg-red-100 hover:bg-red-200 text-red-700 rounded transition-colors"
                  >
                    Retry All
                  </button>
                )}
                <span className="text-xs font-semibold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">
                  {errored.length}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {errored.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm">No errors — all clear</p>
                </div>
              ) : (
                errored.map((doc) => (
                  <DocumentCard
                    key={doc.id}
                    doc={doc}
                    onClick={(e) => handleCardClick(doc, e)}
                    isRetrying={retrying.has(doc.id)}
                    isSelected={selectedIds.has(doc.id)}
                    onRetry={() => handleRetry(doc.id)}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
