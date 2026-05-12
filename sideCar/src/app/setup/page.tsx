'use client';

import { useEffect, useState, useCallback } from 'react';

type HostOs = 'darwin' | 'win32' | 'linux' | 'unknown';
type Confidence = 'env' | 'docker-info' | 'low' | 'override';

interface Health {
  at: number;
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

interface MasterEntry {
  serverUrl: string;
  wsPort: number | null;
  connectionMode: 'websocket' | 'http' | 'disconnected';
  lastHeartbeatAt: number | null;
  lastSeenServerVersion?: string | null;
  lastMasterIdentityAt?: number | null;
}

interface SidecarStatus {
  masters?: MasterEntry[];
  wsConnected?: boolean;
}

interface VolumeMountInfo {
  path: string;
  kind: 'named' | 'anonymous' | 'tmpfs' | 'host-bind' | 'not-mounted' | 'unknown';
  source?: string;
  fsType?: string;
  durable: boolean;
  note: string;
}

interface SetupStatus {
  host: {
    os: HostOs;
    osConfidence: Confidence;
    dockerDesktop: boolean;
    dockerSupportsGpu: boolean;
  };
  hostOllama: {
    enabled: boolean;
    host: string;
    roles: string[];
    budgetMb: number;
    lastHealth: Health;
  };
  dmr: {
    enabled: boolean;
    host: string;
    port: number;
    roles: string[];
    budgetMb: number;
    lastHealth: Health;
  };
  knownRoles: { role: string; type: string; model: string | null }[];
  installHints: {
    ollama: { label: string; steps: string[] };
    dmr: { label: string; steps: string[] };
  };
}

type RuntimeChoice = 'host' | 'docker-ollama' | 'docker-vllm';

const RUNTIME_COLUMNS: Array<{ key: RuntimeChoice; label: string }> = [
  { key: 'host', label: 'Ollama (native)' },
  { key: 'docker-ollama', label: 'Docker Ollama' },
  { key: 'docker-vllm', label: 'Docker vLLM' },
];

/** Mode catalog mirroring the master's. ss-reranker is linux-only. */
const MODE_CATALOG: Array<{ role: string; mode: string; availableOn: HostOs[] }> = [
  { role: 'embedding', mode: 'ss-embedding', availableOn: ['darwin', 'linux', 'win32'] },
  { role: 'completion', mode: 'ss-completion', availableOn: ['darwin', 'linux', 'win32'] },
  { role: 'ocr', mode: 'ss-ocr', availableOn: ['darwin', 'linux', 'win32'] },
  { role: 'reranker', mode: 'ss-reranker', availableOn: ['linux'] },
];

/** macOS Docker Desktop has no GPU passthrough for plain ollama/ollama
 *  containers — so docker-ollama is unavailable; DMR/vllm-metal still works. */
function availableRuntimesForOs(os: HostOs): Record<RuntimeChoice, boolean> {
  if (os === 'darwin') return { host: true, 'docker-ollama': false, 'docker-vllm': true };
  return { host: true, 'docker-ollama': true, 'docker-vllm': true };
}

function runtimesForMode(modeName: string): Record<RuntimeChoice, boolean> {
  if (modeName === 'ss-reranker') {
    return { host: false, 'docker-ollama': false, 'docker-vllm': true };
  }
  return { host: true, 'docker-ollama': true, 'docker-vllm': true };
}

/** Derive a role's current runtime choice from the legacy hostOllamaRoles /
 *  dmrRoles sets. Non-reranker roles absent from both fall back to
 *  'docker-ollama' (the sidecar's own container); reranker absent from both
 *  is 'off'. */
function inferRuntime(
  role: string,
  hostRoles: Set<string>,
  dmrRoles: Set<string>,
): RuntimeChoice | 'off' {
  if (dmrRoles.has(role)) return 'docker-vllm';
  if (hostRoles.has(role)) return 'host';
  if (role === 'reranker') return 'off';
  return 'docker-ollama';
}

function osLabel(os: HostOs): string {
  if (os === 'darwin') return 'macOS';
  if (os === 'win32') return 'Windows';
  if (os === 'linux') return 'Linux';
  return 'Unknown';
}

function healthBadge(h: Health, label: string) {
  const age = h.at > 0 ? Date.now() - h.at : null;
  if (h.at === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
        {label}: never probed
      </span>
    );
  }
  if (h.ok && age !== null && age < 30_000) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
        {label}: ok {h.latencyMs ? `(${h.latencyMs}ms)` : ''}
      </span>
    );
  }
  if (h.ok) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-50 px-2 py-0.5 text-xs text-yellow-700">
        <span className="h-1.5 w-1.5 rounded-full bg-yellow-500" />
        {label}: stale
      </span>
    );
  }
  let detail = h.error || 'unreachable';
  if (h.error === 'ollama_not_running') detail = 'not running (brew services start ollama)';
  else if (h.error === 'dmr_not_running') detail = 'not running (enable Docker Model Runner)';
  else if (h.error === 'dns') detail = 'host.docker.internal unresolvable';
  else if (h.error === 'no-host-roles') detail = 'no roles assigned';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      {label}: {detail}
    </span>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
      {children}
    </pre>
  );
}

function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function fmtClock(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface MasterRowProps {
  m: MasterEntry;
  onRemove: (url: string) => void;
  onSavePort: (url: string, port: number | null) => void;
  busy: boolean;
}

function MasterRow({ m, onRemove, onSavePort, busy }: MasterRowProps) {
  const [editing, setEditing] = useState(false);
  const [portDraft, setPortDraft] = useState<string>(m.wsPort != null ? String(m.wsPort) : '');
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const isWs = m.connectionMode === 'websocket';
  const isHttp = m.connectionMode === 'http';
  const dotColor = isWs ? 'bg-green-500' : isHttp ? 'bg-yellow-500' : 'bg-slate-400';
  const modeLabel = isWs ? 'WS' : isHttp ? 'HTTP poll' : 'disconnected';

  const adminUrl = (() => {
    try {
      const u = new URL(m.serverUrl);
      return `${u.origin}/admin/roleassign`;
    } catch {
      return null;
    }
  })();

  return (
    <div className="rounded border border-slate-200 bg-slate-50/40 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} aria-hidden />
        <code className="rounded bg-white px-1.5 py-0.5 text-xs text-slate-800 ring-1 ring-slate-200">{m.serverUrl}</code>
        <span className="text-xs text-slate-500">·</span>
        <span className="text-xs text-slate-600">{modeLabel}</span>
        {m.wsPort != null && (
          <>
            <span className="text-xs text-slate-500">·</span>
            <span className="text-xs text-slate-600">ws :{m.wsPort}</span>
          </>
        )}
        <span className="text-xs text-slate-500">·</span>
        <span className="text-xs text-slate-600">last heartbeat {fmtAgo(m.lastHeartbeatAt)}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {m.lastMasterIdentityAt ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">
            identified by master at {fmtClock(m.lastMasterIdentityAt)}
          </span>
        ) : null}
        {m.lastSeenServerVersion ? <span>v{m.lastSeenServerVersion}</span> : null}
        <span className="flex-1" />
        <button
          onClick={() => setEditing((v) => !v)}
          className="rounded px-2 py-0.5 text-slate-600 hover:bg-slate-200 hover:text-slate-900"
          disabled={busy}
        >
          {editing ? 'cancel' : 'edit'}
        </button>
        {confirmingRemove ? (
          <button
            onClick={() => onRemove(m.serverUrl)}
            className="rounded bg-red-600 px-2 py-0.5 font-medium text-white hover:bg-red-700"
            disabled={busy}
          >
            confirm remove
          </button>
        ) : (
          <button
            onClick={() => setConfirmingRemove(true)}
            className="rounded px-2 py-0.5 text-red-600 hover:bg-red-50"
            disabled={busy}
          >
            remove
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-2">
          <label className="text-xs text-slate-600">WS port:</label>
          <input
            type="number"
            min={1}
            max={65535}
            value={portDraft}
            placeholder="3002"
            onChange={(e) => setPortDraft(e.target.value)}
            className="w-24 rounded border border-slate-300 px-2 py-1 text-xs"
          />
          <button
            onClick={() => {
              const trimmed = portDraft.trim();
              const parsed = trimmed === '' ? null : parseInt(trimmed, 10);
              if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535)) return;
              onSavePort(m.serverUrl, parsed);
              setEditing(false);
            }}
            className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
            disabled={busy}
          >
            save
          </button>
          <span className="text-xs text-slate-400">URL changes: remove and re-add.</span>
        </div>
      )}

      {adminUrl && (
        <div className="mt-2 text-xs text-slate-500">
          Roles on this sidecar are controlled by{' '}
          <a href={adminUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
            {adminUrl} ↗
          </a>
        </div>
      )}
    </div>
  );
}

interface AddMasterFormProps {
  onAdd: (serverUrl: string, wsPort: number | undefined) => Promise<void>;
  busy: boolean;
  compact?: boolean;
}

function AddMasterForm({ onAdd, busy, compact }: AddMasterFormProps) {
  const [url, setUrl] = useState('');
  const [port, setPort] = useState('');
  const [localErr, setLocalErr] = useState<string | null>(null);

  const submit = async () => {
    setLocalErr(null);
    const u = url.trim();
    if (!u) {
      setLocalErr('Enter a master URL.');
      return;
    }
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        setLocalErr('URL must use http:// or https://');
        return;
      }
    } catch {
      setLocalErr('Invalid URL.');
      return;
    }
    const trimmedPort = port.trim();
    let portNum: number | undefined;
    if (trimmedPort) {
      const n = parseInt(trimmedPort, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 65535) {
        setLocalErr('WS port must be 1–65535.');
        return;
      }
      portNum = n;
    }
    await onAdd(u, portNum);
    setUrl('');
    setPort('');
  };

  return (
    <div className={compact ? 'mt-3' : ''}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://your-master:3000"
          className="flex-1 min-w-[16rem] rounded border border-slate-300 px-2 py-1 text-sm"
          disabled={busy}
        />
        <input
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="WS port (3002)"
          className="w-36 rounded border border-slate-300 px-2 py-1 text-sm"
          disabled={busy}
        />
        <button
          onClick={submit}
          disabled={busy}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {compact ? 'Add another master' : 'Add master'}
        </button>
      </div>
      {localErr && <p className="mt-1 text-xs text-red-600">{localErr}</p>}
    </div>
  );
}

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingOs, setSavingOs] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);
  const [osOverrideOpen, setOsOverrideOpen] = useState(false);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null);
  const [volumeInfo, setVolumeInfo] = useState<VolumeMountInfo | null>(null);
  const [masterBusy, setMasterBusy] = useState(false);
  const [masterError, setMasterError] = useState<string | null>(null);

  const [budgetMb, setBudgetMb] = useState<number>(16384);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  // Per-role runtime choice, master-shape. Seeded from hostOllama.roles +
  // dmr.roles each poll via inferRuntime().
  const [roleChoices, setRoleChoices] = useState<Record<string, RuntimeChoice | 'off'>>({});

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/setup-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SetupStatus = await res.json();
      setStatus(data);
      setError(null);
      // Seed roleChoices from current server state every poll. Save is the
      // only commit; an unsaved in-progress edit gets clobbered on poll —
      // acceptable trade-off since master pushes would override anyway.
      const hostSet = new Set(data.hostOllama.roles);
      const dmrSet = new Set(data.dmr.roles);
      const next: Record<string, RuntimeChoice | 'off'> = {};
      for (const r of data.knownRoles) {
        next[r.role] = inferRuntime(r.role, hostSet, dmrSet);
      }
      setRoleChoices(next);
      if (data.hostOllama.budgetMb > 0) setBudgetMb(data.hostOllama.budgetMb);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const fetchSidecarStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSidecarStatus(data);
    } catch {
      // Offline: keep prior snapshot (or null) so the panel can render an
      // unknown state without flashing.
      setSidecarStatus((prev) => prev ?? { masters: [], wsConnected: false });
    }
  }, []);

  useEffect(() => {
    fetchSidecarStatus();
    const id = setInterval(fetchSidecarStatus, 4000);
    return () => clearInterval(id);
  }, [fetchSidecarStatus]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/diag/volume-mount');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: VolumeMountInfo = await res.json();
        if (!cancelled) setVolumeInfo(data);
      } catch {
        if (!cancelled) setVolumeInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const addMaster = useCallback(async (serverUrl: string, wsPort: number | undefined) => {
    setMasterBusy(true);
    setMasterError(null);
    try {
      const res = await fetch('/api/masters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl, wsPort }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await fetchSidecarStatus();
    } catch (err) {
      setMasterError((err as Error).message);
    } finally {
      setMasterBusy(false);
    }
  }, [fetchSidecarStatus]);

  const removeMaster = useCallback(async (serverUrl: string) => {
    setMasterBusy(true);
    setMasterError(null);
    try {
      const res = await fetch(`/api/masters/${encodeURIComponent(serverUrl)}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await fetchSidecarStatus();
    } catch (err) {
      setMasterError((err as Error).message);
    } finally {
      setMasterBusy(false);
    }
  }, [fetchSidecarStatus]);

  const patchMasterPort = useCallback(async (serverUrl: string, wsPort: number | null) => {
    setMasterBusy(true);
    setMasterError(null);
    try {
      const res = await fetch(`/api/masters/${encodeURIComponent(serverUrl)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wsPort }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await fetchSidecarStatus();
    } catch (err) {
      setMasterError((err as Error).message);
    } finally {
      setMasterBusy(false);
    }
  }, [fetchSidecarStatus]);

  const saveHostOs = async (os: 'darwin' | 'win32' | 'linux') => {
    setSavingOs(true);
    try {
      const res = await fetch('/api/host-os', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ os }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOsOverrideOpen(false);
      setSavedFlash('Host OS saved');
      setTimeout(() => setSavedFlash(null), 2500);
      fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingOs(false);
    }
  };

  const saveBackend = async () => {
    setSavingBackend(true);
    try {
      // Derive hostOllamaRoles / dmrRoles from the per-role runtime grid.
      // 'docker-ollama' and 'off' both leave the role off the host & DMR
      // lists — the sidecar's container governs the docker-ollama path.
      const hostOllamaRolesArr: string[] = [];
      const dmrRolesArr: string[] = [];
      for (const [role, rt] of Object.entries(roleChoices)) {
        if (rt === 'host') hostOllamaRolesArr.push(role);
        else if (rt === 'docker-vllm') dmrRolesArr.push(role);
      }
      const res = await fetch('/api/host-backend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostOllamaEnabled: hostOllamaRolesArr.length > 0,
          hostOllamaRoles: hostOllamaRolesArr,
          hostOllamaBudgetMb: budgetMb,
          dmrEnabled: dmrRolesArr.length > 0,
          dmrRoles: dmrRolesArr,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedFlash('Role assignments saved');
      setTimeout(() => setSavedFlash(null), 2500);
      fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingBackend(false);
    }
  };

  const setRoleChoice = (role: string, choice: RuntimeChoice | 'off') => {
    setRoleChoices((prev) => ({ ...prev, [role]: choice }));
  };

  if (!status) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="text-2xl font-bold text-slate-900">Sound Suite Setup</h1>
        {error ? (
          <p className="mt-4 text-sm text-red-600">Error loading setup status: {error}</p>
        ) : (
          <p className="mt-4 text-sm text-slate-500">Loading...</p>
        )}
      </main>
    );
  }

  const { host, hostOllama, dmr, installHints } = status;
  // "Ambiguous" = Docker Desktop on x86_64 (could be Intel Mac or Windows).
  // We expand this to also catch the case where detection returned 'unknown'
  // with confidence 'low' — that happens on some Docker Desktop versions
  // whose /info doesn't report `OperatingSystem: "Docker Desktop"` exactly
  // as expected, leaving us blind. In both cases the operator must pick.
  const ambiguous = host.os === 'unknown' || host.osConfidence === 'low';
  const highConfidence = host.osConfidence === 'env' || host.osConfidence === 'docker-info' || host.osConfidence === 'override';

  // Master-connection state — drives read-only mode on the role grid.
  const connectedMaster =
    (sidecarStatus?.masters ?? []).find((m) => m.connectionMode !== 'disconnected') || null;
  const readOnlyRoles = !!connectedMaster;
  const osAvailable = availableRuntimesForOs(host.os);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Sound Suite Setup</h1>
          <p className="mt-1 text-sm text-slate-500">
            Configure the runtime backend for this sidecar. Selections persist and apply live.
          </p>
        </div>
        <a href="/" className="text-sm text-blue-600 hover:underline">← Back to dashboard</a>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {savedFlash && (
        <div className="mb-4 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {savedFlash}
        </div>
      )}

      {/* ── Master Connection panel ───────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-800">Master Connection</h2>
        {(() => {
          const masters = sidecarStatus?.masters ?? [];
          const wsAny = masters.some((m) => m.connectionMode === 'websocket');
          const httpAny = masters.some((m) => m.connectionMode === 'http');
          const anyConnected = wsAny || httpAny;
          if (masters.length === 0) {
            return (
              <>
                <div className="mt-2 flex items-center gap-2 text-sm text-amber-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                  Not connected to any master
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  This sidecar will run with local defaults until a master pushes a config. To connect:
                </p>
                <ol className="mt-1 list-decimal pl-5 text-xs text-slate-500">
                  <li>
                    Set the <code className="rounded bg-slate-100 px-1">SOUND_SUITE_MASTER_URL</code> env var, or
                  </li>
                  <li>Add the master URL below.</li>
                </ol>
                <AddMasterForm onAdd={addMaster} busy={masterBusy} />
              </>
            );
          }
          return (
            <>
              <div className="mt-2 flex items-center gap-2 text-sm">
                {anyConnected ? (
                  <>
                    <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                    <span className="text-green-700">
                      Connected to {masters.length} master{masters.length === 1 ? '' : 's'}
                      {wsAny ? '' : ' (HTTP fallback)'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                    <span className="text-amber-700">
                      {masters.length} master{masters.length === 1 ? '' : 's'} configured but not reachable
                    </span>
                  </>
                )}
              </div>
              <div className="mt-3 space-y-2">
                {masters.map((m) => (
                  <MasterRow
                    key={m.serverUrl}
                    m={m}
                    onRemove={removeMaster}
                    onSavePort={patchMasterPort}
                    busy={masterBusy}
                  />
                ))}
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-blue-600 hover:underline">
                  + Add another master
                </summary>
                <AddMasterForm onAdd={addMaster} busy={masterBusy} compact />
              </details>
            </>
          );
        })()}

        {masterError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {masterError}
          </div>
        )}

        {/* Persistence badge */}
        <div className="mt-4 border-t border-slate-100 pt-3">
          {!volumeInfo || volumeInfo.kind === 'unknown' ? (
            <p className="text-xs text-slate-500">
              Persistence: config.json (atomic write)
            </p>
          ) : volumeInfo.durable ? (
            <p className="text-xs text-slate-500">
              <span className="mr-1">🔒</span>
              Persistence: config.json (atomic write) ·{' '}
              {volumeInfo.kind === 'named' ? 'named volume' : volumeInfo.kind === 'host-bind' ? 'host bind-mount' : volumeInfo.kind}
              {' '}mounted at <code className="rounded bg-slate-100 px-1">{volumeInfo.path}</code>
            </p>
          ) : volumeInfo.kind === 'not-mounted' ? (
            <p className="text-xs text-slate-500">
              Persistence: config.json (atomic write) — running on host filesystem.
            </p>
          ) : (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              <div className="font-medium">
                <span className="mr-1">⚠</span>
                {volumeInfo.path} is on a {volumeInfo.kind === 'tmpfs' ? 'tmpfs' : volumeInfo.kind === 'anonymous' ? 'anonymous Docker volume' : volumeInfo.kind} mount.
              </div>
              <div className="mt-1">{volumeInfo.note}</div>
            </div>
          )}
        </div>
      </section>

      {/* ── Section 1: Host OS ────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-800">1. Docker host OS</h2>
        <p className="mt-1 text-xs text-slate-500">
          Detected by inspecting Docker Desktop&apos;s <code className="rounded bg-slate-100 px-1">/info</code>.
          This determines which runtime backends are available.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-slate-700">
            Detected: <strong>{osLabel(host.os)}</strong>
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            confidence: {host.osConfidence}
            {host.dockerDesktop && ' · Docker Desktop'}
          </span>
          {highConfidence && !osOverrideOpen && (
            <button
              onClick={() => setOsOverrideOpen(true)}
              className="text-xs text-blue-600 hover:underline"
            >
              change
            </button>
          )}
        </div>

        {(ambiguous || osOverrideOpen) && (
          <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
            {ambiguous && (
              <p className="mb-2 text-xs text-amber-800">
                {host.os === 'unknown' && host.dockerDesktop
                  ? 'Docker Desktop on x86_64 detected — could be Intel Mac or Windows. Please pick one:'
                  : 'Host OS could not be auto-detected reliably. Please select it manually — this drives which runtime backends are offered below:'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {(['darwin', 'win32', 'linux'] as const).map((os) => (
                <button
                  key={os}
                  disabled={savingOs}
                  onClick={() => saveHostOs(os)}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
                >
                  {osLabel(os)}
                </button>
              ))}
              {osOverrideOpen && !ambiguous && (
                <button
                  onClick={() => setOsOverrideOpen(false)}
                  className="rounded px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700"
                >
                  cancel
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Section 2: Role assignments — master-shape grid ─────────── */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-800">2. Role assignments</h2>
        <p className="mt-1 text-xs text-slate-500">
          One row per mode. Pick which runtime serves it on this sidecar. Greyed
          cells aren&apos;t available on {osLabel(host.os)} or for that mode.
          {readOnlyRoles && (
            <>
              {' '}— managed by master at{' '}
              <a
                href={`${(connectedMaster?.serverUrl || '').replace(/\/$/, '')}/admin/roleassign`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                /admin/roleassign ↗
              </a>
            </>
          )}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs border-separate" style={{ borderSpacing: 0 }}>
            <thead>
              <tr className="text-[11px] text-gray-500">
                <th className="text-left font-medium py-1 pr-3">Role</th>
                {RUNTIME_COLUMNS.map((col) => {
                  const avail = osAvailable[col.key];
                  return (
                    <th
                      key={col.key}
                      className={`text-center font-medium py-1 px-2 ${avail ? '' : 'text-gray-300'}`}
                      title={avail ? col.label : 'Not available on this host OS'}
                    >
                      {col.label}
                    </th>
                  );
                })}
                <th className="text-center font-medium py-1 px-2">Off</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {MODE_CATALOG.map((m) => {
                const modeAvailableOnHost = m.availableOn.includes(host.os);
                const modeRuntimes = runtimesForMode(m.mode);
                const current = roleChoices[m.role] ?? 'off';
                return (
                  <tr key={m.role} className="border-t border-gray-100">
                    <td className="py-1.5 pr-3">
                      <span className="font-mono text-gray-800">{m.mode}</span>
                      {!modeAvailableOnHost && (
                        <span
                          className="ml-1 text-amber-500"
                          title={`${m.mode} is not supported on ${osLabel(host.os)} — use a Linux+NVIDIA sidecar.`}
                        >
                          ⓘ
                        </span>
                      )}
                    </td>
                    {RUNTIME_COLUMNS.map((col) => {
                      const cellAvail =
                        osAvailable[col.key] && modeRuntimes[col.key] && modeAvailableOnHost;
                      const checked = current === col.key;
                      let tooltip: string;
                      if (!modeRuntimes[col.key]) {
                        tooltip =
                          m.mode === 'ss-reranker'
                            ? `${m.mode} only runs via Docker vLLM.`
                            : `${m.mode} cannot run on ${col.label}.`;
                      } else if (!osAvailable[col.key]) {
                        tooltip =
                          host.os === 'darwin'
                            ? 'macOS Docker Desktop has no GPU passthrough for plain Ollama containers — use native Ollama or Docker vLLM.'
                            : 'Not available on this host.';
                      } else {
                        tooltip = `Run ${m.mode} via ${col.label}`;
                      }
                      const disabled = !cellAvail || readOnlyRoles;
                      return (
                        <td key={col.key} className="text-center py-1.5 px-2">
                          <input
                            type="radio"
                            name={`rt-${m.role}`}
                            disabled={disabled}
                            checked={checked}
                            onChange={() => {
                              if (disabled) return;
                              setRoleChoice(m.role, col.key);
                            }}
                            title={tooltip}
                            className={`accent-green-600 ${
                              disabled ? 'cursor-not-allowed opacity-30' : 'cursor-pointer'
                            }`}
                          />
                        </td>
                      );
                    })}
                    <td className="text-center py-1.5 px-2">
                      <input
                        type="radio"
                        name={`rt-${m.role}`}
                        disabled={readOnlyRoles}
                        checked={current === 'off'}
                        onChange={() => {
                          if (readOnlyRoles) return;
                          setRoleChoice(m.role, 'off');
                        }}
                        title={`Disable ${m.mode} on this sidecar`}
                        className={`accent-gray-400 ${
                          readOnlyRoles ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'
                        }`}
                      />
                    </td>
                    <td className="py-1.5 pl-2 text-right">
                      <span
                        className="text-gray-300 text-sm leading-none px-1"
                        title="Advanced per-role settings — coming soon. Use the master's /admin/roleassign for now."
                      >
                        ⚙
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* VRAM budget — sidecar-specific */}
        <div className="mt-5 flex items-center gap-3">
          <label className="text-sm text-slate-700">Ollama VRAM budget (MB):</label>
          <input
            type="number"
            min={0}
            step={512}
            value={budgetMb}
            disabled={readOnlyRoles}
            onChange={(e) => setBudgetMb(parseInt(e.target.value || '0', 10) || 0)}
            className="w-28 rounded border border-slate-300 px-2 py-1 text-sm disabled:bg-slate-50 disabled:text-slate-400"
          />
          <span className="text-xs text-slate-500">
            0 = unknown (planner falls back to per-role declared VRAM). 24 GB Mac → ~16384.
          </span>
        </div>

        {/* Save */}
        {!readOnlyRoles && (
          <div className="mt-5 flex items-center justify-end gap-3">
            <button
              onClick={saveBackend}
              disabled={savingBackend}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {savingBackend ? 'Saving...' : 'Save & Apply'}
            </button>
          </div>
        )}

        {/* Install hints */}
        <details className="mt-5 rounded border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">
            Install instructions for {installHints.ollama.label}
          </summary>
          <div className="mt-2 space-y-2">
            <div className="text-xs font-semibold text-slate-600">Native Ollama</div>
            <CodeBlock>{installHints.ollama.steps.join('\n')}</CodeBlock>
            <div className="text-xs font-semibold text-slate-600">{installHints.dmr.label}</div>
            <CodeBlock>{installHints.dmr.steps.join('\n')}</CodeBlock>
          </div>
        </details>
      </section>

      {/* ── Section 3: Health ─────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-slate-800">3. Backend health</h2>
        <p className="mt-1 text-xs text-slate-500">
          Live probe — updated by the sidecar watchdog every 15s.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {hostOllama.enabled
            ? healthBadge(hostOllama.lastHealth, `Ollama @ ${hostOllama.host}`)
            : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                Ollama: disabled
              </span>
            )}
          {dmr.enabled
            ? healthBadge(dmr.lastHealth, `DMR @ ${dmr.host}:${dmr.port}`)
            : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                DMR: disabled
              </span>
            )}
        </div>
      </section>

      <p className="text-center text-xs text-slate-400">
        Sidecar at <code className="rounded bg-slate-100 px-1">localhost:8098</code>.
        Selections persist to <code className="rounded bg-slate-100 px-1">config/sidecar.config.json</code>.
      </p>
    </main>
  );
}
