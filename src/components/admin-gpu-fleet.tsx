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
  wsConnected: boolean;
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
  latestBuildVersion: string | null;
}

const ROLES = ['embedding', 'completion', 'ocr', 'reranker'] as const;

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
    const interval = setInterval(fetchFleet, 10_000);
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
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Mode</th>
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
                    </td>
                    <td className="py-2 px-3 font-mono text-xs text-gray-600">{s.url}</td>
                    <td className="py-2 px-3">
                      {/* Operational mode (indexing/searching) */}
                      {s.sidecarStatus && (
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mr-1 ${
                          (s.sidecarStatus as any).mode === 'indexing' ? 'bg-amber-100 text-amber-800' : 'bg-cyan-100 text-cyan-800'
                        }`}>{(s.sidecarStatus as any).mode || '?'}</span>
                      )}
                      {/* Connection mode (WS/direct) */}
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
              {/* Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
                <StatCard label="Active Requests" value={String(cachedStatus.activeRequests ?? 0)} color="blue" />
                <StatCard label="Sidecar Mode" value={cachedStatus.mode || '-'} color="blue" />
                <StatCard label="Agent Uptime" value={cachedStatus.uptime ? formatUptime(cachedStatus.uptime) : '-'} color="purple" />
                <StatCard label="Version" value={cachedStatus.version || '1.x'} color="gray" />
                <StatCard label="Total VRAM" value={detailGpus.length > 0 ? `${detailGpus.reduce((s, g) => s + g.memoryTotal, 0)} MB` : '-'} color="purple" />
              </div>

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

              {/* Mode Selector (for single-GPU machines) */}
              {cachedStatus.mode && (
                <div className="mb-6 p-4 bg-gray-50 rounded-lg">
                  <h3 className="text-sm font-medium text-gray-700 mb-2">Mode (Single-GPU)</h3>
                  <p className="text-xs text-gray-500 mb-3">Controls which containers are active. Multi-GPU machines can run all concurrently.</p>
                  <div className="flex gap-2">
                    {['indexing', 'searching'].map((m) => (
                      <button key={m} onClick={() => handleModeSwitch(selectedSidecar.url, m)}
                        disabled={actionLoading !== null || pendingAction !== null}
                        className={`px-4 py-2 text-sm rounded-md border-2 transition-colors ${
                          cachedStatus.mode === m
                            ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
                            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                        } disabled:opacity-50`}>
                        {pendingAction === `mode-${m}` ? 'Switching...'
                          : m === 'indexing' ? 'Indexing (Embed+OCR)' : 'Searching (Embed+Completion+Reranker)'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Container Grid */}
              {cachedStatus.containers && Object.keys(cachedStatus.containers).length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Containers</h3>
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
                                {(c.type === 'ollama' || c.config?.type === 'ollama') && c.status === 'running' ? (
                                  c.loadedModels && c.loadedModels.length > 0 ? (
                                    (() => {
                                      const m0 = c.loadedModels![0];
                                      const gpuPct = m0.gpuPercent ?? (m0.processor === 'GPU' ? 100 : 0);
                                      const isFullGpu = gpuPct >= 99;
                                      const isPartial = gpuPct > 0 && gpuPct < 99;
                                      const gpuOnly = c.config?.gpuOnly === true;
                                      // For gpuOnly roles, partial offload is a hard error — treat as red.
                                      const isBlocked = gpuOnly && !isFullGpu;
                                      const colorClass = isBlocked ? 'text-red-700' : isFullGpu ? 'text-green-700' : isPartial ? 'text-orange-600' : 'text-red-600';
                                      const dotClass = isBlocked ? 'bg-red-600' : isFullGpu ? 'bg-green-500' : isPartial ? 'bg-orange-400' : 'bg-red-500';
                                      return (
                                        <div className="flex items-center gap-1">
                                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass}`} />
                                          <span className={colorClass}>{c.loadedModels!.map(m => m.name).join(', ')}</span>
                                          <span className={`ml-1 ${isFullGpu && !gpuOnly ? 'text-gray-400' : colorClass + ' font-semibold'}`}>
                                            ({m0.processor} {gpuPct}% {m0.size}{isBlocked ? ' — GPU not ready (CPU offload blocked)' : ''})
                                          </span>
                                        </div>
                                      );
                                    })()
                                  ) : (
                                    <div className={`flex items-center gap-1 ${c.config?.gpuOnly ? 'text-red-700' : 'text-orange-600'}`}>
                                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${c.config?.gpuOnly ? 'bg-red-600' : 'bg-orange-400'}`} />
                                      {c.config?.gpuOnly ? 'not loaded (GPU required)' : 'not loaded'}
                                    </div>
                                  )
                                ) : (
                                  <span className="text-gray-300">—</span>
                                )}
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
