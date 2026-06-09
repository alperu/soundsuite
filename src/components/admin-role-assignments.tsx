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
import Link from 'next/link';
import { ConfirmDialog, type ModeCatalogEntry, type ModeOs } from '@/components/admin-role-types';
import { settingsPageForMode } from '@/lib/gpu/mode-catalog';

/* ─────────────────────────── Types ─────────────────────────── */

interface SidecarSummary {
  url: string;
  hostname: string;
  status: 'connected' | 'disconnected';
  os?: ModeOs | string;
  gpuSummary?: string;
  hasNvidia?: boolean;
  containers?: Record<string, { loadedModels?: Array<{ name: string; size?: number }> }>;
}

type RuntimeChoice = 'host' | 'docker-ollama' | 'docker-vllm' | 'docker-model-runner';

interface RoleAssignment {
  mode: string;
  enabled: boolean;
  minOnline?: number | null;
  idleTimeoutMin?: number | null;
  modelOverride?: string | null;
  runtime?: RuntimeChoice | null;
}

const RUNTIME_COLUMNS: Array<{ key: RuntimeChoice; short: string; label: string }> = [
  { key: 'host', short: 'host', label: 'Ollama (native)' },
  { key: 'docker-ollama', short: 'docker', label: 'Docker Ollama' },
  { key: 'docker-vllm', short: 'vllm', label: 'Docker vLLM' },
  { key: 'docker-model-runner', short: 'dmr', label: 'Docker Model Runner' },
];

/**
 * Default port each role binds on the sidecar host. For Ollama-backed roles
 * this is what the sidecar exposes for the per-role container (the host
 * native Ollama always shares 11434). For vLLM-backed roles this is the
 * container's listening port. Source of truth: sideCar/src/lib/state.ts
 * defaultRegistry and sideCar/src/lib/mode-templates.ts:resolveMode().
 */
const MODE_PORTS: Record<string, number> = {
  'ss-embedding': 11434,
  'ss-code-embedding': 11437,
  'ss-completion': 11435,
  'ss-ocr': 11436,
  'ss-reranker': 8099,
  'ss-rlm': 8100,
};

/**
 * Per-OS runtime availability. windows-docker-wsl2 runs Docker via WSL2 with
 * native NVIDIA passthrough — Docker Ollama and Docker vLLM both work; native
 * Ollama on Windows is not supported (operators always go through Docker).
 * mac-docker-ollama: Docker Desktop on Mac lacks GPU passthrough for plain
 * Docker containers, so docker-ollama and docker-vllm are unavailable; native
 * Ollama (host) and Docker Model Runner (vllm-metal) are the GPU-backed paths.
 */
function availableRuntimesForOs(
  os: ModeOs | string | undefined,
  _hasNvidia: boolean,
): Record<RuntimeChoice, boolean> {
  if (os === 'mac-docker-ollama') {
    return { host: true, 'docker-ollama': false, 'docker-vllm': false, 'docker-model-runner': true };
  }
  if (os === 'linux') {
    return { host: true, 'docker-ollama': true, 'docker-vllm': true, 'docker-model-runner': true };
  }
  if (os === 'windows-docker-wsl2') {
    return { host: false, 'docker-ollama': true, 'docker-vllm': true, 'docker-model-runner': true };
  }
  // Unknown OS — be permissive.
  return { host: true, 'docker-ollama': true, 'docker-vllm': true, 'docker-model-runner': true };
}

/**
 * Per-mode runtime applicability — which runtime *engines* can in principle
 * serve the role. OS-specific exclusions (e.g. ss-reranker is unavailable on
 * Mac because vllm-metal lacks the cross-encoder head) are handled separately
 * via `mode.availableOn`, so they don't need to be re-encoded here.
 *
 *   ss-reranker — vLLM cross-encoder. Runs on Docker vLLM (NVIDIA) and DMR on
 *                 Linux/Windows; Mac is already filtered out by availableOn.
 *   ss-rlm      — Any vLLM engine. Ollama excluded — no official GGUF yet.
 *   others      — Ollama-backed but also servable by DMR's vLLM. DMR is true
 *                 here as a UI affordance; sidecar resolution for non-rlm
 *                 roles on DMR is pending (task #11).
 */
function runtimesForMode(modeName: string): Record<RuntimeChoice, boolean> {
  if (modeName === 'ss-reranker') {
    return { host: false, 'docker-ollama': false, 'docker-vllm': true, 'docker-model-runner': true };
  }
  if (modeName === 'ss-rlm') {
    return { host: false, 'docker-ollama': false, 'docker-vllm': true, 'docker-model-runner': true };
  }
  return { host: true, 'docker-ollama': true, 'docker-vllm': true, 'docker-model-runner': true };
}

/** OS-aware default runtime for the "Reset to defaults" path. */
function defaultRuntimeForRow(
  modeName: string,
  os: ModeOs | string | undefined,
  hasNvidia: boolean,
): RuntimeChoice {
  if (modeName === 'ss-reranker') return 'docker-vllm';
  if (modeName === 'ss-rlm') {
    return os === 'mac-docker-ollama' ? 'docker-model-runner' : 'docker-vllm';
  }
  if (os === 'mac-docker-ollama') return 'host';
  if (os === 'windows-docker-wsl2') return 'docker-ollama';
  return 'docker-ollama';
}

/**
 * Back-compat default: rows persisted before the `runtime` column existed
 * come back with `runtime === null`. We treat that as 'host' on
 * mac-docker-ollama and 'docker-ollama' elsewhere — matches what fleet
 * behavior was already doing implicitly.
 */
function resolveRuntime(
  assignment: RoleAssignment | undefined,
  os: ModeOs | string | undefined,
): RuntimeChoice | null {
  if (!assignment?.enabled) return null;
  if (assignment.runtime) return assignment.runtime;
  return os === 'mac-docker-ollama' ? 'host' : 'docker-ollama';
}

type Toast = { type: 'success' | 'error' | 'warning'; text: string } | null;

// Fallback used when /api/admin/mode-catalog is unreachable. Intentionally
// empty `defaultModel` — the API is the source of truth for live values
// (it reads from the Config table). If the UI baked in fallback model
// strings they'd drift from whatever the operator actually configured on
// the settings pages, so the "inherit (<model>)" hint would lie. When
// offline we show "inherit" with no model + a "backend offline" badge.
const FALLBACK_MODES: ModeCatalogEntry[] = [
  { name: 'ss-embedding', label: 'Text embedding', availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'], defaultModel: {} },
  { name: 'ss-code-embedding', label: 'Code Embedding', availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'], defaultModel: {} },
  { name: 'ss-completion', label: 'Completion', availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'], defaultModel: {} },
  { name: 'ss-ocr', label: 'OCR', availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'], defaultModel: {} },
  { name: 'ss-reranker', label: 'Reranker', availableOn: ['linux', 'windows-docker-wsl2'], defaultModel: {} },
  { name: 'ss-rlm', label: 'RLM', availableOn: ['linux', 'windows-docker-wsl2'], defaultModel: {} },
];

const RESET_DEFAULTS: Record<string, { minOnline: number; idleTimeoutMin: number }> = {
  'ss-embedding': { minOnline: 1, idleTimeoutMin: 0 },
  'ss-code-embedding': { minOnline: 0, idleTimeoutMin: 5 },
  'ss-completion': { minOnline: 1, idleTimeoutMin: 10 },
  'ss-ocr': { minOnline: 1, idleTimeoutMin: 5 },
  'ss-reranker': { minOnline: 0, idleTimeoutMin: 5 },
  'ss-rlm': { minOnline: 0, idleTimeoutMin: 10 },
};

/* ─────────────────────────── Helpers ─────────────────────────── */

function inferOs(
  hostname: string | undefined,
  declared: string | undefined,
  override?: string | null,
): ModeOs {
  // Operator override from /admin/host-provisioning wins over everything.
  if (override === 'linux' || override === 'mac-docker-ollama' || override === 'windows-docker-wsl2') return override;
  if (declared === 'linux' || declared === 'mac-docker-ollama' || declared === 'windows-docker-wsl2') return declared;
  // Tolerate legacy declared values from older sidecars that still report
  // os: 'darwin' | 'win32' over the wire.
  if (declared === 'darwin') return 'mac-docker-ollama';
  if (declared === 'win32') return 'windows-docker-wsl2';
  const h = (hostname || '').toLowerCase();
  if (h.includes('mac') || h.endsWith('.local')) return 'mac-docker-ollama';
  if (h.includes('win') || h.includes('wsl')) return 'windows-docker-wsl2';
  return 'linux';
}

/** Friendly OS labels — same convention as /admin/host-provisioning. */
function osDisplayLabel(os: ModeOs | string | undefined): string {
  if (os === 'mac-docker-ollama') return 'Mac Docker (Ollama)';
  if (os === 'windows-docker-wsl2') return 'Windows Docker (WSL2)';
  if (os === 'linux') return 'Linux';
  return 'Unknown';
}

function normalizeAssignment(raw: any): RoleAssignment | null {
  const mode = raw?.mode || raw?.roleType?.name || raw?.roleTypeName;
  if (!mode) return null;
  const rt = typeof raw.runtime === 'string' ? raw.runtime : null;
  const runtime: RuntimeChoice | null =
    rt === 'host' || rt === 'docker-ollama' || rt === 'docker-vllm' ? rt : null;
  return {
    mode,
    enabled: raw.enabled !== false,
    minOnline: raw.minOnline ?? null,
    idleTimeoutMin: raw.idleTimeoutMin ?? null,
    modelOverride: raw.modelOverride ?? null,
    runtime,
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
      // Fetch host-provisioning overrides in parallel — operator's pinned OS
      // takes precedence over auto-detection from Docker /info.
      const [fleetRes, provRes] = await Promise.all([
        fetch('/api/admin/gpu-fleet'),
        fetch('/api/admin/host-provisioning').catch(() => null),
      ]);
      if (!fleetRes.ok) throw new Error(`gpu-fleet HTTP ${fleetRes.status}`);
      const data = await fleetRes.json();
      const overrideByUrl: Record<string, string | null> = {};
      if (provRes && provRes.ok) {
        try {
          const provData = await provRes.json();
          for (const p of provData?.provisioning || []) {
            if (p?.sidecarUrl) overrideByUrl[p.sidecarUrl] = p.hostOsOverride ?? null;
          }
        } catch { /* ignore */ }
      }
      const list: SidecarSummary[] = (data.sidecars || []).map((s: any) => {
        const cached = s.sidecarStatus || {};
        const override = overrideByUrl[s.url] ?? null;
        const os = inferOs(s.hostname || s.url, cached.host?.os, override);
        const gpus: any[] = Array.isArray(cached.gpus) ? cached.gpus : [];
        const hasNvidia = gpus.some((g) => /nvidia/i.test(g?.name || ''));
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
          hasNvidia,
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

  // Re-fetch catalog on window focus so changes made on the linked settings
  // pages (Embedding / AI / OCR / Reranking) are reflected immediately when
  // the operator tabs back here.
  useEffect(() => {
    const onFocus = () => {
      loadCatalog();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadCatalog]);

  /* ─────────────────────────── Periodic auto-sync ─────────────────────────── */
  // Push each sidecar's role assignments every 30 seconds — but ONLY when
  // the desired state has actually changed since the last push. The hash
  // collapses (mode, enabled, minOnline, idleTimeoutMin, modelOverride) for
  // every enabled row plus the catalog model defaults that resolve to
  // implicit overrides server-side. Hash match → no network call, no toast,
  // no spinner. Hash mismatch → silent /sync POST (sync errors go to console;
  // we don't toast every 30s for a flaky sidecar — manual "Sync now" still
  // toasts loudly).

  // Last-pushed hash per sidecar URL. Ref, not state, so it doesn't trigger
  // re-renders.
  const lastSyncedHashRef = useRef<Record<string, string>>({});
  // Per-sidecar "auto-syncing now" indicator for the UI.
  const [autoSyncing, setAutoSyncing] = useState<Record<string, boolean>>({});

  const computeAssignmentHash = useCallback(
    (rows: RoleAssignment[] | undefined): string => {
      if (!rows || rows.length === 0) return '∅';
      // Stable order: sort by mode name. Include only enabled rows because
      // sync filters to enabled — disabled rows don't affect the wire payload.
      const stable = rows
        .filter((r) => r.enabled !== false)
        .map((r) => `${r.mode}|on=${r.enabled ?? true}|min=${r.minOnline ?? ''}|idle=${r.idleTimeoutMin ?? ''}|m=${r.modelOverride ?? ''}|rt=${r.runtime ?? ''}`)
        .sort()
        .join(';');
      return stable;
    },
    [],
  );

  const silentSync = useCallback(
    async (sidecarUrl: string): Promise<boolean> => {
      try {
        const res = await fetch(
          `/api/admin/role-assignments/sync?sidecarUrl=${encodeURIComponent(sidecarUrl)}`,
          { method: 'POST' },
        );
        if (!res.ok && res.status !== 404) {
          // Background sync — log to console, don't toast (would spam every 30s
          // for a single flaky host). The lastSyncedAt indicator stays stale,
          // which is itself a visible cue something is wrong.
          // eslint-disable-next-line no-console
          console.warn(`auto-sync ${sidecarUrl}: HTTP ${res.status}`);
          return false;
        }
        setLastSyncedAt((m) => ({ ...m, [sidecarUrl]: Date.now() }));
        return true;
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn(`auto-sync ${sidecarUrl} failed:`, e);
        return false;
      }
    },
    [],
  );

  useEffect(() => {
    if (sidecars.length === 0) return;

    const tick = async () => {
      // Snapshot current state under closure to avoid stale-state races.
      const queue = sidecars.map((s) => s.url);
      for (let i = 0; i < queue.length; i++) {
        const url = queue[i];
        const desired = computeAssignmentHash(assignmentsByUrl[url]);
        const lastPushed = lastSyncedHashRef.current[url];
        if (desired === lastPushed) continue; // no-op — most ticks land here

        // Stagger pushes 200ms apart so a fleet of N sidecars doesn't burst.
        if (i > 0) await new Promise((r) => setTimeout(r, 200));

        setAutoSyncing((m) => ({ ...m, [url]: true }));
        const ok = await silentSync(url);
        setAutoSyncing((m) => {
          const next = { ...m };
          delete next[url];
          return next;
        });
        if (ok) lastSyncedHashRef.current[url] = desired;
      }
    };

    // First tick offset by a small jitter so freshly-mounted pages don't all
    // hit the server at second 0; subsequent ticks are exactly 30s apart.
    const jitterMs = Math.floor(Math.random() * 4_000);
    const firstTimer = setTimeout(() => {
      void tick();
      // Then steady cadence.
    }, jitterMs);
    const interval = setInterval(() => void tick(), 30_000);

    return () => {
      clearTimeout(firstTimer);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidecars, assignmentsByUrl, computeAssignmentHash, silentSync]);

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
      // Manual sync also seeds the hash so the next periodic tick can skip
      // this sidecar until something actually changes.
      lastSyncedHashRef.current[sidecarUrl] = computeAssignmentHash(
        assignmentsByUrl[sidecarUrl],
      );
    } catch (e: any) {
      showToast({ type: 'error', text: `Sync failed: ${e?.message || e}` });
    }
  }, [showToast, assignmentsByUrl, computeAssignmentHash]);

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
        runtime: patch.runtime ?? current?.runtime ?? null,
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
            runtime: defaultRuntimeForRow(m.name, sidecar.os, !!sidecar.hasNvidia),
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
        enabled chip to override per-host model or runtime settings.{' '}
        <span className="text-blue-700">See the right panel for what each runtime column means.</span>
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
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200"
                      title={`os=${sidecar.os}`}
                    >
                      {osDisplayLabel(sidecar.os)}
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

                {(() => {
                  const osAvailable = availableRuntimesForOs(sidecar.os, !!sidecar.hasNvidia);
                  return (
                    <div className="overflow-x-auto">
                      <table className="text-xs w-full border-separate" style={{ borderSpacing: 0 }}>
                        <thead>
                          <tr className="text-[11px] text-gray-500">
                            <th className="text-left font-medium py-1 pr-3">Role</th>
                            <th className="text-center font-medium py-1 px-2" title="Default port the role binds on the sidecar host">Port</th>
                            {RUNTIME_COLUMNS.map((col) => {
                              const colAvail = osAvailable[col.key];
                              return (
                                <th
                                  key={col.key}
                                  className={`text-center font-medium py-1 px-2 ${colAvail ? '' : 'text-gray-300'}`}
                                  title={colAvail ? col.label : 'No GPU passthrough in Docker Desktop on this host'}
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
                          {catalog.map((mode) => {
                            const assignment = assigns.find((a) => a.mode === mode.name);
                            const selectedRuntime = resolveRuntime(assignment, sidecar.os);
                            const modeRuntimes = runtimesForMode(mode.name);
                            const modeAvailableOnHost = mode.availableOn.includes(sidecar.os as ModeOs);
                            const panelKey = `${sidecar.url}::${mode.name}`;
                            const panelOpen = openPanel === panelKey;
                            const enabled = !!assignment?.enabled;

                            return (
                              <tr key={mode.name} className="border-t border-gray-100">
                                <td className="py-1.5 pr-3">
                                  <span className="font-mono text-gray-800">{mode.name}</span>
                                  {!modeAvailableOnHost && (
                                    <span
                                      className="ml-1 text-amber-500"
                                      title={`${mode.name} is not supported on ${sidecar.os} — vllm-metal lacks cross-encoder support. Use a Linux+NVIDIA sidecar for reranking.`}
                                    >
                                      ⓘ
                                    </span>
                                  )}
                                </td>
                                <td className="text-center py-1.5 px-2">
                                  {MODE_PORTS[mode.name] != null ? (
                                    <span className="font-mono text-gray-600 text-[11px]" title="Default port — overridable per host">
                                      {MODE_PORTS[mode.name]}
                                    </span>
                                  ) : (
                                    <span className="text-gray-300">—</span>
                                  )}
                                </td>
                                {RUNTIME_COLUMNS.map((col) => {
                                  const colAvail = osAvailable[col.key] && modeRuntimes[col.key] && modeAvailableOnHost;
                                  const checked = enabled && selectedRuntime === col.key;
                                  const inputId = `${sidecar.url}::${mode.name}::${col.key}`;
                                  let tooltip: string;
                                  if (!modeRuntimes[col.key]) {
                                    tooltip = `${mode.name} cannot run on ${col.label}.`;
                                  } else if (!osAvailable[col.key]) {
                                    tooltip = sidecar.os === 'mac-docker-ollama'
                                      ? 'Mac Docker Desktop has no GPU passthrough for plain Ollama/vLLM containers — use host Ollama (or DMR/vllm-metal).'
                                      : 'Not available on this host.';
                                  } else if (col.key === 'docker-model-runner' && mode.name !== 'ss-rlm') {
                                    tooltip = `Run ${mode.name} via ${col.label}. Note: sidecar DMR resolution for ${mode.name} is pending — model picker will set the override but the container won't start until that ships.`;
                                  } else {
                                    tooltip = `Run ${mode.name} via ${col.label}`;
                                  }
                                  return (
                                    <td key={col.key} className="text-center py-1.5 px-2">
                                      <input
                                        id={inputId}
                                        type="radio"
                                        name={`rt-${sidecar.url}-${mode.name}`}
                                        disabled={!colAvail}
                                        checked={checked}
                                        onChange={() => {
                                          if (!colAvail) return;
                                          upsertAssignment(sidecar.url, mode.name, {
                                            enabled: true,
                                            runtime: col.key,
                                          });
                                        }}
                                        title={tooltip}
                                        className={`accent-green-600 ${colAvail ? 'cursor-pointer' : 'cursor-not-allowed opacity-30'}`}
                                      />
                                    </td>
                                  );
                                })}
                                <td className="text-center py-1.5 px-2">
                                  <input
                                    type="radio"
                                    name={`rt-${sidecar.url}-${mode.name}`}
                                    checked={!enabled}
                                    onChange={() => {
                                      if (assignment) deleteAssignment(sidecar.url, mode.name);
                                    }}
                                    title={`Disable ${mode.name} on this sidecar`}
                                    className="accent-gray-400 cursor-pointer"
                                  />
                                </td>
                                <td className="py-1.5 pl-2 text-right">
                                  {enabled && (
                                    <button
                                      type="button"
                                      onClick={() => setOpenPanel(panelOpen ? null : panelKey)}
                                      title="Advanced settings"
                                      className="text-gray-400 hover:text-gray-700 text-sm leading-none px-1"
                                    >
                                      ⚙
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}

                {/* Loaded-on-host hint — deduplicated across containers since
                    host Ollama exposes the same model list to every role. Lets
                    the operator eyeball whether the role's resolved model is
                    actually installed. */}
                {(() => {
                  const all: Array<{ name: string; size?: number }> = [];
                  const seen = new Set<string>();
                  for (const c of Object.values(sidecar.containers || {})) {
                    for (const m of (c?.loadedModels || []) as Array<{ name: string; size?: number }>) {
                      if (!m?.name || seen.has(m.name)) continue;
                      seen.add(m.name);
                      all.push(m);
                    }
                  }
                  if (all.length === 0) return null;
                  const fmtSize = (b?: number) => {
                    if (!b || !Number.isFinite(b)) return '';
                    const gb = b / 1024 ** 3;
                    return gb >= 0.1 ? ` (${gb.toFixed(1)} GB)` : '';
                  };
                  return (
                    <div className="mt-2 text-[11px] text-gray-600">
                      <span className="text-gray-500">Currently loaded on {sidecar.hostname}:</span>{' '}
                      <span className="font-mono">
                        {all.map((m, i) => (
                          <span key={m.name}>
                            {i > 0 && ', '}
                            {m.name}
                            {fmtSize(m.size)}
                          </span>
                        ))}
                      </span>
                    </div>
                  );
                })()}

                <p className="text-[11px] text-gray-500 mt-2 flex items-center gap-1.5">
                  Last synced {lastSyncLabel}
                  {autoSyncing[sidecar.url] && (
                    <span
                      className="inline-flex items-center gap-1 text-blue-600"
                      title="Auto-sync runs every 30s when assignments change."
                    >
                      <span className="inline-block w-1 h-1 rounded-full bg-blue-500 animate-pulse" />
                      auto-syncing…
                    </span>
                  )}
                </p>

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
              ? 'All available modes will be enabled.'
              : 'ss-embedding, ss-code-embedding, ss-completion and ss-ocr will be enabled; ss-reranker and ss-rlm will be left disabled (not supported).'
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
  const source = settingsPageForMode(mode.name);
  // Loaded models reported by the sidecar for this role's container. Host
  // Ollama shares one endpoint across roles, so dedupe across all containers
  // — this is what's actually installed on the host and ready to be picked.
  const loadedOnHost = useMemo(() => {
    const all: string[] = [];
    const containers = sidecar.containers || {};
    for (const c of Object.values(containers)) {
      const names = c?.loadedModels?.map((m) => m.name).filter(Boolean) ?? [];
      all.push(...names);
    }
    return Array.from(new Set(all));
  }, [sidecar.containers]);
  const modelChoices = useMemo(
    () => Array.from(new Set([...(defaultModel ? [defaultModel] : []), ...loadedOnHost])),
    [defaultModel, loadedOnHost],
  );
  const listId = `model-list-${sidecar.url.replace(/[^a-z0-9]/gi, '_')}-${mode.name}`;
  const hasOverride = !!assignment.modelOverride;

  const submit = () => {
    onSave({
      modelOverride: modelOverride.trim() ? modelOverride.trim() : null,
      minOnline,
      idleTimeoutMin,
      enabled: true,
    });
  };

  const clearOverride = () => {
    setModelOverride('');
    onSave({
      modelOverride: null,
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
          <span className="flex items-center gap-1 text-gray-600">
            Model override
            {hasOverride && (
              <button
                type="button"
                onClick={clearOverride}
                title="Clear override and inherit the catalog default"
                className="text-[10px] text-red-600 hover:text-red-800 underline"
              >
                × clear
              </button>
            )}
          </span>
          <input
            type="text"
            list={listId}
            value={modelOverride}
            onChange={(e) => setModelOverride(e.target.value)}
            placeholder={defaultModel ? `inherit (${defaultModel})` : 'inherit (backend offline)'}
            className="px-2 py-1 border border-gray-300 rounded text-xs font-mono"
          />
          <datalist id={listId}>
            {modelChoices.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <span className="text-[10px] text-gray-500">
            {defaultModel ? (
              <>
                Inherits <span className="font-mono">{defaultModel}</span>
                {source && (
                  <>
                    {' '}— configured at{' '}
                    <Link
                      href={source.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 underline"
                    >
                      {source.label} ↗
                    </Link>
                  </>
                )}
              </>
            ) : source ? (
              <>
                No catalog default available —{' '}
                <Link
                  href={source.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 underline"
                >
                  configure at {source.label} ↗
                </Link>
              </>
            ) : (
              'No catalog default available.'
            )}
          </span>
          {loadedOnHost.length > 0 && (
            <div className="mt-1 border-t border-gray-200 pt-1">
              <div className="text-[10px] font-semibold text-gray-600 mb-0.5">
                Loaded on this host
              </div>
              <ul className="space-y-0.5">
                {loadedOnHost.map((m) => (
                  <li key={m}>
                    <button
                      type="button"
                      onClick={() => setModelOverride(m)}
                      className="font-mono text-[11px] text-blue-700 hover:underline text-left"
                      title="Use this model as the override"
                    >
                      {m}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
