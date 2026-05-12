'use client';

/**
 * AdminHostProvisioning — per-sidecar master URL, WS port, and OS overrides.
 *
 * Why this exists:
 *   The same fleet may have sidecars on different subnets (home LAN, lab
 *   subnet, VPN). Each sidecar may need a different master URL to phone
 *   home (different IPs from different networks). The same sidecar can
 *   also serve a second master app entirely (e.g. Fantom MCP at :3300
 *   with its own WS port like 3848).
 *
 *   Per-host ONLY — no global fallback. If a host has no row here, the
 *   master pushes nothing and the sidecar keeps whatever URL it has.
 *
 * Backend contract:
 *   GET    /api/admin/host-provisioning
 *     → { provisioning: HostProvisioningRecord[], defaultWsPort: number }
 *   PUT    /api/admin/host-provisioning  { sidecarUrl, hostOsOverride?, masterUrlForHost?, masterWsPortForHost?, notes? }
 *   DELETE /api/admin/host-provisioning?sidecarUrl=...
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type HostOs = 'darwin' | 'win32' | 'linux';

interface HostProvisioningRecord {
  sidecarUrl: string;
  hostOsOverride: HostOs | null;
  masterUrlForHost: string | null;
  masterWsPortForHost: number | null;
  notes: string | null;
}

interface ProvisioningResponse {
  provisioning: HostProvisioningRecord[];
  defaultWsPort: number;
}

interface FleetSidecar {
  url: string;
  hostname: string;
  status: 'connected' | 'disconnected';
  mode?: 'direct' | 'websocket';
  lastSeen?: string;
  sidecarStatus?: {
    wsConnected?: boolean;
    host?: { os?: string };
  };
}

interface FleetResponse {
  sidecars: FleetSidecar[];
}

type Toast = { type: 'success' | 'error'; text: string } | null;

const OS_LABEL: Record<HostOs, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

function osOptionLabel(v: HostOs | '') {
  if (!v) return 'Auto';
  return OS_LABEL[v];
}

function emptyRecord(sidecarUrl: string): HostProvisioningRecord {
  return {
    sidecarUrl,
    hostOsOverride: null,
    masterUrlForHost: null,
    masterWsPortForHost: null,
    notes: null,
  };
}

function secondsSince(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function connDotClass(s: FleetSidecar): string {
  if (s.status !== 'connected') return 'bg-slate-300';
  if (s.sidecarStatus?.wsConnected || s.mode === 'websocket') return 'bg-green-500';
  return 'bg-yellow-400';
}

function connLabel(s: FleetSidecar): string {
  if (s.status !== 'connected') return 'disconnected';
  if (s.sidecarStatus?.wsConnected || s.mode === 'websocket') return 'live · WS';
  return 'live · HTTP';
}

export default function AdminHostProvisioning() {
  const [fleet, setFleet] = useState<FleetSidecar[]>([]);
  const [defaultWsPort, setDefaultWsPort] = useState<number>(3002);
  const [recordsByUrl, setRecordsByUrl] = useState<Record<string, HostProvisioningRecord>>({});
  const [draftByUrl, setDraftByUrl] = useState<Record<string, HostProvisioningRecord>>({});
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [resetingUrl, setResetingUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendMissing, setBackendMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [dismissedInfo, setDismissedInfo] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());

  // Reload triggers timer
  const reloadTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    if (t) setTimeout(() => setToast(null), 3500);
  }, []);

  // Persist dismissal per-session in localStorage
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('host-provisioning:multi-app-dismissed');
      if (raw) setDismissedInfo(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  const dismissMultiAppInfo = useCallback((url: string) => {
    setDismissedInfo((prev) => {
      const next = { ...prev, [url]: true };
      try { sessionStorage.setItem('host-provisioning:multi-app-dismissed', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const loadFleet = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/gpu-fleet');
      if (!res.ok) throw new Error(`gpu-fleet HTTP ${res.status}`);
      const data: FleetResponse = await res.json();
      setFleet(Array.isArray(data.sidecars) ? data.sidecars : []);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  const loadProvisioning = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/host-provisioning');
      if (res.status === 404) {
        setBackendMissing(true);
        setRecordsByUrl({});
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setBackendMissing(false);
      const data: ProvisioningResponse = await res.json();
      const map: Record<string, HostProvisioningRecord> = {};
      for (const r of data.provisioning || []) {
        map[r.sidecarUrl] = {
          sidecarUrl: r.sidecarUrl,
          hostOsOverride: (r.hostOsOverride ?? null) as HostOs | null,
          masterUrlForHost: r.masterUrlForHost ?? null,
          masterWsPortForHost: r.masterWsPortForHost ?? null,
          notes: r.notes ?? null,
        };
      }
      setRecordsByUrl(map);
      if (typeof data.defaultWsPort === 'number') setDefaultWsPort(data.defaultWsPort);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await Promise.all([loadFleet(), loadProvisioning()]);
      if (!cancelled) setLoading(false);
    })();
    reloadTimer.current = setInterval(() => {
      loadFleet();
    }, 5000);
    const tickTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      if (reloadTimer.current) clearInterval(reloadTimer.current);
      clearInterval(tickTimer);
    };
  }, [loadFleet, loadProvisioning]);

  // Tick reference for stale "Xs ago" labels
  void now;

  // Compose the drafts so each row has working state — merge saved record on top of empty.
  const draftFor = useCallback((sidecarUrl: string): HostProvisioningRecord => {
    if (draftByUrl[sidecarUrl]) return draftByUrl[sidecarUrl];
    return recordsByUrl[sidecarUrl] || emptyRecord(sidecarUrl);
  }, [draftByUrl, recordsByUrl]);

  const setDraftField = useCallback((sidecarUrl: string, patch: Partial<HostProvisioningRecord>) => {
    setDraftByUrl((prev) => {
      const base = prev[sidecarUrl] || recordsByUrl[sidecarUrl] || emptyRecord(sidecarUrl);
      return { ...prev, [sidecarUrl]: { ...base, ...patch, sidecarUrl } };
    });
  }, [recordsByUrl]);

  const isDirty = useCallback((sidecarUrl: string): boolean => {
    const d = draftByUrl[sidecarUrl];
    if (!d) return false;
    const r = recordsByUrl[sidecarUrl] || emptyRecord(sidecarUrl);
    return (
      (d.hostOsOverride ?? null) !== (r.hostOsOverride ?? null) ||
      (d.masterUrlForHost ?? '') !== (r.masterUrlForHost ?? '') ||
      (d.masterWsPortForHost ?? null) !== (r.masterWsPortForHost ?? null) ||
      (d.notes ?? '') !== (r.notes ?? '')
    );
  }, [draftByUrl, recordsByUrl]);

  const handleSave = useCallback(async (sidecarUrl: string) => {
    const d = draftFor(sidecarUrl);
    const body = {
      sidecarUrl,
      hostOsOverride: d.hostOsOverride ?? null,
      masterUrlForHost: d.masterUrlForHost?.trim() ? d.masterUrlForHost.trim() : null,
      masterWsPortForHost: d.masterWsPortForHost ?? null,
      notes: d.notes?.trim() ? d.notes.trim() : null,
    };

    // Optimistic
    const prevRecord = recordsByUrl[sidecarUrl];
    setRecordsByUrl((m) => ({ ...m, [sidecarUrl]: { ...body } as HostProvisioningRecord }));
    setSavingUrl(sidecarUrl);

    try {
      const res = await fetch('/api/admin/host-provisioning', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json().catch(() => body);
      setRecordsByUrl((m) => ({ ...m, [sidecarUrl]: { ...body, ...saved, sidecarUrl } as HostProvisioningRecord }));
      // clear draft for that row
      setDraftByUrl((m) => {
        const { [sidecarUrl]: _drop, ...rest } = m;
        void _drop;
        return rest;
      });
      showToast({ type: 'success', text: `Saved overrides for ${sidecarUrl}` });
    } catch (e: any) {
      // Revert
      setRecordsByUrl((m) => {
        if (prevRecord) return { ...m, [sidecarUrl]: prevRecord };
        const { [sidecarUrl]: _drop, ...rest } = m;
        void _drop;
        return rest;
      });
      showToast({ type: 'error', text: `Save failed: ${e?.message || String(e)}` });
    } finally {
      setSavingUrl(null);
    }
  }, [draftFor, recordsByUrl, showToast]);

  const handleReset = useCallback(async (sidecarUrl: string) => {
    setResetingUrl(sidecarUrl);
    const prev = recordsByUrl[sidecarUrl];
    // Optimistic remove
    setRecordsByUrl((m) => {
      const { [sidecarUrl]: _drop, ...rest } = m;
      void _drop;
      return rest;
    });
    setDraftByUrl((m) => {
      const { [sidecarUrl]: _drop, ...rest } = m;
      void _drop;
      return rest;
    });
    try {
      const res = await fetch(`/api/admin/host-provisioning?sidecarUrl=${encodeURIComponent(sidecarUrl)}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      showToast({ type: 'success', text: `Cleared overrides for ${sidecarUrl}` });
    } catch (e: any) {
      if (prev) setRecordsByUrl((m) => ({ ...m, [sidecarUrl]: prev }));
      showToast({ type: 'error', text: `Reset failed: ${e?.message || String(e)}` });
    } finally {
      setResetingUrl(null);
    }
  }, [recordsByUrl, showToast]);

  const sortedFleet = useMemo(() => {
    return [...fleet].sort((a, b) => (a.hostname || a.url).localeCompare(b.hostname || b.url));
  }, [fleet]);

  return (
    <div className="space-y-4">
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-md shadow-lg text-sm max-w-md ${
            toast.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Header / context block */}
      <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-900 space-y-2">
        <p>
          Assign each sidecar the master URL it should call home to, plus
          (optionally) the master&apos;s WebSocket port and the host OS type.
          These overrides are <strong>per-host only</strong> — there is no
          global fallback. A sidecar without a row here keeps whatever URL
          it already has and the master pushes nothing.
        </p>
        <p className="text-blue-800">
          <strong>Why per-host?</strong> Sidecars may sit on different subnets
          (home LAN, lab subnet, VPN) and reach this master at different IPs.
          The same physical sidecar can also serve another master app (e.g.{' '}
          <em>Fantom MCP</em> on a different port like <code>:3848</code>) —
          its master list keeps both side by side.
        </p>
        <p className="text-blue-800 text-[12px]">
          Default WebSocket port for this master:{' '}
          <code className="font-mono">{defaultWsPort}</code> (from{' '}
          <code className="font-mono">GPU_WS_PORT</code>). Override per host when
          this master accepts WS upgrades on a different port.
        </p>
      </div>

      {backendMissing && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 text-sm text-yellow-900">
          Backend endpoint <code>/api/admin/host-provisioning</code> not
          deployed yet. Showing rows in read-only mode — saves will fail
          until the API lands.
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-800 border border-red-200 rounded-md p-3 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white shadow rounded-lg p-6 text-sm text-gray-500">Loading…</div>
      ) : sortedFleet.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-6 text-sm text-gray-500">
          No sidecars registered. Add one in the <strong>GPU Fleet</strong> tab.
        </div>
      ) : (
        <div className="space-y-3">
          {sortedFleet.map((s) => {
            const d = draftFor(s.url);
            const saved = recordsByUrl[s.url];
            const dirty = isDirty(s.url);
            const detectedOs = s.sidecarStatus?.host?.os;
            const placeholderMasterUrl = 'http://master:3000';
            const infoDismissed = !!dismissedInfo[s.url];

            return (
              <div key={s.url} className="bg-white shadow rounded-lg p-4">
                <div className="flex items-start justify-between mb-3 gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${connDotClass(s)}`}
                      title={connLabel(s)}
                    />
                    <span className="text-sm font-semibold text-gray-900">{s.hostname || s.url}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200">
                      {connLabel(s)} · {secondsSince(s.lastSeen)}
                    </span>
                    {detectedOs && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-50 text-slate-700 border border-slate-200">
                        detected: {detectedOs}
                      </span>
                    )}
                    <span className="text-[11px] text-gray-400 font-mono">{s.url}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(s.url)}
                      disabled={!dirty || savingUrl === s.url || backendMissing}
                      className="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-md"
                    >
                      {savingUrl === s.url ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => handleReset(s.url)}
                      disabled={!saved || resetingUrl === s.url || backendMissing}
                      className="px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed rounded-md border border-gray-300"
                    >
                      {resetingUrl === s.url ? 'Clearing…' : 'Reset overrides'}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
                  {/* OS override */}
                  <div className="md:col-span-2">
                    <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                      OS (override)
                    </label>
                    <select
                      value={d.hostOsOverride ?? ''}
                      onChange={(e) => {
                        const v = e.target.value as HostOs | '';
                        setDraftField(s.url, { hostOsOverride: v ? (v as HostOs) : null });
                      }}
                      className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    >
                      <option value="">{osOptionLabel('')}{detectedOs ? ` (detected: ${detectedOs})` : ''}</option>
                      <option value="darwin">macOS</option>
                      <option value="win32">Windows</option>
                      <option value="linux">Linux</option>
                    </select>
                  </div>

                  {/* Master URL */}
                  <div className="md:col-span-5">
                    <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                      Master URL (per-host)
                    </label>
                    <input
                      type="text"
                      value={d.masterUrlForHost ?? ''}
                      onChange={(e) => setDraftField(s.url, { masterUrlForHost: e.target.value })}
                      placeholder={placeholderMasterUrl}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                    />
                  </div>

                  {/* WS Port */}
                  <div className="md:col-span-2">
                    <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                      WS Port
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={d.masterWsPortForHost ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        if (raw === '') {
                          setDraftField(s.url, { masterWsPortForHost: null });
                          return;
                        }
                        const n = parseInt(raw, 10);
                        if (Number.isFinite(n)) setDraftField(s.url, { masterWsPortForHost: n });
                      }}
                      placeholder={`${defaultWsPort} (default)`}
                      className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                    />
                  </div>

                  {/* Sidecar URL — read-only */}
                  <div className="md:col-span-3">
                    <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                      Sidecar URL (read-only)
                    </label>
                    <div className="px-2 py-1.5 text-xs font-mono text-gray-600 bg-gray-50 border border-gray-200 rounded-md break-all">
                      {s.url}
                    </div>
                  </div>
                </div>

                <div className="mt-3">
                  <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                    Notes
                  </label>
                  <input
                    type="text"
                    value={d.notes ?? ''}
                    onChange={(e) => setDraftField(s.url, { notes: e.target.value })}
                    placeholder="e.g. home LAN, lab subnet, behind VPN, dual-app host running Fantom too"
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                </div>

                {!infoDismissed && (
                  <div className="mt-3 flex items-start gap-2 p-2.5 rounded-md bg-slate-50 border border-slate-200 text-[12px] text-slate-700">
                    <span className="text-base leading-none mt-0.5">ⓘ</span>
                    <div className="flex-1">
                      This sidecar can be added to other master apps too —
                      e.g. <strong>Fantom MCP</strong> at{' '}
                      <code className="font-mono">http://172.16.16.9:3300</code>.
                      Set its master URL there separately. Both can coexist in
                      the sidecar&apos;s master list.
                    </div>
                    <button
                      onClick={() => dismissMultiAppInfo(s.url)}
                      className="text-slate-400 hover:text-slate-600 text-xs px-1"
                      title="Dismiss for this session"
                    >
                      ✕
                    </button>
                  </div>
                )}

                {dirty && (
                  <div className="mt-2 text-[11px] text-amber-700">
                    Unsaved changes. Click <strong>Save</strong> to push to the
                    sidecar on its next config sync (~30s).
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
