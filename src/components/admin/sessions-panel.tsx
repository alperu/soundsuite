'use client';

import { useCallback, useEffect, useState } from 'react';

interface SessionRow {
  id: string;
  sessionId: string;
  source: string;
  clientName: string | null;
  userId: string | null;
  createdAt: string;
  lastActivity: string;
  userAgent: string | null;
  ipAddress: string | null;
  revokedAt: string | null;
  toolCallCount: number;
}

const REFRESH_INTERVAL_MS = 15_000;

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortUserAgent(ua: string | null): string {
  if (!ua) return '—';
  return ua.length > 40 ? ua.slice(0, 40) + '…' : ua;
}

export default function SessionsPanel() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'active' | 'all'>('active');
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/sessions?status=${statusFilter}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSessions(data.sessions);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const revoke = async (session: SessionRow) => {
    if (!window.confirm(`Revoke session for "${session.clientName || session.sessionId.slice(0, 8)}"? Further tool calls from it will be refused.`)) {
      return;
    }
    setRevoking(session.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/sessions/${session.id}/revoke`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Sessions</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            MCP and dashboard client sessions. Refreshes every 15 seconds.
          </p>
        </div>
        <div className="flex rounded-md border border-gray-300 overflow-hidden text-xs font-medium">
          <button
            onClick={() => setStatusFilter('active')}
            className={statusFilter === 'active' ? 'px-3 py-1.5 bg-blue-600 text-white' : 'px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50'}
          >
            Active
          </button>
          <button
            onClick={() => setStatusFilter('all')}
            className={statusFilter === 'all' ? 'px-3 py-1.5 bg-blue-600 text-white' : 'px-3 py-1.5 bg-white text-gray-600 hover:bg-gray-50'}
          >
            All
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading sessions…</div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                <th className="px-4 py-2.5">Client</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">IP</th>
                <th className="px-4 py-2.5">Started</th>
                <th className="px-4 py-2.5">Last Activity</th>
                <th className="px-4 py-2.5 text-right">Tool Calls</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-gray-400">
                    No sessions recorded{statusFilter === 'active' ? ' (active filter)' : ''}.
                  </td>
                </tr>
              )}
              {sessions.map(session => (
                <tr key={session.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-gray-900">
                      {session.clientName || session.sessionId.slice(0, 12)}
                    </div>
                    <div className="text-xs text-gray-400" title={session.userAgent ?? undefined}>
                      {shortUserAgent(session.userAgent)}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        session.source === 'mcp' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {session.source}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-600">{session.userId || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500">{session.ipAddress || '—'}</td>
                  <td className="px-4 py-2.5 text-gray-500">{formatRelative(session.createdAt)}</td>
                  <td className="px-4 py-2.5 text-gray-500">{formatRelative(session.lastActivity)}</td>
                  <td className="px-4 py-2.5 text-right text-gray-700 tabular-nums">{session.toolCallCount}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        session.revokedAt ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
                      }`}
                    >
                      {session.revokedAt ? 'Revoked' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!session.revokedAt && (
                      <button
                        onClick={() => revoke(session)}
                        disabled={revoking === session.id}
                        className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        {revoking === session.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
