'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import ServerConnection from '@/components/server-connection';
// ModeSelector removed — legacy single-GPU concept superseded by per-host
// role tags on the master's /admin/roleassign page.
import ContainerTable from '@/components/container-table';
import StatsGrid from '@/components/stats-grid';
import ActivityLog from '@/components/activity-log';
import VramPanel, { type VramSnapshot } from '@/components/vram-panel';

interface ContainerInfo {
  name: string;
  status: string;
  role: string;
  config: {
    image: string;
    model: string | null;
    port: number;
    vram: number;
    type: string;
  };
}

interface TaskInfo {
  id: string;
  type: string;
  label: string;
  role?: string;
  status: 'running' | 'completed' | 'failed';
  progress?: number;
  detail?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

interface MasterStatus {
  serverUrl: string;
  wsPort?: number | null;
  connectionMode?: 'websocket' | 'http' | 'disconnected';
  lastHeartbeatAt?: number | null;
  lastSeenServerVersion?: string | null;
  pendingCommandCount?: number;
}

interface StatusData {
  agent: { uptime: number; version: string };
  containers: Record<string, ContainerInfo>;
  mode: 'indexing' | 'searching';
  activeRequests: number;
  wsConnected: boolean;
  wsCommandCount: number;
  serverUrl: string | null;
  /**
   * Multi-master payload from the new sidecar. Older builds omit this; the UI
   * falls back to the legacy single `serverUrl` field when absent.
   */
  masters?: MasterStatus[];
  roles: Record<string, { activeRequests: number; idleTimerActive: boolean }>;
  idleTimeouts?: Record<string, number>;
  minOnline?: Record<string, number>;
  lastConfigPushAt?: number | null;
  hostname?: string;
  ip?: string;
  tasks?: TaskInfo[];
  connectionStatus?: string;
  vram?: VramSnapshot | null;
  /**
   * Boot-event ring buffer — sidecar's own emit log for the boot sequence.
   * Surfaced on the Activity Log via seq-based dedup so events show up once
   * per boot, not on every 3s poll.
   */
  bootLog?: Array<{ seq: number; ts: number; message: string; meta?: Record<string, unknown> }>;
  /**
   * Stable per-process boot epoch (ms) of the sidecar. Changes on each sidecar
   * restart; UI resets `seenBootSeqRef` when this changes so post-restart boot
   * events aren't filtered as "already seen" against the pre-restart seq.
   */
  bootEpoch?: number;
}

interface LogEntry {
  time: string;
  message: string;
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export default function Home() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const prevStatusRef = useRef<StatusData | null>(null);
  // Highest boot-event seq we've surfaced on the Activity Log. Boot events are
  // emitted ONCE per boot by the sidecar, but the dashboard polls /api/status
  // every 3s — dedupe by monotonic seq to render each event exactly once.
  const seenBootSeqRef = useRef(0);
  // Sidecar's stable per-process boot epoch. When this changes we know the
  // sidecar restarted (nextSeq reset to 1 on its side) — reset our high-water
  // mark so the fresh boot trace renders instead of being filtered out.
  const seenBootEpochRef = useRef<number>(0);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'updating' | 'rebooting'>('idle');
  const [editingTimeouts, setEditingTimeouts] = useState<Record<string, string>>({});
  const [timeoutsDirty, setTimeoutsDirty] = useState(false);
  const [savingTimeouts, setSavingTimeouts] = useState(false);
  const updateStateRef = useRef(updateState);
  useEffect(() => { updateStateRef.current = updateState; }, [updateState]);

  const addLog = useCallback((message: string, atMs?: number) => {
    const now = atMs !== undefined ? new Date(atMs) : new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false });
    setLogs((prev) => [...prev.slice(-200), { time, message }]);
  }, []);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: StatusData = await res.json();
        if (!active) return;

        // Surface NEW boot events (seq > seenBootSeq) on the Activity Log.
        // Events fire once per boot on the sidecar — dedupe by monotonic seq
        // so a fresh page load also catches the full boot trace from /api/status.
        if (typeof data.bootEpoch === 'number' && data.bootEpoch !== seenBootEpochRef.current) {
          seenBootEpochRef.current = data.bootEpoch;
          seenBootSeqRef.current = 0; // fresh boot — re-display all bootLog entries
        }
        if (Array.isArray(data.bootLog) && data.bootLog.length > 0) {
          const fresh = data.bootLog.filter((e) => e.seq > seenBootSeqRef.current);
          if (fresh.length > 0) {
            for (const ev of fresh) addLog(ev.message, ev.ts);
            seenBootSeqRef.current = fresh[fresh.length - 1].seq;
          }
        }

        // Log meaningful changes
        const prev = prevStatusRef.current;
        if (prev) {
          if (prev.mode !== data.mode) {
            addLog(`Mode changed: ${prev.mode} → ${data.mode}`);
          }
          if (prev.wsConnected !== data.wsConnected) {
            addLog(data.wsConnected ? 'WebSocket connected' : 'WebSocket disconnected');
          }
          for (const [role, c] of Object.entries(data.containers)) {
            const prevC = prev.containers[role];
            if (prevC && prevC.status !== c.status) {
              addLog(`Container ${c.name} status: ${prevC.status} → ${c.status}`);
            }
          }
          // Connection status changes
          if (data.connectionStatus && prev.connectionStatus !== data.connectionStatus) {
            addLog(data.connectionStatus);
          }
          // Task transitions + progress
          if (data.tasks) {
            const prevTaskMap = new Map((prev.tasks || []).map(t => [t.id, t]));
            for (const t of data.tasks) {
              const prevT = prevTaskMap.get(t.id);
              if (!prevT && t.status === 'running') {
                addLog(`Task started: ${t.label}${t.role ? ` (${t.role})` : ''}`);
              } else if (prevT && prevT.status === 'running' && t.status === 'completed') {
                addLog(`Task completed: ${t.label}`);
              } else if (prevT && prevT.status === 'running' && t.status === 'failed') {
                addLog(`Task failed: ${t.label}${t.error ? ' — ' + t.error : ''}`);
              } else if (prevT && t.status === 'running' && t.detail && prevT.detail !== t.detail) {
                // Log progress changes for running tasks
                const pct = t.progress !== undefined ? ` (${t.progress}%)` : '';
                addLog(`${t.label}${pct}: ${t.detail}`);
              }
            }
          }
        } else {
          addLog('Dashboard connected to sidecar agent');
        }

        prevStatusRef.current = data;
        setStatus(data);
        setError(null);

        // After self-update reboot, reset UI state once sidecar responds
        if (updateStateRef.current === 'rebooting') {
          setUpdateState('idle');
          setUpdateAvailable(null);
          addLog('Sidecar restarted successfully after update');
        }
      } catch (err) {
        if (!active) return;
        setError((err as Error).message);
      }
    };

    poll();
    const id = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [addLog]);

  // Sync editing timeouts from server when not dirty
  useEffect(() => {
    if (!timeoutsDirty && status?.idleTimeouts) {
      const mins: Record<string, string> = {};
      for (const [role, ms] of Object.entries(status.idleTimeouts)) {
        if (role === 'cuda') continue;
        mins[role] = String(Math.round(ms / 60000));
      }
      setEditingTimeouts(mins);
    }
  }, [status?.idleTimeouts, timeoutsDirty]);

  const handleTimeoutChange = (role: string, value: string) => {
    setEditingTimeouts((prev) => ({ ...prev, [role]: value }));
    setTimeoutsDirty(true);
  };

  const handleSaveTimeouts = async () => {
    setSavingTimeouts(true);
    try {
      const idleTimeouts: Record<string, number> = {};
      for (const [role, minStr] of Object.entries(editingTimeouts)) {
        const mins = parseFloat(minStr);
        if (!isNaN(mins) && mins >= 0) {
          idleTimeouts[role] = Math.round(mins * 60000);
        }
      }
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleTimeouts }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addLog('Idle timeouts updated');
      setTimeoutsDirty(false);
    } catch (err) {
      addLog(`Failed to save timeouts: ${(err as Error).message}`);
    } finally {
      setSavingTimeouts(false);
    }
  };

  const handleAddMaster = async (url: string, opts: { authToken?: string; wsPort?: number }) => {
    try {
      addLog(`Adding master: ${url}${opts.wsPort ? ` (wsPort=${opts.wsPort})` : ''}`);
      const res = await fetch('/api/masters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl: url,
          ...(opts.authToken ? { authToken: opts.authToken } : {}),
          ...(opts.wsPort ? { wsPort: opts.wsPort } : {}),
        }),
      });
      if (!res.ok) {
        // Surface the server's error message instead of just the status code,
        // matching handleEditMaster's pattern. Without this the operator sees
        // only "HTTP 500" with no actionable info.
        const errBody = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      addLog('Master added');
    } catch (err) {
      addLog(`Add master failed: ${(err as Error).message}`);
    }
  };

  const handleEditMaster = async (
    originalUrl: string,
    patch: { serverUrl?: string; wsPort?: number | null },
  ) => {
    try {
      const summary = [
        patch.serverUrl ? `url=${patch.serverUrl}` : null,
        patch.wsPort === null ? 'wsPort=default' :
          patch.wsPort !== undefined ? `wsPort=${patch.wsPort}` : null,
      ].filter(Boolean).join(', ');
      addLog(`Editing master ${originalUrl}: ${summary || '(no changes)'}`);
      const res = await fetch(`/api/masters/${encodeURIComponent(originalUrl)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      addLog('Master updated');
    } catch (err) {
      addLog(`Edit master failed: ${(err as Error).message}`);
    }
  };

  const handleRemoveMaster = async (url: string) => {
    try {
      addLog(`Removing master: ${url}`);
      const res = await fetch(`/api/masters/${encodeURIComponent(url)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addLog('Master removed');
    } catch (err) {
      addLog(`Remove master failed: ${(err as Error).message}`);
    }
  };

  // handleModeChange removed — legacy. Use the master's /admin/roleassign
  // page to enable/disable roles per host.

  /**
   * POST a container action and surface a meaningful Activity-Log entry.
   * The sidecar's /api/containers now returns HTTP 200 with `{ok: false, error}`
   * on handler errors (mirroring the master's /api/admin/gpu-fleet pattern from
   * task #37) — so we read the body and check `ok` instead of just `res.ok`.
   * This is what makes "Start failed: HTTP 502" become "Start failed: Recreate
   * with -v /var/run/docker.sock:..." in the operator's log.
   */
  const postAction = async (
    label: string,
    action: string,
    role: string,
    okMsg: string,
  ) => {
    try {
      addLog(`${label}: ${role}`);
      const res = await fetch('/api/containers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, role }),
      });
      const body = await res.json().catch(() => ({} as { ok?: boolean; error?: string }));
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      addLog(`${okMsg} ${role}`);
    } catch (err) {
      addLog(`${label} failed for ${role}: ${(err as Error).message}`);
    }
  };

  const handleContainerStart = (role: string) => postAction('Starting container', 'start', role, 'Start command sent for');
  const handleContainerStop = (role: string) => postAction('Stopping container', 'stop', role, 'Stop command sent for');
  const handleContainerLoad = (role: string) => postAction('Loading model into VRAM', 'loadModel', role, 'Load command sent for');
  const handleContainerPull = (role: string) => postAction('Pulling model for', 'pullModel', role, 'Pull started for');
  const handleContainerPullAndLoad = (role: string) => postAction('Pulling + loading model for', 'pullAndLoad', role, 'Pull + load started for');

  // Check for updates periodically
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        setUpdateState('checking');
        const res = await fetch('/api/update');
        if (res.ok) {
          const data = await res.json();
          setUpdateAvailable(data.available ? data.version : null);
        }
      } catch { /* ignore */ }
      finally { setUpdateState(prev => prev === 'checking' ? 'idle' : prev); }
    };
    // Check after 5s (let status load first), then every 5 min
    const initial = setTimeout(checkUpdate, 5000);
    const interval = setInterval(checkUpdate, 300_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []);

  const handleUpdate = async () => {
    setUpdateState('updating');
    addLog('Starting self-update...');
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      const data = await res.json();
      if (data.updated) {
        addLog(`Update to v${data.version} applied. Rebooting...`);
        setUpdateState('rebooting');
      } else {
        addLog(`Update failed: ${data.message}`);
        setUpdateState('idle');
      }
    } catch (err) {
      addLog(`Update error: ${(err as Error).message}`);
      setUpdateState('idle');
    }
  };

  const roles = status
    ? Object.values(status.containers)
        .map((c) => c.role)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(', ')
    : '...';

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Sound Suite GPU Orchestrator</h1>
            <p className="mt-1 text-sm text-slate-500">
              {status?.hostname || '?'} ({status?.ip || '?'}) &middot; v{status?.agent?.version || '?'} &middot; Roles: {roles}
            </p>
            {(() => {
              const masters = status?.masters;
              if (masters && masters.length > 0) {
                const live = masters.filter(m => m.connectionMode === 'websocket').length;
                return (
                  <p className="text-xs text-slate-400">
                    Connected to {masters.length} {masters.length === 1 ? 'master' : 'masters'}
                    {live > 0 && ` (${live} live)`}: {masters.map(m => m.serverUrl).join(', ')}
                  </p>
                );
              }
              if (status?.serverUrl) {
                return (
                  <p className="text-xs text-slate-400">
                    Connected to {status.serverUrl}
                  </p>
                );
              }
              return null;
            })()}
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/setup"
              className="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
              title="Configure host runtime backend"
            >
              Setup
            </a>
            {updateState === 'rebooting' && (
              <span className="px-3 py-1.5 rounded-md text-sm bg-yellow-100 text-yellow-800 animate-pulse">
                Rebooting...
              </span>
            )}
            {updateState === 'updating' && (
              <span className="px-3 py-1.5 rounded-md text-sm bg-blue-100 text-blue-800 animate-pulse">
                Updating...
              </span>
            )}
            {updateAvailable && updateState === 'idle' && (
              <button onClick={handleUpdate}
                className="px-3 py-1.5 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-700">
                Update to v{updateAvailable}
              </button>
            )}
            {!updateAvailable && updateState === 'idle' && (
              <span className="text-xs text-slate-400">Up to date</span>
            )}
          </div>
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-600">
            Connection error: {error}
          </p>
        )}
      </div>

      <ServerConnection
        masters={status?.masters}
        serverUrl={status?.serverUrl ?? null}
        wsConnected={status?.wsConnected ?? false}
        onAdd={handleAddMaster}
        onEdit={handleEditMaster}
        onRemove={handleRemoveMaster}
      />

      {/* Legacy mode selector removed — per-host role tags live on the
          master's /admin/roleassign page. */}

      <VramPanel vram={status?.vram} />

      <ContainerTable
        containers={status?.containers ?? {}}
        onStart={handleContainerStart}
        onStop={handleContainerStop}
        onLoad={handleContainerLoad}
        onPull={handleContainerPull}
        onPullAndLoad={handleContainerPullAndLoad}
      />

      {/* Active Tasks */}
      {status?.tasks && status.tasks.filter(t => t.status === 'running').length > 0 && (
        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
          <h2 className="mb-3 text-sm font-semibold text-blue-900">Active Tasks</h2>
          <div className="space-y-3">
            {status.tasks.filter(t => t.status === 'running').map((task) => (
              <div key={task.id} className="rounded-md bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-slate-800">{task.label}</span>
                  <span className="text-xs text-slate-500">
                    {task.progress !== undefined ? `${task.progress}%` : 'In progress...'}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
                  {task.progress !== undefined ? (
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all duration-500"
                      style={{ width: `${task.progress}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/3 rounded-full bg-blue-400 animate-pulse" />
                  )}
                </div>
                {task.detail && (
                  <p className="mt-1 text-xs text-slate-500 truncate">{task.detail}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <StatsGrid
        activeRequests={status?.activeRequests ?? 0}
        mode={status?.mode ?? 'indexing'}
        wsCommandCount={status?.wsCommandCount ?? 0}
        wsConnected={status?.wsConnected ?? false}
      />

      {/* Minimum Online (read-only — pushed by master) */}
      {status?.minOnline && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Minimum Online Instances</h2>
            <span className="text-xs text-slate-400">
              {status.lastConfigPushAt
                ? `synced ${formatAge(Date.now() - status.lastConfigPushAt)} ago`
                : 'never synced — using defaults'}
            </span>
          </div>
          <p className="mb-3 text-xs text-slate-500">
            Pushed by the master via <code className="rounded bg-slate-100 px-1">/config</code>. <code>0</code> means this role is never auto-started by mode-switch or the 30s enforcer; ≥1 forces the role to run regardless of current mode.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium text-right">minOnline</th>
                <th className="pb-2 font-medium">Effective behaviour</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(status.minOnline).map(([role, n]) => (
                <tr key={role} className="border-t border-slate-100">
                  <td className="py-2 capitalize text-slate-700">{role}</td>
                  <td className="py-2 text-right font-mono text-slate-700">{n}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {n === 0
                      ? 'opt-out — mode-switch & enforcer skip'
                      : `keep ≥${n} instance${n === 1 ? '' : 's'} running`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Idle Timeouts */}
      {Object.keys(editingTimeouts).length > 0 && (
        <div className="mb-6 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-700">Idle Timeouts</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">Timeout</th>
                <th className="pb-2 font-medium">Timer</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(editingTimeouts).map(([role, minStr]) => {
                const roleData = status?.roles?.[role];
                const timerActive = roleData?.idleTimerActive ?? false;
                return (
                  <tr key={role} className="border-t border-slate-100">
                    <td className="py-2 capitalize text-slate-700">{role}</td>
                    <td className="py-2">
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={minStr}
                          onChange={(e) => handleTimeoutChange(role, e.target.value)}
                          className="w-16 rounded border border-slate-300 px-2 py-1 text-sm text-slate-700 focus:border-blue-400 focus:outline-none"
                        />
                        <span className="text-xs text-slate-400">min</span>
                      </div>
                    </td>
                    <td className="py-2">
                      {minStr === '0' ? (
                        <span className="text-xs text-slate-400">never</span>
                      ) : timerActive ? (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                          active
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">&mdash;</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="mt-3 flex justify-end">
            {timeoutsDirty && (
              <button
                onClick={() => setTimeoutsDirty(false)}
                className="mr-2 rounded px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSaveTimeouts}
              disabled={!timeoutsDirty || savingTimeouts}
              className={`rounded px-3 py-1.5 text-xs font-medium ${
                timeoutsDirty
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-slate-100 text-slate-400 cursor-not-allowed'
              }`}
            >
              {savingTimeouts ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      <ActivityLog entries={logs} />
    </main>
  );
}
