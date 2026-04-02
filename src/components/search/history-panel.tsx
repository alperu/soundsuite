'use client';

import { useState, useEffect, useCallback } from 'react';

interface SessionMeta {
  id: string;
  caseNumber?: string;
  caseId?: string;
  mode: 'ai' | 'deep' | 'compare';
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  firstQuery: string;
  turnCount: number;
}

interface HistoryPanelProps {
  currentSessionId: string;
  onLoadSession: (sessionId: string) => void;
}

const MODE_BADGES: Record<string, { label: string; className: string }> = {
  ai: { label: 'AI', className: 'bg-purple-100 text-purple-700' },
  deep: { label: 'Deep', className: 'bg-indigo-100 text-indigo-700' },
  compare: { label: 'Compare', className: 'bg-blue-100 text-blue-700' },
};

export function HistoryPanel({ currentSessionId, onLoadSession }: HistoryPanelProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [archiveMode, setArchiveMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [archiving, setArchiving] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; session: SessionMeta } | null>(null);

  const fetchSessions = useCallback(() => {
    setLoading(true);
    fetch('/api/chat/history')
      .then(r => r.json())
      .then(data => setSessions(data.sessions || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // Close context menu on click outside / escape
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [contextMenu]);

  const handleCopyPath = async (session: SessionMeta) => {
    setContextMenu(null);
    try {
      const res = await fetch(`/api/chat/history/${session.id}/open-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseNumber: session.caseNumber }),
      });
      const data = await res.json();
      if (data.path) {
        await navigator.clipboard.writeText(data.path);
      }
    } catch {}
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleArchive = async () => {
    if (selectedIds.size === 0) return;
    setArchiving(true);
    try {
      const res = await fetch('/api/chat/history/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: Array.from(selectedIds) }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chat-archive-${new Date().toISOString().slice(0, 10)}.md`;
        a.click();
        URL.revokeObjectURL(url);
        setArchiveMode(false);
        setSelectedIds(new Set());
      }
    } catch { /* ignore */ }
    finally { setArchiving(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/chat/history/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.id !== id));
      }
    } catch { /* ignore */ }
  };

  // Group sessions by case number
  const grouped = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const group = s.caseNumber || 'General';
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(s);
  }

  if (loading) {
    return (
      <div className="p-4 text-center py-8">
        <svg className="w-5 h-5 text-gray-400 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <p className="text-xs text-gray-400">Loading history...</p>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="p-4 text-center py-12">
        <svg className="w-10 h-10 text-gray-200 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-sm text-gray-400 font-medium">No history yet</p>
        <p className="text-xs text-gray-400 mt-1">Previous conversations will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
        <p className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </p>
        <div className="flex items-center gap-1">
          {archiveMode ? (
            <>
              <button
                onClick={handleArchive}
                disabled={selectedIds.size === 0 || archiving}
                className="text-[10px] px-2 py-1 bg-blue-600 text-white rounded font-medium disabled:bg-gray-300"
              >
                {archiving ? '...' : `Archive (${selectedIds.size})`}
              </button>
              <button
                onClick={() => { setArchiveMode(false); setSelectedIds(new Set()); }}
                className="text-[10px] px-2 py-1 text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setArchiveMode(true)}
                className="text-[10px] px-2 py-1 text-gray-500 hover:text-gray-700 rounded hover:bg-gray-100"
                title="Select sessions to archive"
              >
                Archive
              </button>
              <button
                onClick={fetchSessions}
                className="text-[10px] px-1.5 py-1 text-gray-400 hover:text-gray-600"
                title="Refresh"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {Array.from(grouped.entries()).map(([group, groupSessions]) => (
          <div key={group}>
            <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100">
              <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{group}</p>
            </div>
            {groupSessions.map(s => {
              const isActive = s.id === currentSessionId;
              const isSelected = selectedIds.has(s.id);
              const badge = MODE_BADGES[s.mode] || MODE_BADGES.ai;
              const date = new Date(s.updatedAt);
              const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
              const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

              return (
                <div
                  key={s.id}
                  className={`px-3 py-2 border-b border-gray-50 cursor-pointer transition-colors ${
                    isActive ? 'bg-purple-50 border-l-2 border-l-purple-500' : 'hover:bg-gray-50'
                  }`}
                  onClick={() => archiveMode ? toggleSelect(s.id) : onLoadSession(s.id)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, session: s });
                  }}
                >
                  <div className="flex items-start gap-2">
                    {archiveMode && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(s.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 mt-0.5"
                        onClick={e => e.stopPropagation()}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-800 font-medium truncate">
                        {s.firstQuery || 'Untitled'}
                      </p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                        <span className="text-[10px] text-gray-400">{dateStr} {timeStr}</span>
                        <span className="text-[10px] text-gray-400">{Math.floor(s.turnCount / 2)} turn{Math.floor(s.turnCount / 2) !== 1 ? 's' : ''}</span>
                      </div>
                    </div>
                    {!archiveMode && (
                      <button
                        onClick={e => { e.stopPropagation(); handleDelete(s.id); }}
                        className="text-gray-400 hover:text-red-500 p-0.5"
                        title="Delete"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button
            onClick={() => handleCopyPath(contextMenu.session)}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-blue-50 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            Copy Path
          </button>
          <button
            onClick={() => { onLoadSession(contextMenu.session.id); setContextMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-blue-50 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            Load Session
          </button>
          <div className="border-t border-gray-100 my-1" />
          <button
            onClick={() => { handleDelete(contextMenu.session.id); setContextMenu(null); }}
            className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
