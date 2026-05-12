'use client';

import { useState, useEffect, useCallback } from 'react';

interface SidecarEntry {
  url: string;
  hostname: string;
  mode: 'direct' | 'websocket';
  lastSeen: string;
  status: 'connected' | 'disconnected';
  containers: string[];
  note?: string;
}

interface ContainerState {
  role: string;
  name: string;
  exists: boolean;
  status: string;
  image?: string;
  port?: number;
  vram?: number;
  type?: string;
  model?: string | null;
  config?: { image: string; model: string; port: number; vram: number; type: string; gpuOnly?: boolean };
  loadedModels?: Array<{ name: string; size: string; sizeBytes?: number; sizeVram?: number; gpuPercent?: number; processor: string; until: string }>;
  gpuReady?: boolean;
}

interface RoleInfo {
  activeRequests: number;
  idleTimerActive: boolean;
  lastAcquire: string | null;
  lastRelease: string | null;
}

/** Cached status from heartbeats — no push needed */
interface CachedStatus {
  agentUrl: string;
  hostname: string;
  version?: string;
  mode: string;
  uptime: number;
  containers: Record<string, ContainerState>;
  activeRequests: number;
  idleTimeouts: Record<string, number>;
  roles: Record<string, RoleInfo>;
  peakDemand: Record<string, number>;
  gpus: GpuInfo[];
  // VRAM accounting from sideCar/src/lib/vram-accountant.ts; absent if the
  // sidecar couldn't reach nvidia-smi or is on an old build.
  vram?: {
    totalMb: number;
    freeMb: number;
    usedMb: number;
    unattributedMb: number;
    perRole: Record<string, {
      role: string;
      runtime: 'ollama' | 'vllm' | 'utility';
      containerStatus: string;
      loaded: boolean;
      actualMb: number;
      budgetMb: number;
      priority: 'critical' | 'high' | 'normal';
      gpuOnly: boolean;
      modes: string[];
    }>;
    ts: number;
  };
  wsConnected: boolean;
  /**
   * Host-level memory/inference stats. Present for Mac sidecars (Apple Silicon
   * unified memory) and Windows Docker Desktop without an nvidia-smi helper.
   * Linux+NVIDIA sidecars usually omit this; Windows-with-helper may have both
   * `gpus[]` and `host.stats`.
   */
  host?: {
    os?: string;
    osConfidence?: string;
    dockerDesktop?: boolean;
    stats?: {
      at?: number;
      ageMs?: number;
      totalMb?: number;
      freeMb?: number;
      usedMb?: number;
      pressurePct?: number;
      source?: string;
    };
    inferenceMemory?: {
      usedMb?: number;
      budgetMb?: number;
      freeMb?: number;
      source?: string;
      models?: Array<{ name: string; sizeVramMb?: number; processor?: string; gpuPercent?: number }>;
    };
  };
  /**
   * List of masters this sidecar is currently registered with. Populated by
   * the multi-master sidecar (>=v?). Older sidecars omit this field — UI
   * should treat absent/length<=1 as "exclusive to this Sound Suite master".
   */
  masters?: Array<{
    serverUrl: string;
    connectionMode: 'websocket' | 'http' | 'disconnected';
    lastHeartbeatAt?: number;
    lastSeenServerVersion?: string;
  }>;
  /** Sidecar's timestamp of the last config push from ANY master. */
  lastConfigPushAt?: number;
  /** Wall-clock timestamp of the last config push from THIS Sound Suite master. */
  selfLastConfigPushAt?: number;
  tasks?: Array<{
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
  }>;
  lastSeen: number;
}

interface GpuInfo {
  index: number;
  name: string;
  memoryTotal: number;
  memoryUsed: number;
  memoryFree: number;
  temperature: number;
}

interface FleetSidecar extends SidecarEntry {
  sidecarStatus?: CachedStatus;
}

interface FleetData {
  sidecars: FleetSidecar[];
  wsRelayPort: number;
  connectedViaWs: number;
  idleTimeouts: { embedding: number; completion: number; ocr: number; reranker: number };
  minOnline: { embedding: number; completion: number; ocr: number; reranker: number };
  peakDemand: { embedding: number; completion: number; ocr: number; reranker: number };
  sidecarTimeoutOverrides?: Record<string, Record<string, number>>;
  gpuMode: string;
  gpuAutoManage: boolean;
  masterUrl?: string;
  latestBuildVersion: string | null;
}

const ROLES = ['embedding', 'completion', 'ocr', 'reranker'] as const;

type LoadedModel = NonNullable<ContainerState['loadedModels']>[number];

function formatVramGB(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0.0 GB';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Parse Ollama-style "until" timestamp into compact relative ("24h", "5m", "now"). */
function formatRelativeUntil(until?: string): string {
  if (!until) return '';
  const target = Date.parse(until);
  if (Number.isNaN(target)) {
    // Ollama sometimes returns "Forever" or other strings — fall through.
    if (typeof until === 'string' && until.toLowerCase().includes('forever')) return 'forever';
    return '';
  }
  const ms = target - Date.now();
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/** Compact processor tag — bold red when CPU (operationally critical). */
function ProcessorTag({ m }: { m: LoadedModel }) {
  const proc = (m.processor || '').toUpperCase();
  const pct = m.gpuPercent;
  if (proc === 'CPU' || pct === 0) {
    return <span className="font-semibold text-red-700">{pct ?? 0}% CPU</span>;
  }
  if (proc === 'GPU' && (pct === undefined || pct >= 99)) {
    return <span className="text-green-700">{pct ?? 100}% GPU</span>;
  }
  if (pct !== undefined && pct > 0 && pct < 99) {
    return <span className="font-semibold text-amber-700">{pct}% {proc || 'MIXED'}</span>;
  }
  // DMR / unknown
  return <span className="text-slate-500">{proc || '—'}</span>;
}

/** Render the PS column for a single container row. */
function renderPsCell(c: ContainerState): React.ReactNode {
  const type = c.type || c.config?.type;
  // vLLM has no /api/ps equivalent.
  if (type === 'vllm') {
    return (
      <span className="text-gray-400" title="vLLM does not expose per-model VRAM via /api/ps">—</span>
    );
  }
  if (type !== 'ollama' && type !== 'dmr') {
    return <span className="text-gray-300">—</span>;
  }
  if (c.status !== 'running') return <span className="text-gray-300">—</span>;
  const allLoaded = (c.loadedModels ?? []).slice().sort((a, b) => (b.sizeVram || 0) - (a.sizeVram || 0));

  // Host-Ollama runtimes: ALL host-runtime roles share ONE Ollama process
  // (host.docker.internal:11434). Each role's `ollamaPs` therefore returns
  // the SAME list of models — every loaded model. If we render the full
  // list under every role row, three rows show identical content, which
  // makes the per-role attribution unreadable.
  //
  // Filter to just the model(s) whose name matches THIS role's def.model.
  // Other rows' models will appear on their own rows. Use loose matching
  // because Ollama appends `:latest` and other tags inconsistently.
  const isHostOllama = c.image === 'host-ollama';
  const roleModel = c.config?.model;
  let models = allLoaded;
  let filtered = false;
  if (isHostOllama && roleModel) {
    const base = roleModel.split(':')[0];
    models = allLoaded.filter(m => m.name === roleModel || m.name.startsWith(`${base}:`) || m.name.includes(base));
    filtered = models.length < allLoaded.length;
  }

  if (models.length === 0) {
    const gpuOnly = c.config?.gpuOnly === true;
    const otherLoaded = allLoaded.length > 0;
    return (
      <div className={`flex items-center gap-1 text-[11px] ${gpuOnly ? 'text-red-700' : 'text-orange-600'}`}>
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${gpuOnly ? 'bg-red-600' : 'bg-orange-400'}`} />
        {gpuOnly ? 'not loaded (GPU required)' : otherLoaded ? `not loaded (${allLoaded.length} other model${allLoaded.length === 1 ? '' : 's'} on shared Ollama)` : 'not loaded'}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {models.map(m => {
        const rel = formatRelativeUntil(m.until);
        return (
          <div key={m.name} className="flex items-center gap-2 whitespace-nowrap">
            <span className="font-mono text-[11px] text-slate-800">{m.name}</span>
            <span className="text-[11px] text-slate-600">{formatVramGB(m.sizeVram || m.sizeBytes)}</span>
            <ProcessorTag m={m} />
            {rel && <span className="text-[10px] text-slate-400">until {rel}</span>}
          </div>
        );
      })}
      {filtered && (
        <div className="text-[10px] text-slate-400" title="Host-Ollama serves multiple roles from one process; other roles' models appear on their rows.">
          + {allLoaded.length - models.length} other model{allLoaded.length - models.length === 1 ? '' : 's'} on shared Ollama
        </div>
      )}
    </div>
  );
}

/** One-line summary of all models loaded across the sidecar's Ollama/DMR endpoints. */
function PsSummaryLine({ containers }: { containers: Record<string, ContainerState> }) {
  const all: LoadedModel[] = [];
  let anyOllama = false;
  const runningVllm: string[] = [];
  // Host-Ollama runtimes share one endpoint — every role sees the same
  // loadedModels list. Deduplicate by model name so we don't triple-count.
  const seen = new Set<string>();
  for (const c of Object.values(containers)) {
    const type = c.type || c.config?.type;
    if (type === 'ollama' || type === 'dmr') anyOllama = true;
    if (type === 'vllm' && c.status === 'running') runningVllm.push(c.role || c.name || 'vllm');
    if (c.loadedModels) {
      for (const m of c.loadedModels) {
        if (seen.has(m.name)) continue;
        seen.add(m.name);
        all.push(m);
      }
    }
  }
  if (!anyOllama && runningVllm.length === 0) return null;
  if (all.length === 0) {
    // vLLM holds VRAM at the container level without per-model attribution.
    // Avoid the misleading "No models loaded" when a running vLLM container
    // is actually holding tens of GB.
    if (runningVllm.length > 0) {
      return (
        <div className="mb-2 text-xs text-slate-600">
          <span className="font-semibold">{runningVllm.join(', ')}</span> running on vLLM (no per-model VRAM attribution available — see VRAM panel below for device totals)
        </div>
      );
    }
    return <div className="mb-2 text-xs text-slate-500">No Ollama models loaded in VRAM.</div>;
  }
  const totalVram = all.reduce((s, m) => s + (m.sizeVram || 0), 0);
  const gpuPctAvg = Math.round(
    all.reduce((s, m) => s + (m.gpuPercent ?? (m.processor === 'GPU' ? 100 : 0)), 0) / all.length
  );
  const anyCpu = all.some(m => (m.gpuPercent ?? -1) === 0 || m.processor?.toUpperCase() === 'CPU');
  return (
    <div className="mb-2 text-xs text-slate-600">
      <span className="font-semibold">{all.length}</span> model{all.length === 1 ? '' : 's'} loaded
      <span className="mx-1.5 text-slate-300">·</span>
      <span className="font-semibold">{formatVramGB(totalVram)}</span> VRAM total
      <span className="mx-1.5 text-slate-300">·</span>
      <span className={anyCpu ? 'font-semibold text-red-700' : 'text-green-700'}>{gpuPctAvg}% GPU{anyCpu ? ' (CPU FALLBACK)' : ''}</span>
    </div>
  );
}

export default function GpuFleetPanel() {
  const [fleet, setFleet] = useState<FleetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  // Track sidecars that are rebooting after an update
  const [rebootingUrls, setRebootingUrls] = useState<Map<string, { since: number; prevVersion: string }>>(new Map());

  // Add sidecar form
  const [newUrl, setNewUrl] = useState('http://');
  const [newHostname, setNewHostname] = useState('');

  // Idle timeouts
  const [idleEmbedding, setIdleEmbedding] = useState(0);
  const [idleCompletion, setIdleCompletion] = useState(10);
  const [idleOcr, setIdleOcr] = useState(5);
  const [idleReranker, setIdleReranker] = useState(5);

  // Minimum online instances
  const [minEmbedding, setMinEmbedding] = useState(0);
  const [minCompletion, setMinCompletion] = useState(0);
  const [minOcr, setMinOcr] = useState(0);
  const [minReranker, setMinReranker] = useState(0);

  // Per-sidecar idle timeout overrides
  const [sidecarTimeouts, setSidecarTimeouts] = useState<Record<string, number>>({ embedding: 0, completion: 10, ocr: 5, reranker: 5 });
  const [sidecarHasOverrides, setSidecarHasOverrides] = useState(false);

  // GPU orchestrator settings
  const [gpuAutoManage, setGpuAutoManage] = useState(false);

  // Master URL — what the sidecar should phone home to
  const [masterUrl, setMasterUrl] = useState('');
  const [masterUrlDirty, setMasterUrlDirty] = useState(false);

  // Action feedback
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Communication logs
  const [commLogs, setCommLogs] = useState<Array<{ ts: number; level: string; component: string; message: string; meta?: Record<string, any> }>>([]);
  const [showCommLogs, setShowCommLogs] = useState(false);

  const fetchFleet = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/gpu-fleet');
      if (!res.ok) throw new Error('Failed to fetch fleet status');
      const data: FleetData = await res.json();
      setFleet(data);
      setIdleEmbedding(data.idleTimeouts.embedding);
      setIdleCompletion(data.idleTimeouts.completion);
      setIdleOcr(data.idleTimeouts.ocr);
      setIdleReranker(data.idleTimeouts.reranker);
      if (data.minOnline) {
        setMinEmbedding(data.minOnline.embedding);
        setMinCompletion(data.minOnline.completion);
        setMinOcr(data.minOnline.ocr);
        setMinReranker(data.minOnline.reranker);
      }
      setGpuAutoManage(data.gpuAutoManage);
      if (!masterUrlDirty) setMasterUrl(data.masterUrl ?? '');
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchCommLogs = useCallback(async () => {
    if (!showCommLogs) return;
    try {
      const res = await fetch('/api/admin/gpu-fleet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logs', limit: 100 }),
      });
      if (res.ok) {
        const data = await res.json();
        setCommLogs(data.logs || []);
      }
    } catch { /* ignore */ }
  }, [showCommLogs]);

  useEffect(() => {
    fetchFleet();
    const interval = setInterval(fetchFleet, 5_000);
    return () => clearInterval(interval);
  }, [fetchFleet]);

  useEffect(() => {
    if (showCommLogs) {
      fetchCommLogs();
      const interval = setInterval(fetchCommLogs, 3_000);
      return () => clearInterval(interval);
    }
  }, [showCommLogs, fetchCommLogs]);

  const doAction = async (action: string, body: Record<string, any>) => {
    setActionLoading(action);
    setActionMsg(null);
    try {
      const res = await fetch('/api/admin/gpu-fleet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Action failed');
      return data;
    } catch (e: any) {
      setActionMsg({ type: 'error', text: e.message });
      return null;
    } finally {
      setActionLoading(null);
    }
  };

  const handleAdd = async () => {
    if (!newUrl || newUrl === 'http://') return;
    const result = await doAction('add', { url: newUrl, hostname: newHostname || undefined });
    if (result) {
      setActionMsg({ type: 'success', text: `Added sidecar ${result.hostname || result.url}` });
      setNewUrl('http://');
      setNewHostname('');
      fetchFleet();
    }
  };

  const handleRemove = async (url: string) => {
    const result = await doAction('remove', { url });
    if (result) {
      setActionMsg({ type: 'success', text: 'Sidecar removed' });
      if (selectedUrl === url) { setSelectedUrl(null); }
      fetchFleet();
    }
  };



  const handleControlRole = async (url: string, action: 'start' | 'stop' | 'pullModel' | 'loadModel', role: string) => {
    setPendingAction(`${action}-${role}`);
    const result = await doAction(action, { url, role });
    if (result) {
      setActionMsg({ type: 'success', text: `${role}: ${result.message || result.status || action + ' sent'}` });
      // Refresh fleet after a delay to pick up new container state from heartbeat
      setTimeout(fetchFleet, 3000);
    }
    setPendingAction(null);
  };

  const handleModeSwitch = async (url: string, mode: string) => {
    setPendingAction(`mode-${mode}`);
    const result = await doAction('mode', { url, mode });
    if (result) {
      setActionMsg({ type: 'success', text: `Mode switched to ${mode}` });
      setTimeout(fetchFleet, 3000);
    }
    setPendingAction(null);
  };

  const handleProvision = async (url: string) => {
    setPendingAction('provision');
    setActionMsg({ type: 'success', text: 'Provisioning started... This may take several minutes.' });
    const result = await doAction('provision', { url });
    if (result) {
      const summary = Object.entries(result).map(([role, r]: any) =>
        `${role}: img=${r.image}, ctr=${r.container}, model=${r.model}`
      ).join('; ');
      setActionMsg({ type: 'success', text: `Provision complete: ${summary}` });
      setTimeout(fetchFleet, 3000);
    }
    setPendingAction(null);
  };

  const handleUpdate = async (url: string) => {
    const sidecar = fleet?.sidecars.find(s => s.url === url);
    const prevVersion = sidecar?.sidecarStatus?.version || 'unknown';
    setPendingAction('update');
    setActionMsg({ type: 'success', text: 'Sending update command... Sidecar will download, extract, and restart.' });
    const result = await doAction('update', { url });
    if (result) {
      // Mark as rebooting — auto-refresh will detect when it comes back with new version
      setRebootingUrls(prev => {
        const next = new Map(prev);
        next.set(url, { since: Date.now(), prevVersion });
        return next;
      });
      setActionMsg({ type: 'success', text: 'Update initiated. Waiting for sidecar to reboot...' });
    }
    setPendingAction(null);
  };

  // Auto-clear rebooting state when sidecar reconnects with a different version
  useEffect(() => {
    if (rebootingUrls.size === 0 || !fleet) return;
    setRebootingUrls(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const [url, info] of prev) {
        const sidecar = fleet.sidecars.find(s => s.url === url);
        const currentVersion = sidecar?.sidecarStatus?.version;
        // Cleared if: new version appeared, or timed out after 5 minutes
        if ((currentVersion && currentVersion !== info.prevVersion) || (Date.now() - info.since > 300_000)) {
          next.delete(url);
          changed = true;
          if (currentVersion && currentVersion !== info.prevVersion) {
            setActionMsg({ type: 'success', text: `Sidecar updated: ${info.prevVersion} -> ${currentVersion}` });
          }
        }
      }
      return changed ? next : prev;
    });
  }, [fleet, rebootingUrls]);

  const handleSaveTimeouts = async () => {
    const saved = await doAction('saveTimeouts', {
      gpuIdleEmbeddingMin: idleEmbedding,
      gpuIdleCompletionMin: idleCompletion,
      gpuIdleOcrMin: idleOcr,
      gpuIdleRerankerMin: idleReranker,
    });
    if (!saved) return;
    const connected = fleet?.sidecars.filter(s => s.status === 'connected') || [];
    let pushed = 0;
    for (const s of connected) {
      const r = await doAction('config', {
        url: s.url,
        idleTimeouts: { embedding: idleEmbedding, completion: idleCompletion, ocr: idleOcr, reranker: idleReranker },
      });
      if (r) pushed++;
    }
    setActionMsg({ type: 'success', text: `Timeouts saved. Pushed to ${pushed}/${connected.length} sidecar(s).` });
  };

  const handleSaveMinOnline = async () => {
    const saved = await doAction('saveMinOnline', {
      gpuMinEmbedding: minEmbedding,
      gpuMinCompletion: minCompletion,
      gpuMinOcr: minOcr,
      gpuMinReranker: minReranker,
    });
    if (saved) {
      setActionMsg({ type: 'success', text: 'Minimum online settings saved. Enforcement runs every 30s.' });
    }
  };

  const handleSaveMasterUrl = async () => {
    const value = masterUrl.trim();
    const saved = await doAction('saveMasterUrl', { masterUrl: value });
    if (saved) {
      setMasterUrlDirty(false);
      setActionMsg({ type: 'success', text: value
        ? `Master URL saved and pushed to ${fleet?.sidecars.filter(s => s.status === 'connected').length ?? 0} connected sidecar(s).`
        : 'Master URL cleared. Sidecars will rely on the SOUND_SUITE_MASTER_URL env var.' });
    }
  };

  const handleToggleAutoManage = async () => {
    const newVal = !gpuAutoManage;
    setGpuAutoManage(newVal);
    await doAction('saveConfig', {
      gpuAutoManage: newVal,
      embeddingUseOrchestrator: newVal,
      completionUseOrchestrator: newVal,
      ocrUseOrchestrator: newVal,
      rerankUseOrchestrator: newVal,
    });
    setActionMsg({ type: 'success', text: `Auto-manage ${newVal ? 'enabled' : 'disabled'} (all per-role orchestrator toggles ${newVal ? 'ON' : 'OFF'})` });
  };

  const handleSyncModels = async () => {
    const result = await doAction('syncModels', {});
    if (result?.pushed) {
      const entries = Object.entries(result.pushed as Record<string, { ok: boolean; error?: string }>);
      const ok = entries.filter(([, r]) => r.ok).length;
      const fail = entries.filter(([, r]) => !r.ok).length;
      setActionMsg({
        type: fail > 0 ? 'error' : 'success',
        text: `Models synced to ${ok}/${entries.length} sidecar(s)${fail > 0 ? ` (${fail} failed)` : ''}.`,
      });
    } else if (result) {
      setActionMsg({ type: 'success', text: 'Model registry pushed.' });
    }
  };

  const selectedSidecar = fleet?.sidecars.find(s => s.url === selectedUrl);
  const cachedStatus = selectedSidecar?.sidecarStatus;
  const detailGpus = cachedStatus?.gpus || [];

  // Populate per-sidecar timeout inputs when selection changes
  useEffect(() => {
    if (!selectedUrl || !fleet) return;
    const overrides = fleet.sidecarTimeoutOverrides?.[selectedUrl];
    if (overrides && Object.keys(overrides).length > 0) {
      setSidecarTimeouts({
        embedding: overrides.embedding ?? fleet.idleTimeouts.embedding,
        completion: overrides.completion ?? fleet.idleTimeouts.completion,
        ocr: overrides.ocr ?? fleet.idleTimeouts.ocr,
        reranker: overrides.reranker ?? fleet.idleTimeouts.reranker,
      });
      setSidecarHasOverrides(true);
    } else {
      setSidecarTimeouts({
        embedding: fleet.idleTimeouts.embedding,
        completion: fleet.idleTimeouts.completion,
        ocr: fleet.idleTimeouts.ocr,
        reranker: fleet.idleTimeouts.reranker,
      });
      setSidecarHasOverrides(false);
    }
  }, [selectedUrl, fleet]);

  const handleSaveSidecarTimeouts = async () => {
    if (!selectedUrl) return;
    const result = await doAction('saveSidecarTimeouts', { url: selectedUrl, timeouts: sidecarTimeouts });
    if (result) {
      setSidecarHasOverrides(true);
      setActionMsg({ type: 'success', text: 'Per-sidecar timeouts saved and pushed.' });
      fetchFleet();
    }
  };

  const handleClearSidecarTimeouts = async () => {
    if (!selectedUrl) return;
    const result = await doAction('clearSidecarTimeouts', { url: selectedUrl });
    if (result) {
      setSidecarHasOverrides(false);
      setActionMsg({ type: 'success', text: 'Sidecar timeouts reset to global defaults.' });
      fetchFleet();
    }
  };

  const formatUptime = (s: number) => {
    const mins = Math.floor(s / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  const formatTimeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  if (loading) return <div className="text-gray-500 py-8 text-center">Loading GPU fleet status...</div>;
  if (error) return (
    <div className="bg-red-50 text-red-800 border border-red-200 rounded-md p-4">
      {error}
      <button onClick={fetchFleet} className="ml-4 text-sm underline">Retry</button>
    </div>
  );

  return (
    <div className="space-y-6">
      {actionMsg && (
        <div className={`p-3 rounded-md text-sm ${
          actionMsg.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'
        }`}>{actionMsg.text}</div>
      )}

      {/* Section 1: Sidecar Fleet */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Sidecar Fleet</h2>
          <button onClick={fetchFleet} className="text-sm text-blue-600 hover:text-blue-800">Refresh</button>
        </div>

        {fleet && fleet.sidecars.length === 0 ? (
          <p className="text-gray-500 text-sm py-4">No sidecars registered. Add one below.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Hostname</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">URL</th>
                  {/* Legacy "Mode" column (indexing/searching) removed —
                      per-host roles are now managed via /admin/roleassign tags. */}
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Conn</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Status</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Last Seen</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Note</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody>
                {fleet?.sidecars.map((s) => (
                  <tr key={s.url} onClick={() => setSelectedUrl(s.url === selectedUrl ? null : s.url)}
                    className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${s.url === selectedUrl ? 'bg-blue-50' : ''}`}>
                    <td className="py-2 px-3 font-medium text-gray-900">
                      {s.hostname}
                      {s.sidecarStatus?.version && (
                        <span className="ml-2 text-xs text-gray-400">v{s.sidecarStatus.version}</span>
                      )}
                      <RoleBadges sidecarUrl={s.url} hostOs={s.sidecarStatus?.host?.os} />

                      {(() => {
                        const others = (s.sidecarStatus?.masters || [])
                          .filter(m => !fleet?.masterUrl || m.serverUrl !== fleet.masterUrl);
                        if (others.length === 0) return null;
                        const tooltip = `Sidecar also serves: ${others.map(m => `${m.serverUrl} (${m.connectionMode})`).join(', ')}`;
                        return (
                          <span
                            title={tooltip}
                            className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-100 text-orange-800"
                          >shared ×{others.length + 1}</span>
                        );
                      })()}
                      {(() => {
                        // Multi-master shared-policy override warning. Sidecar v1
                        // keeps idleTimeouts/minOnline/registry as last-writer-wins
                        // shared state; flag when another master pushed after we did.
                        const status = s.sidecarStatus;
                        if (!status?.masters || status.masters.length <= 1) return null;
                        const last = status.lastConfigPushAt;
                        const selfLast = status.selfLastConfigPushAt;
                        if (!last || !selfLast) return null;
                        // 1s tolerance for clock skew between Sound Suite and the sidecar.
                        if (last <= selfLast + 1000) return null;
                        const ageSec = Math.max(0, Math.round((Date.now() - last) / 1000));
                        return (
                          <span
                            title={`Another master pushed config ${ageSec}s ago, after Sound Suite's last push. Shared sidecar policies (idle timeouts, minOnline, model registry) follow last-writer-wins in v1.`}
                            className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-800"
                          >policy overridden</span>
                        );
                      })()}
                    </td>
                    <td className="py-2 px-3 font-mono text-xs text-gray-600">{s.url}</td>
                    <td className="py-2 px-3">
                      {/* Connection mode (WS/direct) — operational mode pill removed. */}
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        s.mode === 'websocket' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'
                      }`}>{s.mode === 'websocket' ? 'WS' : s.mode}</span>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        s.sidecarStatus?.wsConnected ? 'bg-green-100 text-green-800'
                          : s.status === 'connected' ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-red-100 text-red-800'
                      }`}>{rebootingUrls.has(s.url) ? 'rebooting...' : s.sidecarStatus?.wsConnected ? 'live' : s.status}</span>
                    </td>
                    <td className="py-2 px-3 text-gray-600">{formatTimeAgo(s.lastSeen)}</td>
                    <td className="py-2 px-3" onClick={(e) => e.stopPropagation()}>
                      <InlineNoteEditor url={s.url} note={s.note || ''} onSave={async (note) => {
                        await doAction('updateNote', { url: s.url, note });
                        fetchFleet();
                      }} />
                    </td>
                    <td className="py-2 px-3 text-right space-x-2">
                      {s.sidecarStatus && (
                        <span className="text-xs text-gray-400 mr-2">
                          {Object.values(s.sidecarStatus.containers || {}).filter(c => c.status === 'running').length} running
                        </span>
                      )}
                      <button onClick={(e) => { e.stopPropagation(); handleRemove(s.url); }} disabled={actionLoading !== null}
                        className="text-xs px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-700 disabled:opacity-50">Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add Sidecar Form */}
        <div className="mt-4 pt-4 border-t border-gray-200">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Add Sidecar</h3>
          <div className="flex gap-2">
            <input type="text" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="http://10.10.20.5:8098"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <input type="text" value={newHostname} onChange={(e) => setNewHostname(e.target.value)} placeholder="Hostname (optional)"
              className="w-40 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button onClick={handleAdd} disabled={actionLoading !== null || newUrl === 'http://'}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50">Add</button>
          </div>
        </div>
      </div>

      {/* Section 2: Sidecar Detail */}
      {selectedSidecar && (
        <div className="bg-white shadow rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-900">
              {selectedSidecar.hostname}
              <span className="ml-2 text-sm font-normal text-gray-500">{selectedSidecar.url}</span>
              {cachedStatus?.wsConnected && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">WS Live</span>
              )}
            </h2>
            <div className="flex gap-2">
              {/* Update button — show when version differs from latest build */}
              {fleet?.latestBuildVersion && cachedStatus?.version && cachedStatus.version !== fleet.latestBuildVersion && !rebootingUrls.has(selectedSidecar.url) && (
                <button onClick={() => handleUpdate(selectedSidecar.url)} disabled={actionLoading !== null || pendingAction !== null}
                  className="text-sm px-3 py-1 rounded bg-blue-100 hover:bg-blue-200 text-blue-800 disabled:opacity-50">
                  {pendingAction === 'update' ? 'Updating...' : `Update to v${fleet.latestBuildVersion}`}
                </button>
              )}
              {/* Rebooting indicator */}
              {rebootingUrls.has(selectedSidecar.url) && (
                <span className="text-sm px-3 py-1 rounded bg-yellow-100 text-yellow-800 animate-pulse">
                  Rebooting... waiting for reconnect
                </span>
              )}
              <button onClick={() => handleProvision(selectedSidecar.url)} disabled={actionLoading !== null || pendingAction === 'provision'}
                className="text-sm px-3 py-1 rounded bg-amber-100 hover:bg-amber-200 text-amber-800 disabled:opacity-50">
                {pendingAction === 'provision' ? 'Provisioning...' : 'Provision'}
              </button>
            </div>
          </div>

          {!cachedStatus ? (
            <div className="text-gray-500 text-sm py-4">
              Waiting for heartbeat from sidecar... Status will appear automatically once the sidecar connects.
            </div>
          ) : (
            <>
              {/* Stats Grid — "Sidecar Mode" card removed (legacy indexing/searching) */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatCard label="Active Requests" value={String(cachedStatus.activeRequests ?? 0)} color="blue" />
                <StatCard label="Agent Uptime" value={cachedStatus.uptime ? formatUptime(cachedStatus.uptime) : '-'} color="purple" />
                <StatCard label="Version" value={cachedStatus.version || '1.x'} color="gray" />
                <StatCard label="Total Memory" value={(() => {
                  if (detailGpus.length > 0) {
                    const totalMb = detailGpus.reduce((s, g) => s + g.memoryTotal, 0);
                    return `${(totalMb / 1024).toFixed(1)} GB VRAM`;
                  }
                  const totalMb = cachedStatus.host?.stats?.totalMb;
                  if (totalMb) return `${(totalMb / 1024).toFixed(1)} GB RAM`;
                  const budgetMb = cachedStatus.host?.inferenceMemory?.budgetMb;
                  if (budgetMb) return `${(budgetMb / 1024).toFixed(1)} GB budget`;
                  return '-';
                })()} color="purple" />
              </div>

              {/* Host memory panel — shows for Mac/Windows-no-helper, and as a
                  supplement for Windows-with-helper to surface host RAM. */}
              <HostMemoryPanel cached={cachedStatus} />

              {/* GPU Topology */}
              {detailGpus.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">GPU Topology</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {detailGpus.map((gpu) => (
                      <GpuCard key={gpu.index} gpu={gpu} />
                    ))}
                  </div>
                </div>
              )}

              {/* Legacy "Mode (Single-GPU)" toggle removed — superseded by
                  per-host tag assignment at /admin/roleassign. Roles can now
                  be enabled per-host independently regardless of "mode". */}

              {/* VRAM accountant — what's actually loaded right now */}
              {cachedStatus.vram && cachedStatus.vram.totalMb > 0 && (() => {
                const v = cachedStatus.vram;
                const usedGb = (v.usedMb / 1024).toFixed(1);
                const totalGb = (v.totalMb / 1024).toFixed(1);
                const pct = Math.round((v.usedMb / v.totalMb) * 100);
                const tight = pct >= 85;
                const barColor = tight ? 'bg-red-500' : pct >= 65 ? 'bg-orange-400' : 'bg-emerald-500';
                const loadedRoles = Object.values(v.perRole).filter(r => r.loaded);
                return (
                  <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-gray-700">GPU VRAM</h3>
                      <span className={`text-xs font-mono ${tight ? 'text-red-700 font-semibold' : 'text-gray-600'}`}>
                        {usedGb} / {totalGb} GB ({pct}%)
                        {v.unattributedMb > 200 && ` · ${(v.unattributedMb / 1024).toFixed(1)} GB unattributed`}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded bg-gray-200 overflow-hidden">
                      <div className={`h-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    {loadedRoles.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                        {loadedRoles.map(r => {
                          const tag = r.priority === 'critical' ? 'border-red-300 bg-red-50 text-red-700'
                            : r.priority === 'high' ? 'border-blue-300 bg-blue-50 text-blue-700'
                            : 'border-gray-300 bg-white text-gray-600';
                          return (
                            <span key={r.role} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono ${tag}`}>
                              <span className="capitalize">{r.role}</span>
                              <span className="text-gray-400">{(r.actualMb / 1024).toFixed(1)}GB</span>
                              {r.gpuOnly && <span title="GPU-only" className="text-red-600 font-bold">GPU</span>}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Container Grid */}
              {cachedStatus.containers && Object.keys(cachedStatus.containers).length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Containers</h3>
                  <PsSummaryLine containers={cachedStatus.containers} />
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-200">
                          <th className="text-left py-2 px-3 font-medium text-gray-600">Role</th>
                          <th className="text-left py-2 px-3 font-medium text-gray-600">Container</th>
                          <th className="text-left py-2 px-3 font-medium text-gray-600">Status</th>
                          <th className="text-left py-2 px-3 font-medium text-gray-600">Image</th>
                          <th className="text-left py-2 px-3 font-medium text-gray-600">Model</th>
                          <th className="text-left py-2 px-3 font-medium text-gray-600">PS</th>
                          <th className="text-left py-2 px-3 font-medium text-gray-600">VRAM</th>
                          <th className="text-left py-2 px-3 font-medium text-gray-600">Requests</th>
                          <th className="text-right py-2 px-3 font-medium text-gray-600">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(cachedStatus.containers).map(([role, c]) => {
                          const roleInfo = cachedStatus.roles?.[role];
                          const isPending = pendingAction === `start-${role}` || pendingAction === `stop-${role}`;
                          return (
                            <tr key={role} className="border-b border-gray-100">
                              <td className="py-2 px-3 font-medium text-gray-900 capitalize">{role}</td>
                              <td className="py-2 px-3 font-mono text-xs text-gray-600">{c.name || '-'}</td>
                              <td className="py-2 px-3">
                                {isPending ? (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 animate-pulse">
                                    {pendingAction?.startsWith('start') ? 'starting...' : 'stopping...'}
                                  </span>
                                ) : (
                                  <ContainerStatusBadge status={c.status} exists={c.exists} />
                                )}
                              </td>
                              <td className="py-2 px-3 text-xs text-gray-500">{c.image || c.config?.image || '-'}</td>
                              <td className="py-2 px-3 text-xs text-gray-500 font-mono">
                                {c.model || c.config?.model || <span className="text-gray-300 italic">none</span>}
                              </td>
                              <td className="py-2 px-3 text-xs font-mono">
                                {renderPsCell(c)}
                              </td>
                              <td className="py-2 px-3 text-xs font-mono">{c.vram ? `${c.vram} MB` : c.config?.vram ? `${c.config.vram} MB` : '-'}</td>
                              <td className="py-2 px-3 text-xs">{roleInfo?.activeRequests ?? '-'}</td>
                              <td className="py-2 px-3 text-right space-x-1">
                                <button onClick={() => handleControlRole(selectedSidecar.url, 'start', role)}
                                  disabled={actionLoading !== null || pendingAction !== null}
                                  className="text-xs px-2 py-1 rounded bg-green-50 hover:bg-green-100 text-green-700 disabled:opacity-50">Start</button>
                                <button onClick={() => handleControlRole(selectedSidecar.url, 'stop', role)}
                                  disabled={actionLoading !== null || pendingAction !== null}
                                  className="text-xs px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-700 disabled:opacity-50">Stop</button>
                                {(c.type === 'ollama' || c.config?.type === 'ollama') && (
                                  <>
                                    <button onClick={() => handleControlRole(selectedSidecar.url, 'pullModel', role)}
                                      disabled={actionLoading !== null || pendingAction !== null}
                                      className="text-xs px-2 py-1 rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700 disabled:opacity-50">
                                      {pendingAction === `pullModel-${role}` ? 'Pulling...' : 'Pull & Load'}
                                    </button>
                                    {c.status === 'running' && (!c.loadedModels || c.loadedModels.length === 0) && (
                                      <button onClick={() => handleControlRole(selectedSidecar.url, 'loadModel', role)}
                                        disabled={actionLoading !== null || pendingAction !== null}
                                        className="text-xs px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-700 disabled:opacity-50">
                                        {pendingAction === `loadModel-${role}` ? 'Loading...' : 'Load'}
                                      </button>
                                    )}
                                  </>
                                )}
                                {(c.type === 'vllm' || c.config?.type === 'vllm') && (
                                  <>
                                    <button onClick={() => handleControlRole(selectedSidecar.url, 'pullModel', role)}
                                      disabled={actionLoading !== null || pendingAction !== null}
                                      title="Pull docker image + start container. vLLM downloads the HuggingFace model on first request (cached in huggingface-cache volume afterwards)."
                                      className="text-xs px-2 py-1 rounded bg-indigo-50 hover:bg-indigo-100 text-indigo-700 disabled:opacity-50">
                                      {pendingAction === `pullModel-${role}` ? 'Pulling...' : 'Pull & Start'}
                                    </button>
                                    {c.status !== 'running' && (
                                      <button onClick={() => handleControlRole(selectedSidecar.url, 'loadModel', role)}
                                        disabled={actionLoading !== null || pendingAction !== null}
                                        title="Start the container. vLLM will load the model into VRAM at startup."
                                        className="text-xs px-2 py-1 rounded bg-amber-50 hover:bg-amber-100 text-amber-700 disabled:opacity-50">
                                        {pendingAction === `loadModel-${role}` ? 'Loading...' : 'Load'}
                                      </button>
                                    )}
                                  </>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Active Tasks */}
              {cachedStatus.tasks && cachedStatus.tasks.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Tasks</h3>
                  <div className="space-y-2">
                    {cachedStatus.tasks.map((task) => (
                      <div key={task.id} className={`flex items-center gap-3 p-2 rounded-md text-sm ${
                        task.status === 'running' ? 'bg-blue-50' : task.status === 'completed' ? 'bg-green-50' : 'bg-red-50'
                      }`}>
                        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                          task.status === 'running' ? 'bg-blue-500 animate-pulse' : task.status === 'completed' ? 'bg-green-500' : 'bg-red-500'
                        }`} />
                        <span className="font-medium text-gray-800 min-w-0 truncate">{task.label}</span>
                        {task.role && <span className="text-xs text-gray-500 capitalize flex-shrink-0">{task.role}</span>}
                        {task.status === 'running' && (
                          <div className="flex-1 max-w-[200px]">
                            <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
                              {task.progress !== undefined ? (
                                <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${task.progress}%` }} />
                              ) : (
                                <div className="h-full w-1/3 rounded-full bg-blue-400 animate-pulse" />
                              )}
                            </div>
                          </div>
                        )}
                        {task.progress !== undefined && task.status === 'running' && (
                          <span className="text-xs text-gray-500 flex-shrink-0">{task.progress}%</span>
                        )}
                        {task.detail && task.status === 'running' && (
                          <span className="text-xs text-gray-400 truncate max-w-[150px]">{task.detail}</span>
                        )}
                        {task.error && (
                          <span className="text-xs text-red-600 truncate max-w-[200px]">{task.error}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Per-Sidecar Idle Timeout Overrides */}
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-gray-700">
                    Idle Timeouts {sidecarHasOverrides ? <span className="text-xs text-indigo-600 ml-1">(custom)</span> : <span className="text-xs text-gray-400 ml-1">(global defaults)</span>}
                  </h3>
                  {sidecarHasOverrides && (
                    <button onClick={handleClearSidecarTimeouts} disabled={actionLoading !== null}
                      className="text-xs px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 text-gray-600 disabled:opacity-50">
                      Reset to Global
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                  {ROLES.map((role) => (
                    <div key={role}>
                      <label className="block text-xs text-gray-500 capitalize mb-1">{role}</label>
                      <div className="flex items-center gap-1">
                        <input type="number" min={0} value={sidecarTimeouts[role] ?? 0}
                          onChange={(e) => setSidecarTimeouts(prev => ({ ...prev, [role]: parseInt(e.target.value) || 0 }))}
                          className="w-16 px-2 py-1 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                        />
                        <span className="text-xs text-gray-400">min</span>
                        {cachedStatus.idleTimeouts && (
                          <span className="text-xs text-gray-300 ml-1">
                            (active: {(cachedStatus.idleTimeouts[role] ?? 0) === 0 ? 'never' : `${Math.round((cachedStatus.idleTimeouts[role] as number) / 60_000)}m`})
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={handleSaveSidecarTimeouts} disabled={actionLoading !== null}
                  className="px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-md hover:bg-indigo-700 disabled:opacity-50">
                  {actionLoading === 'saveSidecarTimeouts' ? 'Saving...' : 'Save & Push to This Sidecar'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Section 3: Per-Model Idle Timeouts */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Per-Model Idle Timeouts</h2>
        <p className="text-sm text-gray-600 mb-4">Auto-stop containers after idle to free GPU VRAM. Set 0 to never auto-stop.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <TimeoutInput label="Embedding" value={idleEmbedding} onChange={setIdleEmbedding} hint="0 = never" />
          <TimeoutInput label="Completion" value={idleCompletion} onChange={setIdleCompletion} />
          <TimeoutInput label="OCR" value={idleOcr} onChange={setIdleOcr} />
          <TimeoutInput label="Reranker" value={idleReranker} onChange={setIdleReranker} />
        </div>
        <button onClick={handleSaveTimeouts} disabled={actionLoading !== null}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50">
          {actionLoading === 'saveTimeouts' ? 'Saving...' : 'Save & Push to All Sidecars'}
        </button>
      </div>

      {/* Section 4: Minimum Online Instances + Runtime Demand */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Minimum Online Instances</h2>
        <p className="text-sm text-gray-600 mb-4">Ensure N sidecar(s) keep each role&apos;s container running. Enforcement runs every 30s.</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
          <NumberInput label="Embedding" value={minEmbedding} onChange={setMinEmbedding} />
          <NumberInput label="Completion" value={minCompletion} onChange={setMinCompletion} />
          <NumberInput label="OCR" value={minOcr} onChange={setMinOcr} />
          <NumberInput label="Reranker" value={minReranker} onChange={setMinReranker} />
        </div>
        <button onClick={handleSaveMinOnline} disabled={actionLoading !== null}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50">
          {actionLoading === 'saveMinOnline' ? 'Saving...' : 'Save Minimum Online'}
        </button>

        {/* Runtime Demand */}
        {fleet?.peakDemand && (
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h3 className="text-sm font-medium text-gray-700 mb-3">Runtime Demand (peak 5-min window)</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {ROLES.map((role) => (
                <div key={role} className="p-3 rounded-lg border bg-gray-50 border-gray-200 text-center">
                  <div className="text-xs font-medium text-gray-500 capitalize">{role}</div>
                  <div className="text-2xl font-semibold text-gray-900 mt-1">{fleet.peakDemand[role] ?? 0}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Section 5: Fleet Settings + Connection Info */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">Fleet Settings</h2>

        {/* Master URL */}
        <div className="mb-6 p-4 bg-gray-50 rounded-lg">
          <div className="font-medium text-gray-900 text-sm mb-1">Master URL</div>
          <div className="text-xs text-gray-500 mb-3">
            The URL each sidecar uses to connect back to this master. Pushed via <code className="px-1 bg-gray-200 rounded">/config</code> on every register so sidecars persist it for warm-boot. If empty, sidecars rely on the <code className="px-1 bg-gray-200 rounded">SOUND_SUITE_MASTER_URL</code> environment variable in their <code className="px-1 bg-gray-200 rounded">docker run</code> command.
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={masterUrl}
              onChange={(e) => { setMasterUrl(e.target.value); setMasterUrlDirty(true); }}
              placeholder={typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : 'http://master:3000'}
              className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
            />
            <button onClick={handleSaveMasterUrl} disabled={!masterUrlDirty || actionLoading !== null}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
              {actionLoading === 'saveMasterUrl' ? 'Saving…' : 'Save & Push'}
            </button>
          </div>
        </div>

        {/* Auto-manage toggle */}
        <div className="flex items-center justify-between mb-6 p-4 bg-gray-50 rounded-lg">
          <div>
            <div className="font-medium text-gray-900 text-sm">Auto-Manage GPU Containers</div>
            <div className="text-xs text-gray-500 mt-0.5">
              When enabled, providers (embedding, completion, OCR, reranker) automatically resolve endpoints via the fleet router.
            </div>
          </div>
          <button onClick={handleToggleAutoManage}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              gpuAutoManage ? 'bg-blue-600' : 'bg-gray-200'
            }`}>
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              gpuAutoManage ? 'translate-x-5' : 'translate-x-0'
            }`} />
          </button>
        </div>

        {/* Sync Models */}
        <div className="flex items-center justify-between mb-6 p-4 bg-gray-50 rounded-lg">
          <div>
            <div className="font-medium text-gray-900 text-sm">Sync Models to Sidecars</div>
            <div className="text-xs text-gray-500 mt-0.5">
              Push current model names from admin settings to all connected sidecars.
            </div>
          </div>
          <button onClick={handleSyncModels} disabled={actionLoading !== null}
            className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-md hover:bg-indigo-700 disabled:opacity-50">
            {actionLoading === 'syncModels' ? 'Syncing...' : 'Sync Models'}
          </button>
        </div>

        {/* Connection info */}
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-600">WebSocket Relay Port:</span>
            <span className="font-mono text-gray-900">{fleet?.wsRelayPort}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Connected via WebSocket:</span>
            <span className="font-mono text-gray-900">{fleet?.connectedViaWs ?? 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Total Registered:</span>
            <span className="font-mono text-gray-900">{fleet?.sidecars.length ?? 0}</span>
          </div>
        </div>

        <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <h3 className="text-sm font-semibold text-blue-800 mb-2">Setup Instructions</h3>
          <p className="text-xs text-blue-700 mb-2">
            Run the sidecar agent on each GPU machine. It connects back via WebSocket if direct HTTP is blocked.
          </p>
          <pre className="px-3 py-2 bg-gray-900 text-green-400 text-xs rounded font-mono overflow-x-auto select-all">
{`# On the GPU machine:

# 1. Download (PowerShell):
Invoke-WebRequest -Uri "http://<this-server>:3000/api/admin/gpu/sidecars/download" -OutFile "sidecar.tar.gz"

# 1. Download (Linux/macOS):
curl -o sidecar.tar.gz http://<this-server>:3000/api/admin/gpu/sidecars/download

# 2. Extract and start:
tar xzf sidecar.tar.gz && cd sidecar
./start.sh http://<this-server>:3000    # Linux/macOS
.\\start.bat http://<this-server>:3000   # Windows

# Node.js not required — auto-runs in Docker if missing.
# Containers auto-provision on first Start (pull + create).
# Auto-updates every 5 minutes.`}
          </pre>
        </div>
      </div>

      {/* Section 6: Communication Log */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Communication Log</h2>
          <button onClick={() => setShowCommLogs(!showCommLogs)}
            className={`px-3 py-1.5 text-sm rounded-md ${showCommLogs ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
            {showCommLogs ? 'Live' : 'Show Logs'}
          </button>
        </div>
        {showCommLogs && (
          <div className="bg-gray-900 rounded-lg p-3 max-h-80 overflow-y-auto font-mono text-xs">
            {commLogs.length === 0 ? (
              <div className="text-gray-500 py-4 text-center">No recent communication logs. Send a command to see activity.</div>
            ) : (
              commLogs.map((log, i) => {
                const levelColor = log.level === 'ERROR' ? 'text-red-400' : log.level === 'WARN' ? 'text-yellow-400' : 'text-green-400';
                const time = new Date(log.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const metaStr = log.meta ? Object.entries(log.meta).map(([k, v]) => `${k}=${v}`).join(' ') : '';
                return (
                  <div key={i} className="flex gap-2 py-0.5 leading-tight hover:bg-gray-800">
                    <span className="text-gray-500 flex-shrink-0">{time}</span>
                    <span className={`${levelColor} flex-shrink-0 w-12`}>{log.level}</span>
                    <span className="text-blue-400 flex-shrink-0">[{log.component}]</span>
                    <span className="text-gray-200">{log.message}</span>
                    {metaStr && <span className="text-gray-500 truncate">{metaStr}</span>}
                  </div>
                );
              })
            )}
          </div>
        )}
        {!showCommLogs && (
          <p className="text-sm text-gray-500">
            Shows real-time WS relay, command queue, and fleet router activity. Click &quot;Show Logs&quot; to enable live streaming.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  const colorMap: Record<string, string> = {
    green: 'bg-green-50 text-green-800 border-green-200',
    red: 'bg-red-50 text-red-800 border-red-200',
    blue: 'bg-blue-50 text-blue-800 border-blue-200',
    yellow: 'bg-yellow-50 text-yellow-800 border-yellow-200',
    purple: 'bg-purple-50 text-purple-800 border-purple-200',
    gray: 'bg-gray-50 text-gray-800 border-gray-200',
  };
  return (
    <div className={`p-3 rounded-lg border ${colorMap[color] || colorMap.gray}`}>
      <div className="text-xs font-medium opacity-75">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </div>
  );
}

function GpuCard({ gpu }: { gpu: GpuInfo }) {
  const usedPct = gpu.memoryTotal > 0 ? Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100) : 0;
  const barColor = usedPct > 90 ? 'bg-red-500' : usedPct > 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium text-sm text-gray-900">GPU {gpu.index}: {gpu.name}</div>
        <div className="text-xs text-gray-500">{gpu.temperature}C</div>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-3 mb-1">
        <div className={`${barColor} h-3 rounded-full transition-all`} style={{ width: `${usedPct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-gray-500">
        <span>{gpu.memoryUsed} MB used</span>
        <span>{gpu.memoryFree} MB free / {gpu.memoryTotal} MB</span>
      </div>
    </div>
  );
}

/**
 * Host memory / inference panel for non-NVIDIA-container sidecars.
 * Renders the right summary based on which fields the sidecar reported:
 *   - `gpus[]` populated → NVIDIA (Linux/Windows-with-helper) — show GPU summary
 *   - `host.stats` present → show host RAM usage (Mac unified, or Windows host)
 *   - `host.inferenceMemory` present → show Sound Suite's loaded-model budget (Mac)
 *   - none of the above → "memory stats unavailable" hint
 *
 * Includes a provenance badge identifying where the numbers came from and a
 * stale indicator when `host.stats.ageMs > 30_000` (helper not running).
 */
function HostMemoryPanel({ cached }: { cached: CachedStatus }) {
  const gpus = cached.gpus || [];
  const host = cached.host;
  const stats = host?.stats;
  const infer = host?.inferenceMemory;

  const hasGpu = gpus.length > 0;
  const hasHostStats = !!stats && (stats.totalMb || stats.freeMb || stats.usedMb);
  const hasInfer = !!infer && (infer.budgetMb || infer.usedMb || (infer.models && infer.models.length > 0));

  // If we have nothing at all and this isn't a Linux+NVIDIA sidecar with the
  // legacy vram block, render a hint rather than nothing.
  if (!hasGpu && !hasHostStats && !hasInfer && !cached.vram) {
    if (host?.os) {
      return (
        <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <div className="font-medium">Host memory stats unavailable</div>
          <div className="mt-1 opacity-80">
            Sidecar reports <code className="px-1 bg-amber-100 rounded">{host.os}</code> but no host-memory helper data.
            Install/check the host-stats helper to enable RAM tracking.
          </div>
        </div>
      );
    }
    return null;
  }

  // Stale detection (only meaningful when we have host.stats with an age).
  const ageMs = stats?.ageMs;
  const stale = typeof ageMs === 'number' && ageMs > 30_000;

  // Provenance label.
  const source = stats?.source || infer?.source;
  const provenanceLabel = (() => {
    if (hasGpu && (source === 'nvidia-smi' || !source)) return 'nvidia-smi (container)';
    if (source === 'host-helper') return 'nvidia-smi (host helper)';
    if (source === 'host-declared') return 'host-declared';
    if (source === 'docker-info') return 'Docker info estimate';
    if (infer && !stats) return 'Ollama /api/ps + declared budget';
    if (source) return source;
    return 'unknown';
  })();

  // Pick header line based on what's available — see the table in the task spec.
  const gb = (mb?: number) => typeof mb === 'number' ? (mb / 1024).toFixed(1) : '?';

  let headerLine: React.ReactNode = null;
  if (hasGpu) {
    const totalMb = gpus.reduce((s, g) => s + (g.memoryTotal || 0), 0);
    const usedMb = gpus.reduce((s, g) => s + (g.memoryUsed || 0), 0);
    const pct = totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0;
    const name = gpus[0]?.name || 'GPU';
    headerLine = (
      <>
        <span className="font-medium">{name}</span>
        <span className="mx-1">—</span>
        <span className="font-mono">{gb(usedMb)}/{gb(totalMb)} GB used ({pct}%)</span>
        {hasHostStats && (
          <span className="ml-2 text-gray-500 font-mono">· host RAM: {gb(stats!.usedMb ?? (stats!.totalMb && stats!.freeMb ? stats!.totalMb - stats!.freeMb : undefined))} / {gb(stats!.totalMb)} GB</span>
        )}
      </>
    );
  } else if (hasInfer && infer) {
    const usedMb = infer.usedMb ?? 0;
    const budgetMb = infer.budgetMb ?? 0;
    const isMac = host?.os === 'darwin';
    headerLine = (
      <>
        <span className="font-medium">{isMac ? 'Apple Silicon' : 'Host'}</span>
        <span className="mx-1">—</span>
        <span className="font-mono">Sound Suite using {gb(usedMb)} GB of {gb(budgetMb)} GB budget</span>
        {hasHostStats && typeof stats!.pressurePct === 'number' && (
          <span className="ml-2 text-gray-500 font-mono">
            · host pressure: {stats!.pressurePct}%
            {typeof ageMs === 'number' && ` (${Math.round(ageMs / 1000)}s ago)`}
          </span>
        )}
      </>
    );
  } else if (hasHostStats) {
    const totalMb = stats!.totalMb;
    const freeMb = stats!.freeMb;
    const usedMb = stats!.usedMb ?? (totalMb && freeMb ? totalMb - freeMb : undefined);
    headerLine = (
      <>
        <span className="font-medium">No discrete GPU</span>
        <span className="mx-1">—</span>
        <span className="font-mono">host RAM: {gb(usedMb)} / {gb(totalMb)} GB used</span>
        {typeof stats!.pressurePct === 'number' && (
          <span className="ml-2 text-gray-500 font-mono">({stats!.pressurePct}% pressure)</span>
        )}
      </>
    );
  } else {
    return null;
  }

  // Bar values — prefer inference budget for Mac, host stats otherwise, fall
  // back to GPU totals (avoids duplicating the GPU bar that already renders
  // below for Linux/Windows-with-helper).
  let barUsed = 0, barTotal = 0, barLabel = '';
  if (hasInfer && infer) {
    barUsed = infer.usedMb ?? 0;
    barTotal = infer.budgetMb ?? 0;
    barLabel = 'inference budget';
  } else if (hasHostStats) {
    barTotal = stats!.totalMb ?? 0;
    barUsed = stats!.usedMb ?? (stats!.totalMb && stats!.freeMb ? stats!.totalMb - stats!.freeMb : 0);
    barLabel = 'host RAM';
  }
  const showBar = !hasGpu && barTotal > 0;
  const pct = barTotal > 0 ? Math.min(100, Math.round((barUsed / barTotal) * 100)) : 0;
  const barColor = pct >= 85 ? 'bg-red-500' : pct >= 65 ? 'bg-orange-400' : 'bg-emerald-500';

  const models = infer?.models || [];

  return (
    <div className={`mb-4 rounded border p-3 ${stale ? 'border-amber-300 bg-amber-50/40 opacity-90' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-sm text-gray-800">{headerLine}</h3>
        <div className="flex items-center gap-1.5">
          <span
            title={`Memory numbers came from: ${provenanceLabel}${source ? ` (source=${source})` : ''}`}
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 text-blue-800 cursor-help"
          >
            {provenanceLabel}
          </span>
          {stale && (
            <span
              title={`Host stats are stale — last reported ${Math.round((ageMs ?? 0) / 1000)}s ago. Install or check the host-stats helper.`}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-200 text-amber-900"
            >
              stale {Math.round((ageMs ?? 0) / 1000)}s
            </span>
          )}
        </div>
      </div>
      {showBar && (
        <>
          <div className="h-2 w-full rounded bg-gray-200 overflow-hidden">
            <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-gray-500 font-mono">
            {gb(barUsed)} / {gb(barTotal)} GB {barLabel} ({pct}%)
          </div>
        </>
      )}
      {stale && (
        <div className="mt-2 text-[11px] text-amber-800">
          Host stats stale — install/check the host-stats helper on this machine to keep RAM numbers fresh.
        </div>
      )}
      {models.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Loaded models</div>
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            {models.map((m, i) => (
              <span key={`${m.name}-${i}`} className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-1.5 py-0.5 font-mono">
                <span className="text-gray-800">{m.name}</span>
                {typeof m.sizeVramMb === 'number' && (
                  <span className="text-gray-400">{(m.sizeVramMb / 1024).toFixed(1)}GB</span>
                )}
                {typeof m.gpuPercent === 'number' && m.gpuPercent < 99 && (
                  <span className="text-orange-600">{m.gpuPercent}% GPU</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContainerStatusBadge({ status, exists }: { status: string; exists?: boolean }) {
  if (status === 'running') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">running</span>;
  }
  if (status === 'exited' || (exists && status !== 'running')) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">provisioned (stopped)</span>;
  }
  if (status === 'not_found' || status === 'created') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">not provisioned</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">{status}</span>;
}

function TimeoutInput({ label, value, onChange, hint }: { label: string; value: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input type="number" min={0} value={value} onChange={(e) => onChange(parseInt(e.target.value) || 0)}
          className="w-20 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        <span className="text-xs text-gray-500">min</span>
      </div>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

function InlineNoteEditor({ url, note, onSave }: { url: string; note: string; onSave: (note: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(note); }, [note]);

  const save = async () => {
    if (value === note) { setEditing(false); return; }
    setSaving(true);
    await onSave(value);
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <input type="text" value={value} onChange={(e) => setValue(e.target.value)} autoFocus
        disabled={saving}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setValue(note); setEditing(false); } }}
        className="w-32 px-1.5 py-0.5 border border-blue-400 rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
        placeholder="Add note..." />
    );
  }

  return (
    <span onClick={() => setEditing(true)}
      className="text-xs text-gray-500 hover:text-blue-600 cursor-pointer inline-block min-w-[4rem] px-1 py-0.5 rounded hover:bg-blue-50"
      title="Click to edit">
      {note || <span className="italic text-gray-300">--</span>}
    </span>
  );
}

function NumberInput({ label, value, onChange, unit, hint }: { label: string; value: number; onChange: (v: number) => void; unit?: string; hint?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input type="number" min={0} value={value} onChange={(e) => onChange(parseInt(e.target.value) || 0)}
          className="w-20 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        {unit && <span className="text-xs text-gray-500">{unit}</span>}
      </div>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

/**
 * RoleBadges — inline mode assignment chips for a sidecar. Best-effort fetch
 * from /api/admin/role-assignments + /api/admin/mode-catalog. Silently
 * renders nothing on 404 or error.
 *
 * A mode that's enabled but unavailable on the host OS is greyed out with an
 * amber ⓘ to flag the misconfiguration.
 */
function RoleBadges({ sidecarUrl, hostOs }: { sidecarUrl: string; hostOs?: string }) {
  const [roles, setRoles] = useState<string[] | null>(null);
  const [availability, setAvailability] = useState<Record<string, string[]>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [aRes, cRes] = await Promise.all([
          fetch(`/api/admin/role-assignments?sidecarUrl=${encodeURIComponent(sidecarUrl)}`),
          fetch('/api/admin/mode-catalog').catch(() => null),
        ]);
        if (cancelled) return;
        if (aRes.ok) {
          const data = await aRes.json();
          const list: any[] = Array.isArray(data.assignments) ? data.assignments : [];
          setRoles(
            list
              .filter((a) => a.enabled)
              .map((a) => a.mode || a.roleType?.name || a.roleTypeName)
              .filter(Boolean),
          );
        }
        if (cRes && cRes.ok) {
          const data = await cRes.json();
          const modes: any[] = Array.isArray(data?.modes) ? data.modes : [];
          const map: Record<string, string[]> = {};
          for (const m of modes) {
            if (m?.name) map[m.name] = Array.isArray(m.availableOn) ? m.availableOn : [];
          }
          setAvailability(map);
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [sidecarUrl]);

  if (!roles || roles.length === 0) return null;

  return (
    <span className="ml-2 inline-flex flex-wrap gap-1">
      {roles.map((r) => {
        const supported = availability[r];
        const unsupported = hostOs && supported && supported.length > 0 && !supported.includes(hostOs);
        return (
          <a
            key={r}
            href="/admin/roleassign"
            onClick={(e) => e.stopPropagation()}
            title={
              unsupported
                ? `${r} is not available on ${hostOs} — sidecar will refuse to start it`
                : `Manage ${r} assignment`
            }
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium border ${
              unsupported
                ? 'bg-gray-50 text-gray-400 border-gray-200 ring-1 ring-amber-300'
                : 'bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200'
            }`}
          >
            {r}
            {unsupported && <span className="text-amber-500">ⓘ</span>}
          </a>
        );
      })}
    </span>
  );
}
