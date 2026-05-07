'use client';

import { useState } from 'react';

export interface MasterEntry {
  serverUrl: string;
  wsPort?: number | null;
  connectionMode?: 'websocket' | 'http' | 'disconnected';
  lastHeartbeatAt?: number | null;
  lastSeenServerVersion?: string | null;
  pendingCommandCount?: number;
}

interface ServerConnectionProps {
  /**
   * Multi-master list from /api/status. When the running sidecar is older
   * than the multi-master refactor this will be undefined; fall back to the
   * legacy single `serverUrl` prop in that case.
   */
  masters?: MasterEntry[];
  /** Legacy single-URL field for back-compat with old sidecar builds. */
  serverUrl: string | null;
  wsConnected: boolean;
  onAdd: (url: string, opts: { authToken?: string; wsPort?: number }) => void;
  onEdit: (originalUrl: string, patch: { serverUrl?: string; wsPort?: number | null }) => void;
  onRemove: (url: string) => void;
}

const DEFAULT_WS_PORT = 3002;

function formatHeartbeat(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const age = Date.now() - ms;
  if (age < 0) return 'just now';
  if (age < 1000) return `${age}ms ago`;
  const s = Math.floor(age / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function modeStyle(mode?: string): string {
  if (mode === 'websocket') return 'bg-green-100 text-green-800';
  if (mode === 'http') return 'bg-yellow-100 text-yellow-800';
  return 'bg-red-100 text-red-800';
}

function MasterRow({
  m,
  onEdit,
  onRemove,
}: {
  m: MasterEntry;
  onEdit: (originalUrl: string, patch: { serverUrl?: string; wsPort?: number | null }) => void;
  onRemove: (url: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftUrl, setDraftUrl] = useState(m.serverUrl);
  const [draftPort, setDraftPort] = useState<string>(
    m.wsPort != null ? String(m.wsPort) : '',
  );

  const startEdit = () => {
    setDraftUrl(m.serverUrl);
    setDraftPort(m.wsPort != null ? String(m.wsPort) : '');
    setEditing(true);
  };

  const cancel = () => setEditing(false);

  const save = () => {
    const patch: { serverUrl?: string; wsPort?: number | null } = {};
    const trimmedUrl = draftUrl.trim();
    if (trimmedUrl && trimmedUrl !== m.serverUrl) patch.serverUrl = trimmedUrl;

    const trimmedPort = draftPort.trim();
    const currentPort = m.wsPort ?? null;
    if (trimmedPort === '') {
      if (currentPort !== null) patch.wsPort = null; // clear → default
    } else {
      const n = Number(trimmedPort);
      if (Number.isFinite(n) && n > 0 && n <= 65535 && n !== currentPort) {
        patch.wsPort = n;
      }
    }
    if (Object.keys(patch).length > 0) onEdit(m.serverUrl, patch);
    setEditing(false);
  };

  if (editing) {
    return (
      <tr className="border-t border-slate-100 bg-blue-50">
        <td className="py-2 px-3" colSpan={2}>
          <input
            type="text"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            placeholder="http://master:port"
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </td>
        <td className="py-2 px-3" colSpan={2}>
          <input
            type="number"
            value={draftPort}
            onChange={(e) => setDraftPort(e.target.value)}
            placeholder={`WS port (default ${DEFAULT_WS_PORT})`}
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </td>
        <td className="py-2 px-3 text-right space-x-1">
          <button
            onClick={save}
            className="text-xs px-2 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white"
          >Save</button>
          <button
            onClick={cancel}
            className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
          >Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-slate-100">
      <td className="py-2 px-3 font-mono text-xs text-slate-800">{m.serverUrl}</td>
      <td className="py-2 px-3 text-slate-600 text-xs">
        {m.wsPort ?? <span className="text-slate-400">{DEFAULT_WS_PORT} <span className="text-[10px]">(default)</span></span>}
      </td>
      <td className="py-2 px-3">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${modeStyle(m.connectionMode)}`}>
          {m.connectionMode || 'disconnected'}
        </span>
      </td>
      <td className="py-2 px-3 text-slate-600 text-xs">
        {formatHeartbeat(m.lastHeartbeatAt)}
        {m.lastSeenServerVersion && (
          <span className="ml-2 text-slate-400">v{m.lastSeenServerVersion}</span>
        )}
      </td>
      <td className="py-2 px-3 text-right space-x-1">
        <button
          onClick={startEdit}
          className="text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700"
        >Edit</button>
        <button
          onClick={() => onRemove(m.serverUrl)}
          className="text-xs px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-700"
        >Remove</button>
      </td>
    </tr>
  );
}

export default function ServerConnection({
  masters,
  serverUrl,
  wsConnected,
  onAdd,
  onEdit,
  onRemove,
}: ServerConnectionProps) {
  const [url, setUrl] = useState('');
  const [wsPort, setWsPort] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [showAuthField, setShowAuthField] = useState(false);

  // Build the row list. Prefer the multi-master payload; fall back to a
  // single synthesized entry from the legacy `serverUrl` field if running
  // against an old sidecar.
  const rows: MasterEntry[] = masters && masters.length > 0
    ? masters
    : serverUrl
      ? [{
          serverUrl,
          connectionMode: wsConnected ? 'websocket' : 'disconnected',
          lastHeartbeatAt: null,
        }]
      : [];

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const opts: { authToken?: string; wsPort?: number } = {};
    if (authToken.trim()) opts.authToken = authToken.trim();
    const portNum = Number(wsPort.trim());
    if (wsPort.trim() && Number.isFinite(portNum) && portNum > 0 && portNum <= 65535) {
      opts.wsPort = portNum;
    }
    onAdd(trimmed, opts);
    setUrl('');
    setWsPort('');
    setAuthToken('');
    setShowAuthField(false);
  };

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm mb-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-900">
          Master Connections
          <span className="ml-2 text-xs font-normal text-slate-500">
            ({rows.length} {rows.length === 1 ? 'master' : 'masters'})
          </span>
        </h2>
        <span className="flex items-center gap-2 text-sm">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-slate-600">{wsConnected ? 'Live' : 'Offline'}</span>
        </span>
      </div>

      {rows.length > 0 ? (
        <div className="border border-slate-200 rounded-md overflow-hidden mb-4">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left py-2 px-3 font-medium">URL</th>
                <th className="text-left py-2 px-3 font-medium">WS Port</th>
                <th className="text-left py-2 px-3 font-medium">Mode</th>
                <th className="text-left py-2 px-3 font-medium">Last heartbeat</th>
                <th className="text-right py-2 px-3 font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <MasterRow key={m.serverUrl} m={m} onEdit={onEdit} onRemove={onRemove} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500 mb-4">No masters configured. Add one below to start receiving commands.</p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="http://your-master:3000"
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="number"
            value={wsPort}
            onChange={(e) => setWsPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder={`WS port (${DEFAULT_WS_PORT})`}
            className="w-40 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            onClick={submit}
            disabled={!url.trim()}
            className="bg-blue-500 hover:bg-blue-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-md px-4 py-2 text-sm font-medium"
          >Add master</button>
        </div>
        {showAuthField ? (
          <input
            type="text"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            placeholder="Optional auth token (Bearer)"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowAuthField(true)}
            className="self-start text-xs text-slate-500 hover:text-slate-700 underline"
          >+ add auth token</button>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
        Default WebSocket port is {DEFAULT_WS_PORT}. Override per master when the master accepts WS upgrades on a different port (e.g. Fantom MCP at 3848).
      </p>
    </div>
  );
}
