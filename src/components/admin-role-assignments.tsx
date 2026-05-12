'use client';

/**
 * AdminRoleAssignments — multi-select-per-sidecar mode assignment UI.
 *
 * Each sidecar gets one row of mode chips (ss-embedding, ss-completion,
 * ss-ocr, ss-reranker). Click a chip to toggle; click the gear to reveal
 * per-mode advanced settings (model override, minOnline, idleTimeoutMin).
 *
 * Backend endpoints (Agent A):
 *   GET    /api/admin/mode-catalog
 *   GET    /api/admin/role-assignments?sidecarUrl=...
 *   POST   /api/admin/role-assignments
 *   DELETE /api/admin/role-assignments?sidecarUrl=...&mode=...
 *   POST   /api/admin/role-assignments/sync?sidecarUrl=...
 *
 * Defensive: if the new endpoints 404, the page still renders and shows a
 * banner. Falls back to the legacy `roleTypeName` field where appropriate.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog, type ModeCatalogEntry, type ModeOs } from '@/components/admin-role-types';

/* ─────────────────────────── Types ─────────────────────────── */

interface SidecarSummary {
  url: string;
  hostname: string;
  status: 'connected' | 'disconnected';
  os?: ModeOs | string;
  gpuSummary?: string;
  containers?: Record<string, { loadedModels?: Array<{ name: string }> }>;
}

interface RoleAssignment {
  mode: string;
  enabled: boolean;
  minOnline?: number | null;
  idleTimeoutMin?: number | null;
  modelOverride?: string | null;
}

type Toast = { type: 'success' | 'error' | 'warning'; text: string } | null;

const FALLBACK_MODES: ModeCatalogEntry[] = [
  { name: 'ss-embedding', availableOn: ['linux', 'darwin', 'win32'], defaultModel: { linux: 'qwen3-embedding:0.6b', darwin: 'qwen3-embedding:0.6b', win32: 'qwen3-embedding:0.6b' } },
  { name: 'ss-completion', availableOn: ['linux', 'darwin', 'win32'], defaultModel: { linux: 'qwen3.5:9b', darwin: 'qwen3.5:9b', win32: 'qwen3.5:9b' } },
  { name: 'ss-ocr', availableOn: ['linux', 'darwin', 'win32'], defaultModel: { linux: 'richardyoung/olmocr2:7b', darwin: 'richardyoung/olmocr2:7b', win32: 'richardyoung/olmocr2:7b' } },
  { name: 'ss-reranker', availableOn: ['linux'], defaultModel: { linux: 'Qwen/Qwen3-Reranker-8B' } },
];

const RESET_DEFAULTS: Record<string, { minOnline: number; idleTimeoutMin: number }> = {
  'ss-embedding': { minOnline: 1, idleTimeoutMin: 0 },
  'ss-completion': { minOnline: 1, idleTimeoutMin: 10 },
  'ss-ocr': { minOnline: 1, idleTimeoutMin: 5 },
  'ss-reranker': { minOnline: 0, idleTimeoutMin: 5 },
};

/* ─────────────────────────── Helpers ─────────────────────────── */

function inferOs(hostname: string | undefined, declared: string | undefined): ModeOs {
  if (declared === 'linux' || declared === 'darwin' || declared === 'win32') return declared;
  const h = (hostname || '').toLowerCase();
  if (h.includes('mac') || h.endsWith('.local')) return 'darwin';
  if (h.includes('win') || h.includes('wsl')) return 'win32';
  return 'linux';
}

function normalizeAssignment(raw: any): RoleAssignment | null {
  const mode = raw?.mode || raw?.roleType?.name || raw?.roleTypeName;
  if (!mode) return null;
  return {
    mode,
    enabled: raw.enabled !== false,
    minOnline: raw.minOnline ?? null,
    idleTimeoutMin: raw.idleTimeoutMin ?? null,
    modelOverride: raw.modelOverride ?? null,
  };
}

/* ─────────────────────────── Component ─────────────────────────── */

export default function AdminRoleAssignments() {
  const [sidecars, setSidecars] = useState<SidecarSummary[]>([]);
  const [catalog, setCatalog] = useState<ModeCatalogEntry[]>(FALLBACK_MODES);
  const [assignmentsByUrl, setAssignmentsByUrl] = useState<Record<string, RoleAssignment[]>>({});
  const [loading, setLoading] = useState(true);
  const [backendMissing, setBackendMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());

  /** key = `${sidecarUrl}::${mode}` — open per-mode panel */
  const [openPanel, setOpenPanel] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<SidecarSummary | null>(null);

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const showToast = useCallback((t: Toast) => {
    setToast(t);
    if (t) setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const loadFleet = useCallback(async (): Promise<SidecarSummary[]> => {
    try {
      const res = await fetch('/api/admin/gpu-fleet');
      if (!res.ok) throw new Error(`gpu-fleet HTTP ${res.status}`);
      const data = await res.json();
      const list: SidecarSummary[] = (data.sidecars || []).map((s: any) => {
        const cached = s.sidecarStatus || {};
        const os = inferOs(s.hostname || s.url, cached.host?.os);
        const gpus: any[] = Array.isArray(cached.gpus) ? cached.gpus : [];
        const gpuSummary = gpus.length > 0
          ? `${gpus[0].name?.replace(/^NVIDIA\s+/i, '') || 'GPU'} ${gpus[0].memoryTotal ? `${Math.round(gpus[0].memoryTotal / 1024)} GB` : ''}`.trim()
          : cached.host?.stats?.totalMb
            ? `Host RAM ${Math.round((cached.host.stats.totalMb) / 1024)} GB`
            : undefined;
        return {
          url: s.url,
          hostname: s.hostname || s.url,
          status: s.status,
          os,
          gpuSummary,
          containers: cached.containers || {},
        };
      });
      setSidecars(list);
      return list;
    } catch (e: any) {
      setError(e?.message || String(e));
      return [];
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/mode-catalog');
      if (res.status === 404) {
        setBackendMissing(true);
        setCatalog(FALLBACK_MODES);
        return;
      }
      if (!res.ok) throw new Error(`mode-catalog HTTP ${res.status}`);
      const data = await res.json();
      const modes: ModeCatalogEntry[] = Array.isArray(data?.modes) ? data.modes : [];
      setCatalog(modes.length > 0 ? modes : FALLBACK_MODES);
    } catch {
      setCatalog(FALLBACK_MODES);
    }
  }, []);

  const loadAssignments = useCallback(async (sidecarUrl: string) => {
    try {
      const res = await fetch(`/api/admin/role-assignments?sidecarUrl=${encodeURIComponent(sidecarUrl)}`);
      if (res.status === 404) {
        setBackendMissing(true);
        setAssignmentsByUrl((m) => ({ ...m, [sidecarUrl]: [] }));
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data?.assignments) ? data.assignments : [];
      const normalized = list.map(normalizeAssignment).filter(Boolean) as RoleAssignment[];
      setAssignmentsByUrl((m) => ({ ...m, [sidecarUrl]: normalized }));
    } catch (e: any) {
      showToast({ type: 'error', text: e?.message || String(e) });
    }
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await loadCatalog();
      const list = await loadFleet();
      if (cancelled) return;
      await Promise.all(list.map((s) => loadAssignments(s.url)));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─────────────────────────── Mutations ─────────────────────────── */

  const triggerSync = useCallback(async (sidecarUrl: string) => {
    try {
      const res = await fetch(
        `/api/admin/role-assignments/sync?sidecarUrl=${encodeURIComponent(sidecarUrl)}`,
        { method: 'POST' },
      );
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `sync HTTP ${res.status}`);
      }
      setLastSyncedAt((m) => ({ ...m, [sidecarUrl]: Date.now() }));
    } catch (e: any) {
      showToast({ type: 'error', text: `Sync failed: ${e?.message || e}` });
    }
  }, [showToast]);

  const upsertAssignment = useCallback(
    async (sidecarUrl: string, mode: string, patch: Partial<RoleAssignment>) => {
      const current = (assignmentsByUrl[sidecarUrl] || []).find((a) => a.mode === mode);
      const body: Record<string, unknown> = {
        sidecarUrl,
        mode,
        // legacy field, kept for old backend compat
        roleTypeName: mode,
        enabled: patch.enabled ?? current?.enabled ?? true,
        minOnline: patch.minOnline ?? current?.minOnline ?? null,
        idleTimeoutMin: patch.idleTimeoutMin ?? current?.idleTimeoutMin ?? null,
        modelOverride: patch.modelOverride ?? current?.modelOverride ?? null,
      };
      try {
        const res = await fetch('/api/admin/role-assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        await loadAssignments(sidecarUrl);
        showToast({ type: 'success', text: `Updated ${mode}` });
        triggerSync(sidecarUrl);
      } catch (e: any) {
        showToast({ type: 'error', text: e?.message || String(e) });
      }
    },
    [assignmentsByUrl, loadAssignments, showToast, triggerSync],
  );

  const deleteAssignment = useCallback(
    async (sidecarUrl: string, mode: string) => {
      try {
        // Try new ?mode= param first; fall back to legacy ?roleTypeName= if 400/404.
        let res = await fetch(
          `/api/admin/role-assignments?sidecarUrl=${encodeURIComponent(sidecarUrl)}&mode=${encodeURIComponent(mode)}`,
          { method: 'DELETE' },
        );
        if (res.status === 400 || res.status === 404) {
          res = await fetch(
            `/api/admin/role-assignments?sidecarUrl=${encodeURIComponent(sidecarUrl)}&roleTypeName=${encodeURIComponent(mode)}`,
            { method: 'DELETE' },
          );
        }
        if (!res.ok && res.status !== 204) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        await loadAssignments(sidecarUrl);
        showToast({ type: 'success', text: `Removed ${mode}` });
        triggerSync(sidecarUrl);
      } catch (e: any) {
        showToast({ type: 'error', text: e?.message || String(e) });
      }
    },
    [loadAssignments, showToast, triggerSync],
  );

  /** Debounced upsert — for advanced field edits. */
  const queueUpsert = useCallback(
    (sidecarUrl: string, mode: string, patch: Partial<RoleAssignment>) => {
      const key = `${sidecarUrl}::${mode}::adv`;
      if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
      debounceTimers.current[key] = setTimeout(() => {
        upsertAssignment(sidecarUrl, mode, patch);
      }, 300);
    },
    [upsertAssignment],
  );

  const toggleMode = (sidecar: SidecarSummary, mode: ModeCatalogEntry) => {
    const current = (assignmentsByUrl[sidecar.url] || []).find((a) => a.mode === mode.name);
    const nextEnabled = !current?.enabled;
    const available = mode.availableOn.includes(sidecar.os as ModeOs);

    if (nextEnabled && !available) {
      showToast({
        type: 'warning',
        text: `${mode.name} isn't supported on this host (${sidecar.os}). The sidecar will refuse to start it. Use a Linux+NVIDIA sidecar for reranking.`,
      });
    }

    if (!nextEnabled && current) {
      deleteAssignment(sidecar.url, mode.name);
    } else {
      upsertAssignment(sidecar.url, mode.name, { enabled: true });
    }
  };

  const handleResetDefaults = async () => {
    if (!confirmReset) return;
    const sidecar = confirmReset;
    setConfirmReset(null);

    const currentAssignments = assignmentsByUrl[sidecar.url] || [];

    try {
      // Wipe current
      for (const a of currentAssignments) {
        await fetch(
          `/api/admin/role-assignments?sidecarUrl=${encodeURIComponent(sidecar.url)}&mode=${encodeURIComponent(a.mode)}`,
          { method: 'DELETE' },
        ).catch(() => undefined);
      }
      // Restore mode defaults for available modes
      for (const m of catalog) {
        const available = m.availableOn.includes(sidecar.os as ModeOs);
        if (!available) continue;
        const d = RESET_DEFAULTS[m.name] || { minOnline: 0, idleTimeoutMin: 5 };
        await fetch('/api/admin/role-assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sidecarUrl: sidecar.url,
            mode: m.name,
            roleTypeName: m.name,
            enabled: true,
            minOnline: d.minOnline,
            idleTimeoutMin: d.idleTimeoutMin,
            modelOverride: null,
          }),
        });
      }
      await loadAssignments(sidecar.url);
      showToast({ type: 'success', text: 'Reset to defaults' });
      triggerSync(sidecar.url);
    } catch (e: any) {
      showToast({ type: 'error', text: e?.message || String(e) });
    }
  };

  /* ─────────────────────────── Render ─────────────────────────── */

  if (loading) {
    return <div className="text-gray-500 py-8 text-center">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-md shadow-lg text-sm max-w-md ${
            toast.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : toast.type === 'warning'
                ? 'bg-amber-50 text-amber-900 border border-amber-200'
                : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {toast.text}
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-900">
        Pick which modes each sidecar should run. The sidecar auto-resolves the
        underlying model / image / port based on its OS. Click the gear on an
        enabled chip to override per-host model or runtime settings.
      </div>

      {backendMissing && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 text-sm text-yellow-900">
          Backend endpoints not yet deployed (
          <code>/api/admin/mode-catalog</code> or{' '}
          <code>/api/admin/role-assignments</code>). Showing built-in catalog;
          edits will fail until Agent A's PR lands.
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-800 border border-red-200 rounded-md p-3 text-sm">
          {error}
        </div>
      )}

      {sidecars.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-6 text-sm text-gray-500">
          No sidecars registered. Add one in the <strong>GPU Fleet</strong> tab.
        </div>
      ) : (
        <div className="space-y-3">
          {sidecars.map((sidecar) => {
            const assigns = assignmentsByUrl[sidecar.url] || [];
            const lastSync = lastSyncedAt[sidecar.url];
            const lastSyncLabel = lastSync
              ? `${Math.max(0, Math.floor((now - lastSync) / 1000))} s ago`
              : 'never';

            return (
              <div key={sidecar.url} className="bg-white shadow rounded-lg p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${sidecar.status === 'connected' ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className="text-sm font-semibold text-gray-900">{sidecar.hostname}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200">
                      {sidecar.os}
                    </span>
                    {sidecar.gpuSummary && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-800 border border-purple-200">
                        {sidecar.gpuSummary}
                      </span>
                    )}
                    <span className="text-[11px] text-gray-400 font-mono">{sidecar.url}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => triggerSync(sidecar.url)}
                      className="px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded-md border border-blue-200"
                    >
                      Sync now
                    </button>
                    <button
                      onClick={() => setConfirmReset(sidecar)}
                      className="px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 rounded-md border border-gray-300"
                    >
                      Reset to defaults
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {catalog.map((mode) => {
                    const assignment = assigns.find((a) => a.mode === mode.name);
                    const enabled = !!assignment?.enabled;
                    const available = mode.availableOn.includes(sidecar.os as ModeOs);
                    const misconfigured = enabled && !available;
                    const panelKey = `${sidecar.url}::${mode.name}`;
                    const panelOpen = openPanel === panelKey;

                    let className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition select-none ';
                    if (misconfigured) {
                      className += 'bg-green-50 text-green-800 border-green-300 ring-2 ring-amber-300';
                    } else if (enabled) {
                      className += 'bg-green-100 text-green-800 border-green-300';
                    } else if (!available) {
                      className += 'bg-gray-50 text-gray-400 border-gray-200 opacity-60';
                    } else {
                      className += 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200';
                    }

                    const tooltip = !available
                      ? `${mode.name} is not available on ${sidecar.os} — vllm-metal doesn't support cross-encoders. Use a Linux+NVIDIA sidecar for reranking.`
                      : enabled
                        ? `Click to disable ${mode.name}`
                        : `Click to enable ${mode.name}`;

                    return (
                      <div key={mode.name} className="inline-flex items-center">
                        <button
                          type="button"
                          onClick={() => toggleMode(sidecar, mode)}
                          title={tooltip}
                          className={className}
                        >
                          <span>{enabled ? '✓' : '✗'}</span>
                          <span>{mode.name}</span>
                          {!available && <span className="text-amber-500" title={tooltip}>ⓘ</span>}
                        </button>
                        {enabled && (
                          <button
                            type="button"
                            onClick={() => setOpenPanel(panelOpen ? null : panelKey)}
                            title="Advanced settings"
                            className="ml-0.5 text-gray-400 hover:text-gray-700 text-sm leading-none px-1"
                          >
                            ⚙
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Per-host unavailable warnings */}
                {catalog
                  .filter((m) => !m.availableOn.includes(sidecar.os as ModeOs))
                  .map((m) => (
                    <p key={`warn-${m.name}`} className="mt-2 text-[11px] text-gray-500">
                      <span className="text-amber-500">ⓘ</span> {m.name} is not
                      available on {sidecar.os} — vllm-metal doesn't support
                      cross-encoders. Use a Linux+NVIDIA sidecar for reranking.
                    </p>
                  ))}

                <p className="text-[11px] text-gray-500 mt-2">Last synced {lastSyncLabel}</p>

                {/* Advanced panels */}
                {catalog.map((mode) => {
                  const panelKey = `${sidecar.url}::${mode.name}`;
                  if (openPanel !== panelKey) return null;
                  const assignment = assigns.find((a) => a.mode === mode.name);
                  if (!assignment?.enabled) return null;
                  return (
                    <AdvancedPanel
                      key={panelKey}
                      sidecar={sidecar}
                      mode={mode}
                      assignment={assignment}
                      onClose={() => setOpenPanel(null)}
                      onChange={(patch) => queueUpsert(sidecar.url, mode.name, patch)}
                      onSave={(patch) => {
                        upsertAssignment(sidecar.url, mode.name, patch);
                        setOpenPanel(null);
                      }}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {confirmReset && (
        <ConfirmDialog
          title={`Reset mode assignments on ${confirmReset.hostname}?`}
          message={`This will overwrite current assignments for ${confirmReset.hostname} with defaults appropriate for ${confirmReset.os}.\n\n${
            confirmReset.os === 'linux'
              ? 'All 4 modes will be enabled.'
              : 'ss-embedding, ss-completion and ss-ocr will be enabled; ss-reranker will be left disabled (not supported).'
          }`}
          confirmLabel="Reset"
          danger
          onCancel={() => setConfirmReset(null)}
          onConfirm={handleResetDefaults}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── AdvancedPanel ─────────────────────────── */

interface AdvancedPanelProps {
  sidecar: SidecarSummary;
  mode: ModeCatalogEntry;
  assignment: RoleAssignment;
  onClose: () => void;
  onChange: (patch: Partial<RoleAssignment>) => void;
  onSave: (patch: Partial<RoleAssignment>) => void;
}

function AdvancedPanel({ sidecar, mode, assignment, onClose, onSave }: AdvancedPanelProps) {
  const [modelOverride, setModelOverride] = useState<string>(assignment.modelOverride ?? '');
  const [minOnline, setMinOnline] = useState<number>(assignment.minOnline ?? 0);
  const [idleTimeoutMin, setIdleTimeoutMin] = useState<number>(assignment.idleTimeoutMin ?? 5);

  const defaultModel = mode.defaultModel?.[sidecar.os as ModeOs] || '';
  const loaded = sidecar.containers?.[mode.name]?.loadedModels?.map((m) => m.name).filter(Boolean) ?? [];
  const modelChoices = useMemo(
    () => Array.from(new Set([...(defaultModel ? [defaultModel] : []), ...loaded])),
    [defaultModel, loaded],
  );
  const listId = `model-list-${sidecar.url.replace(/[^a-z0-9]/gi, '_')}-${mode.name}`;

  const submit = () => {
    onSave({
      modelOverride: modelOverride.trim() ? modelOverride.trim() : null,
      minOnline,
      idleTimeoutMin,
      enabled: true,
    });
  };

  return (
    <div className="mt-3 border border-gray-200 rounded-md bg-gray-50 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-gray-800">
          {sidecar.hostname} / {mode.name}
        </h4>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-800">
          ✕
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-gray-600">Model override</span>
          <input
            type="text"
            list={listId}
            value={modelOverride}
            onChange={(e) => setModelOverride(e.target.value)}
            placeholder={defaultModel ? `inherit (${defaultModel})` : 'inherit'}
            className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
          />
          <datalist id={listId}>
            {modelChoices.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-gray-600">Min online</span>
          <input
            type="number"
            min={0}
            value={minOnline}
            onChange={(e) => setMinOnline(Number(e.target.value) || 0)}
            className="px-2 py-1 border border-gray-300 rounded text-xs w-24"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-gray-600">Idle timeout (min)</span>
          <input
            type="number"
            min={0}
            value={idleTimeoutMin}
            onChange={(e) => setIdleTimeoutMin(Number(e.target.value) || 0)}
            className="px-2 py-1 border border-gray-300 rounded text-xs w-24"
          />
        </label>
      </div>

      <div className="flex justify-end gap-2 mt-3">
        <button onClick={onClose} className="px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded-md">
          Cancel
        </button>
        <button
          onClick={submit}
          className="px-2.5 py-1 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-md"
        >
          Save & apply
        </button>
      </div>
    </div>
  );
}
