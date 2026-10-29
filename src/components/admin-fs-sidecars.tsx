'use client';

import { useEffect, useState } from 'react';

/** Shape of `fsSidecars` in GET /api/admin/gpu-fleet (see lib/fs-sidecar/status.ts). */
export interface FsSidecarRow {
  sidecarId: string;
  username: string;
  version?: string;
  os?: string;
  profiles: string[];
  connectionMode: 'websocket' | 'http' | 'disconnected';
  lastHeartbeatAt?: number;
  lastSeenAt: number;
  confirmedSeq: number;
}

interface FolderStatJson {
  sidecarId: string;
  root: string;
  path: string;
  caseId: string | null;
  recFileCount: number;
  recTotalBytes: number;
  recLatestMtimeMs: number;
}

export function formatAgo(ms?: number, now = Date.now()): string {
  if (!ms) return 'never';
  const secs = Math.max(0, Math.floor((now - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

const MODE_LABEL = { websocket: 'WS', http: 'HTTP', disconnected: 'offline' } as const;

/**
 * File-system sidecars (fileSystemSideCar link) inside the Sidecar Fleet
 * panel: connection mode, last heartbeat, version, and the top-level folder
 * totals they report (`folder-status` profile).
 */
export function FsSidecarTable({ sidecars }: { sidecars: FsSidecarRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [stats, setStats] = useState<FolderStatJson[]>([]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch(`/api/admin/folder-stats?sidecarId=${encodeURIComponent(open)}&maxDepth=1`)
      .then((r) => (r.ok ? r.json() : { stats: [] }))
      .then((b) => live && setStats(b.stats || []))
      .catch(() => live && setStats([]));
    return () => {
      live = false;
    };
  }, [open]);

  if (!sidecars.length) return null;
  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <h3 className="text-sm font-medium text-gray-700 mb-2">File-System Sidecars</h3>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-2 px-3 font-medium text-gray-600">Sidecar</th>
              <th className="text-left py-2 px-3 font-medium text-gray-600">Conn</th>
              <th className="text-left py-2 px-3 font-medium text-gray-600">Last Heartbeat</th>
              <th className="text-left py-2 px-3 font-medium text-gray-600">Profiles</th>
              <th className="text-left py-2 px-3 font-medium text-gray-600">Confirmed Seq</th>
            </tr>
          </thead>
          <tbody>
            {sidecars.map((s) => (
              <tr key={s.sidecarId} onClick={() => setOpen(open === s.sidecarId ? null : s.sidecarId)}
                className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${open === s.sidecarId ? 'bg-blue-50' : ''}`}>
                <td className="py-2 px-3 font-medium text-gray-900">
                  {s.sidecarId}
                  {s.version && <span className="ml-2 text-xs text-gray-400">v{s.version}</span>}
                  {s.os && <span className="ml-2 text-xs text-gray-400">{s.os}</span>}
                </td>
                <td className="py-2 px-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    s.connectionMode === 'websocket' ? 'bg-purple-100 text-purple-800'
                      : s.connectionMode === 'http' ? 'bg-blue-100 text-blue-800'
                      : 'bg-gray-100 text-gray-400 border border-gray-200'
                  }`}>{MODE_LABEL[s.connectionMode]}</span>
                </td>
                <td className="py-2 px-3 text-gray-600" title={`last message ${formatAgo(s.lastSeenAt)}`}>{formatAgo(s.lastHeartbeatAt)}</td>
                <td className="py-2 px-3 text-gray-600">{s.profiles.join(', ') || '—'}</td>
                <td className="py-2 px-3 text-gray-600">{s.confirmedSeq}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="mt-2">
          {stats.length === 0 ? (
            <p className="text-gray-500 text-sm py-2">No folder totals yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Folder</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600">Files</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600">Size</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Latest Change</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((f) => (
                  <tr key={`${f.root}/${f.path}`} className="border-b border-gray-100">
                    <td className="py-1 px-3 font-mono text-xs">
                      {f.root}/{f.path}
                      {f.caseId && <span title={`case ${f.caseId}`} className="ml-2 text-xs text-blue-600">case</span>}
                    </td>
                    <td className="py-1 px-3 text-right">{f.recFileCount}</td>
                    <td className="py-1 px-3 text-right">{formatBytes(f.recTotalBytes)}</td>
                    <td className="py-1 px-3 text-gray-600">{f.recLatestMtimeMs ? formatAgo(f.recLatestMtimeMs) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
