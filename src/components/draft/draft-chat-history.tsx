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

interface DraftChatHistoryProps {
  caseId?: string;
  currentSessionId: string | null;
  onLoadSession: (session: any) => void;
}

const MODE_BADGES: Record<string, { label: string; className: string }> = {
  ai: { label: 'AI', className: 'bg-blue-100 text-blue-700' },
  deep: { label: 'Deep', className: 'bg-indigo-100 text-indigo-700' },
};

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

export function DraftChatHistory({ caseId, currentSessionId, onLoadSession }: DraftChatHistoryProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  const fetchSessions = useCallback(() => {
    setLoading(true);
    fetch('/api/chat/history')
      .then(r => r.json())
      .then(data => {
        const all: SessionMeta[] = data.sessions || [];
        const draftSessions = all.filter(s => s.id.startsWith('draft-session-'));
        setSessions(draftSessions);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const handleClick = async (session: SessionMeta) => {
    setLoadingSessionId(session.id);
    try {
      const res = await fetch(`/api/chat/history/${session.id}`);
      if (res.ok) {
        const data = await res.json();
        const fullSession = data.session || data;
        onLoadSession(fullSession);
      }
    } catch { /* ignore */ }
    finally { setLoadingSessionId(null); }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      const res = await fetch(`/api/chat/history/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.id !== id));
      }
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-gray-100">
          <p className="text-xs font-semibold text-gray-600">Chat History</p>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <svg className="w-5 h-5 text-gray-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-gray-100">
          <p className="text-xs font-semibold text-gray-600">Chat History</p>
        </div>
        <div className="flex-1 flex items-center justify-center px-4">
          <p className="text-xs text-gray-400 text-center">
            No chat history yet. Start a conversation in the Chat tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Title bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
        <p className="text-xs font-semibold text-gray-600">Chat History</p>
        <span className="text-[10px] text-gray-400">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessions.map(s => {
          const isActive = s.id === currentSessionId;
          const badge = MODE_BADGES[s.mode] || MODE_BADGES.ai;
          const exchanges = Math.floor(s.turnCount / 2);
          const truncatedQuery = s.firstQuery
            ? s.firstQuery.length > 80
              ? s.firstQuery.slice(0, 80) + '...'
              : s.firstQuery
            : 'Untitled';

          return (
            <div
              key={s.id}
              className={`group px-3 py-2 border-b border-gray-100 cursor-pointer transition-colors ${
                isActive
                  ? 'bg-blue-50 border-l-2 border-l-blue-500'
                  : 'hover:bg-gray-50'
              }`}
              onClick={() => handleClick(s)}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-800 font-medium truncate">
                    {loadingSessionId === s.id ? 'Loading...' : truncatedQuery}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${badge.className}`}>
                      {badge.label}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {relativeTime(s.updatedAt)}
                    </span>
                    <span className="text-[10px] text-gray-400">
                      {exchanges} turn{exchanges !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
                <button
                  onClick={(e) => handleDelete(e, s.id)}
                  className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 p-0.5 transition-opacity"
                  title="Delete"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
