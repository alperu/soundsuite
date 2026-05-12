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

type Preset = 'ollama' | 'dmr' | 'both' | 'custom';

const ROLE_HINT: Record<string, string> = {
  embedding: 'Vector embeddings for indexing & search',
  completion: 'LLM chat / summarization',
  ocr: 'Image-to-text for scanned PDFs',
  reranker: 'Search result reranking (requires vLLM — Ollama cannot serve this)',
};

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

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingOs, setSavingOs] = useState(false);
  const [savingBackend, setSavingBackend] = useState(false);
  const [osOverrideOpen, setOsOverrideOpen] = useState(false);

  const [preset, setPreset] = useState<Preset>('ollama');
  const [ollamaRoles, setOllamaRoles] = useState<Set<string>>(new Set(['embedding', 'completion', 'ocr']));
  const [dmrRoles, setDmrRoles] = useState<Set<string>>(new Set(['reranker']));
  const [budgetMb, setBudgetMb] = useState<number>(16384);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/setup-status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SetupStatus = await res.json();
      setStatus(data);
      setError(null);
      // Seed editor from server state on first load.
      setOllamaRoles((prev) => {
        if (prev.size > 0 && data.hostOllama.roles.length === 0) return prev;
        return new Set(data.hostOllama.roles.length ? data.hostOllama.roles : ['embedding', 'completion', 'ocr']);
      });
      setDmrRoles((prev) => {
        if (prev.size > 0 && data.dmr.roles.length === 0) return prev;
        return new Set(data.dmr.roles.length ? data.dmr.roles : ['reranker']);
      });
      if (data.hostOllama.budgetMb > 0) setBudgetMb(data.hostOllama.budgetMb);

      // Detect preset.
      const oll = data.hostOllama.enabled && data.hostOllama.roles.length > 0;
      const dmrOn = data.dmr.enabled && data.dmr.roles.length > 0;
      if (oll && dmrOn) setPreset('both');
      else if (dmrOn) setPreset('dmr');
      else if (oll) setPreset('ollama');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 5000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  const applyPreset = (p: Preset) => {
    setPreset(p);
    if (p === 'ollama') {
      setOllamaRoles(new Set(['embedding', 'completion', 'ocr']));
      setDmrRoles(new Set());
    } else if (p === 'dmr') {
      setOllamaRoles(new Set());
      setDmrRoles(new Set(['reranker', 'embedding']));
    } else if (p === 'both') {
      setOllamaRoles(new Set(['embedding', 'completion', 'ocr']));
      setDmrRoles(new Set(['reranker']));
    }
  };

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
      const res = await fetch('/api/host-backend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostOllamaEnabled: ollamaRoles.size > 0,
          hostOllamaRoles: Array.from(ollamaRoles),
          hostOllamaBudgetMb: budgetMb,
          dmrEnabled: dmrRoles.size > 0,
          dmrRoles: Array.from(dmrRoles),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedFlash('Backend configuration saved');
      setTimeout(() => setSavedFlash(null), 2500);
      fetchStatus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingBackend(false);
    }
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

  const { host, hostOllama, dmr, installHints, knownRoles } = status;
  const showBackendSelector = host.os !== 'linux';
  // "Ambiguous" = Docker Desktop on x86_64 (could be Intel Mac or Windows).
  // We expand this to also catch the case where detection returned 'unknown'
  // with confidence 'low' — that happens on some Docker Desktop versions
  // whose /info doesn't report `OperatingSystem: "Docker Desktop"` exactly
  // as expected, leaving us blind. In both cases the operator must pick.
  const ambiguous = host.os === 'unknown' || host.osConfidence === 'low';
  const highConfidence = host.osConfidence === 'env' || host.osConfidence === 'docker-info' || host.osConfidence === 'override';

  const toggleRole = (set: Set<string>, setter: (s: Set<string>) => void, role: string) => {
    const next = new Set(set);
    if (next.has(role)) next.delete(role);
    else next.add(role);
    setter(next);
    setPreset('custom');
  };

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

      {/* ── Section 2: Backend selector ───────────────────────────────── */}
      {showBackendSelector ? (
        <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-base font-semibold text-slate-800">2. Runtime backend</h2>
          <p className="mt-1 text-xs text-slate-500">
            On Docker Desktop, GPU passthrough is unavailable inside containers.
            Pick one or both host runtimes to serve roles natively.
          </p>

          <div className="mt-4 space-y-3">
            {/* Preset 1 — Ollama */}
            <label className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${preset === 'ollama' ? 'border-blue-400 bg-blue-50' : 'border-slate-200'}`}>
              <input
                type="radio"
                name="preset"
                checked={preset === 'ollama'}
                onChange={() => applyPreset('ollama')}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-800">Native Ollama (Metal / CUDA)</div>
                <div className="text-xs text-slate-500">
                  Recommended for Mac. Serves embedding / completion / OCR via {hostOllama.host}:11434.
                  Reranker NOT supported by Ollama.
                </div>
              </div>
            </label>

            {/* Preset 2 — DMR */}
            <label className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${preset === 'dmr' ? 'border-blue-400 bg-blue-50' : 'border-slate-200'}`}>
              <input
                type="radio"
                name="preset"
                checked={preset === 'dmr'}
                onChange={() => applyPreset('dmr')}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-800">Docker Model Runner (vllm-metal)</div>
                <div className="text-xs text-slate-500">
                  Use when you need the reranker. Requires Docker Model Runner enabled in Docker Desktop.
                </div>
              </div>
            </label>

            {/* Preset 3 — Both (Mac only) */}
            {host.os === 'darwin' && (
              <label className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${preset === 'both' ? 'border-blue-400 bg-blue-50' : 'border-slate-200'}`}>
                <input
                  type="radio"
                  name="preset"
                  checked={preset === 'both'}
                  onChange={() => applyPreset('both')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-slate-800">Both — best of both</div>
                  <div className="text-xs text-slate-500">
                    Ollama for embedding / completion / OCR + DMR for reranker.
                  </div>
                </div>
              </label>
            )}
          </div>

          {/* Per-role checkboxes (advanced) */}
          <div className="mt-5 rounded border border-slate-200 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Per-role assignment (advanced)
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2 font-medium">Ollama</th>
                  <th className="pb-2 font-medium">DMR</th>
                  <th className="pb-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {knownRoles.map((r) => {
                  const isReranker = r.role === 'reranker';
                  return (
                    <tr key={r.role} className="border-t border-slate-100">
                      <td className="py-2 capitalize text-slate-700">{r.role}</td>
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={ollamaRoles.has(r.role)}
                          disabled={isReranker}
                          onChange={() => toggleRole(ollamaRoles, setOllamaRoles, r.role)}
                        />
                      </td>
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={dmrRoles.has(r.role)}
                          onChange={() => toggleRole(dmrRoles, setDmrRoles, r.role)}
                        />
                      </td>
                      <td className="py-2 text-xs text-slate-500">{ROLE_HINT[r.role] || ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* VRAM budget */}
          <div className="mt-4 flex items-center gap-3">
            <label className="text-sm text-slate-700">Ollama VRAM budget (MB):</label>
            <input
              type="number"
              min={0}
              step={512}
              value={budgetMb}
              onChange={(e) => setBudgetMb(parseInt(e.target.value || '0', 10) || 0)}
              className="w-28 rounded border border-slate-300 px-2 py-1 text-sm"
            />
            <span className="text-xs text-slate-500">
              0 = unknown (planner falls back to per-role declared VRAM). 24 GB Mac → ~16384.
            </span>
          </div>

          {/* Save */}
          <div className="mt-5 flex items-center justify-end gap-3">
            <button
              onClick={saveBackend}
              disabled={savingBackend}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {savingBackend ? 'Saving...' : 'Save & Apply'}
            </button>
          </div>

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
      ) : (
        <section className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-base font-semibold text-slate-800">2. Runtime backend</h2>
          <p className="mt-1 text-xs text-slate-500">
            Linux host detected. Docker handles GPU containers natively via NVIDIA Container Toolkit — no
            host-runtime selection needed.
          </p>
        </section>
      )}

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
