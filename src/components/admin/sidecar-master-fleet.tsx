'use client';

/**
 * The fleet as sidecarmaster reports it (fleet.source = follow). Shown on the GPU Fleet page
 * above the local relay view, so the operator sees the desired roles next to the live state.
 */
import type { SmHost, FollowStatus } from '@/lib/db/fleet-source';

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export default function SidecarMasterFleet({ hosts, status }: { hosts: SmHost[]; status: FollowStatus | null }) {
  return (
    <div className="bg-white shadow rounded-lg p-6" data-testid="sidecarmaster-fleet">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold text-gray-900">Fleet from sidecarmaster</h2>
        {status && (
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${status.connected ? 'bg-green-100 text-green-800' : status.fromSnapshot ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'}`}>
            {status.connected ? `synced ${ago(status.lastSyncAt)}` : status.fromSnapshot ? `snapshot from ${ago(status.snapshotAt)}` : 'not connected'}
          </span>
        )}
      </div>
      <p className="text-sm text-gray-600 mb-4">
        Desired roles per host as sidecarmaster has them. Edits go there; this copy refreshes within a minute.
        {status?.lastError && <span className="text-red-700"> Last error: {status.lastError}</span>}
      </p>
      {hosts.length === 0 ? (
        <p className="text-gray-500 text-sm py-2">No hosts for this app in sidecarmaster yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 px-3 font-medium text-gray-600">Host</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600">Sidecar URL</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600">OS</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600">State</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600">GPU</th>
                <th className="text-left py-2 px-3 font-medium text-gray-600">Roles</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map(h => {
                const gpu = h.gpus?.[0];
                return (
                  <tr key={h.hostId} className="border-b border-gray-100">
                    <td className="py-2 px-3">
                      <div className="font-medium text-gray-900">{h.name}</div>
                      {h.hostname && h.hostname !== h.name && <div className="text-xs text-gray-500">{h.hostname}</div>}
                      {h.sidecarVersion && <div className="text-[11px] text-gray-400">v{h.sidecarVersion}</div>}
                    </td>
                    <td className="py-2 px-3 font-mono text-xs text-gray-600">
                      <div>{h.agentUrl ?? '—'}</div>
                      {h.aliases?.filter(a => a !== h.agentUrl).map(a => <div key={a} className="text-gray-400">{a}</div>)}
                    </td>
                    <td className="py-2 px-3 text-xs text-gray-600">{h.os ?? '—'}</td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${h.online ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                        {h.online ? 'online' : 'offline'}
                      </span>
                      {h.lastHeartbeatAt && <div className="text-[11px] text-gray-400 mt-0.5">{ago(h.lastHeartbeatAt)}</div>}
                    </td>
                    <td className="py-2 px-3 text-xs text-gray-600">
                      {gpu ? `${gpu.name.replace(/^NVIDIA\s+/i, '')} ${Math.round(gpu.memoryTotalMb / 1024)} GB` : '—'}
                      {typeof h.activeRequests === 'number' && <div className="text-[11px] text-gray-400">{h.activeRequests} active</div>}
                    </td>
                    <td className="py-2 px-3">
                      <div className="flex flex-wrap gap-1">
                        {h.roles.filter(r => r.enabled).map(r => (
                          <span key={r.mode} title={`runtime ${r.runtime}, min ${r.minOnline}, idle ${r.idleTimeoutMin} min${r.model ? `, model ${r.model}` : ''}`}
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${r.running ? 'bg-green-50 text-green-800 border-green-200' : 'bg-gray-50 text-gray-700 border-gray-200'}`}>
                            {r.mode.replace(/^ss-/, '')}{r.running ? ' ●' : ''}
                          </span>
                        ))}
                        {h.roles.filter(r => r.enabled).length === 0 && <span className="text-xs text-gray-400">none</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
