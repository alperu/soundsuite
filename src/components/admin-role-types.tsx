'use client';

/**
 * AdminRoleTypes — read-only Mode Types reference.
 *
 * The 4-mode catalog (ss-embedding, ss-completion, ss-ocr, ss-reranker) is
 * server-defined and resolved per-OS by the sidecar. Each mode's default
 * model is configured on its own dedicated settings page — this table
 * surfaces a "configured at ↗" chip so the operator can click straight
 * through to the page that owns the value.
 *
 * Source: GET /api/admin/mode-catalog (live values from the Config table).
 * The fallback catalog used when the API is unreachable has NO default
 * models — we show "—" + "backend offline" rather than stale baked-in
 * strings, so the UI never lies about what the sidecar will load.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { settingsPageForMode } from '@/lib/gpu/mode-catalog';

/* ─────────────────────────── Public types ─────────────────────────── */

export type ModeOs = 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2';

export interface ModeCatalogEntry {
  name: string;
  label?: string;
  availableOn: ModeOs[];
  defaultModel: Partial<Record<ModeOs, string>>;
  description?: string;
}

/** Legacy shape kept for backwards-compat with other importers. */
export interface RoleType {
  id?: string;
  name: string;
  type?: 'ollama' | 'vllm' | 'utility';
  image?: string;
  model?: string | null;
  port?: number;
  vram?: number;
  modes?: string[];
  gpuOnly?: boolean;
  priority?: 'critical' | 'high' | 'normal';
  description?: string;
}

/* ─────────────────────────── Fallback (no model strings) ───────────────────────────
 * Intentionally empty `defaultModel` — when /api/admin/mode-catalog is
 * unreachable we show "—" + a "backend offline" badge rather than baked-in
 * strings that might disagree with what the operator configured.
 */
const FALLBACK_CATALOG_NO_DEFAULTS: ModeCatalogEntry[] = [
  {
    name: 'ss-embedding',
    label: 'Text embedding',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    defaultModel: {},
    description: 'Document and query embedding via Ollama. Lightweight; used in both indexing and search.',
  },
  {
    name: 'ss-code-embedding',
    label: 'Code Embedding',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    defaultModel: {},
    description: 'Code-aware embedding via Ollama for agent/code search. Separate from text embedding.',
  },
  {
    name: 'ss-completion',
    label: 'Completion',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    defaultModel: {},
    description: 'Chat completion via Ollama. Used at search time.',
  },
  {
    name: 'ss-ocr',
    label: 'OCR',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    defaultModel: {},
    description: 'Visual OCR for low-density PDF pages and exhibit images.',
  },
  {
    name: 'ss-reranker',
    label: 'Reranker (cross-encoder)',
    availableOn: ['linux', 'windows-docker-wsl2'],
    defaultModel: {},
    description: "vLLM cross-encoder reranker. Linux native or Windows Docker (WSL2). Mac unsupported — vllm-metal lacks cross-encoder support.",
  },
  {
    name: 'ss-rlm',
    label: 'RLM (recursive reasoning)',
    availableOn: ['linux', 'windows-docker-wsl2'],
    defaultModel: {},
    description: 'Recursive Language Model (Qwen3-8B post-trained) for deep long-context reasoning. Served via Docker vLLM on Linux/Windows+NVIDIA.',
  },
  {
    name: 'ss-rlm-sandbox',
    label: 'RLM Sandbox (hosted pattern)',
    availableOn: ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'],
    defaultModel: {},
    description: 'Fallback for ss-rlm: runs the recursive-reasoning pattern against a hosted OpenRouter chat model instead of self-hosting the RLM fine-tune. Not a local inference server — ~0 VRAM.',
  },
];

const OS_LABEL: Record<ModeOs, string> = {
  linux: 'Linux',
  'mac-docker-ollama': 'Mac Docker (Ollama)',
  'windows-docker-wsl2': 'Windows Docker (WSL2)',
};

/* ─────────────────────────── Component ─────────────────────────── */

export default function AdminRoleTypes() {
  const [catalog, setCatalog] = useState<ModeCatalogEntry[]>(FALLBACK_CATALOG_NO_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [backendOffline, setBackendOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-mode "add a model" input state — keyed by mode name. Draft text the
  // operator is typing before Save; cleared on successful save (the saved
  // value then comes back through `catalog` on reload).
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({});
  const [savingMode, setSavingMode] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/mode-catalog');
      if (res.status === 404) {
        setBackendOffline(true);
        setCatalog(FALLBACK_CATALOG_NO_DEFAULTS);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const modes: ModeCatalogEntry[] = Array.isArray(data?.modes) ? data.modes : [];
      if (modes.length > 0) {
        setCatalog(modes);
        setBackendOffline(false);
      } else {
        setCatalog(FALLBACK_CATALOG_NO_DEFAULTS);
        setBackendOffline(true);
      }
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
      setCatalog(FALLBACK_CATALOG_NO_DEFAULTS);
      setBackendOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Persist a mode's default model via the existing role-assignment/config
   * path (POST /api/admin/mode-catalog → setConfigValue on the SAME Config
   * key the mode's dedicated settings page owns — see that route's header
   * comment). Not a parallel storage mechanism.
   */
  const saveModel = useCallback(
    async (mode: string) => {
      const model = (modelDrafts[mode] ?? '').trim();
      if (!model) return;
      setSavingMode(mode);
      setSaveError((prev) => ({ ...prev, [mode]: '' }));
      try {
        const res = await fetch('/api/admin/mode-catalog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, model }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setModelDrafts((prev) => ({ ...prev, [mode]: '' }));
        await load();
      } catch (e: any) {
        setSaveError((prev) => ({ ...prev, [mode]: e?.message || String(e) }));
      } finally {
        setSavingMode(null);
      }
    },
    [modelDrafts, load],
  );

  // Re-fetch when the tab regains focus — operator may have just edited the
  // source settings page and tabbed back; the live value should appear
  // without a manual refresh.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-900">
        <strong>Mode Types</strong> are a fixed catalog. The default model for
        each mode is configured on its own settings page — click the chip in
        the table to jump there. Use <em>Role Assignments</em> to override per
        host.
      </div>

      {backendOffline && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 text-sm text-yellow-900">
          <code>/api/admin/mode-catalog</code> unreachable — live default models
          can&apos;t be shown. Visit the linked settings page directly to view or
          change the value.
        </div>
      )}

      {error && !backendOffline && (
        <div className="bg-red-50 text-red-800 border border-red-200 rounded-md p-3 text-sm">
          {error}{' '}
          <button onClick={load} className="ml-2 underline">
            Retry
          </button>
        </div>
      )}

      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Mode Types</h2>
          <button onClick={load} className="text-sm text-blue-600 hover:text-blue-800">
            Refresh
          </button>
        </div>

        {loading ? (
          <div className="text-gray-500 py-8 text-center">Loading mode catalog...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 font-medium text-gray-600 w-40">Mode</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Default model</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600 w-44">Available on</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((m) => {
                  const allOses: ModeOs[] = ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'];
                  const onlyLinux = m.availableOn.length === 1 && m.availableOn[0] === 'linux';
                  const source = settingsPageForMode(m.name);
                  // Collapse per-OS values when they're all identical — most
                  // modes use the same model on every OS, so a single row is
                  // less noisy than three.
                  const availableValues = m.availableOn
                    .map((os) => m.defaultModel?.[os])
                    .filter((v): v is string => !!v);
                  const allSame =
                    availableValues.length > 0 &&
                    availableValues.every((v) => v === availableValues[0]);

                  return (
                    <tr key={m.name} className="border-b border-gray-100 align-top">
                      <td className="py-3 px-3">
                        <div className="font-mono text-sm font-medium text-gray-900">{m.name}</div>
                        {m.description && (
                          <div className="text-[11px] text-gray-500 mt-1">{m.description}</div>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        {backendOffline ? (
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-gray-400">—</span>
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-50 text-yellow-800 border border-yellow-200">
                              backend offline
                            </span>
                            {source && (
                              <Link
                                href={source.href}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100"
                              >
                                {source.label} <span aria-hidden>↗</span>
                              </Link>
                            )}
                          </div>
                        ) : allSame ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs text-gray-800">{availableValues[0]}</span>
                            {source && (
                              <Link
                                href={source.href}
                                title={`Configured at ${source.label} (Config key: ${source.configKey})`}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100"
                              >
                                {source.label} <span aria-hidden>↗</span>
                              </Link>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-1">
                            <ul className="space-y-0.5">
                              {allOses.map((os) => {
                                const model = m.defaultModel?.[os];
                                const available = m.availableOn.includes(os);
                                return (
                                  <li key={os} className="font-mono text-xs">
                                    <span className="inline-block w-14 text-gray-500">{OS_LABEL[os]}:</span>{' '}
                                    {available && model ? (
                                      <span className="text-gray-800">{model}</span>
                                    ) : available ? (
                                      <span className="text-gray-400">—</span>
                                    ) : (
                                      <span className="text-gray-400">— not available —</span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            {source && (
                              <Link
                                href={source.href}
                                title={`Configured at ${source.label} (Config key: ${source.configKey})`}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-50 text-blue-800 border border-blue-200 hover:bg-blue-100 mt-1"
                              >
                                {source.label} <span aria-hidden>↗</span>
                              </Link>
                            )}
                          </div>
                        )}

                        {/* Add/override a model directly from this table —
                            writes to the same Config key `source` links to
                            (POST /api/admin/mode-catalog), so it's the same
                            role-assignment/config path the dedicated
                            settings page uses, not a new mechanism. */}
                        {!backendOffline && source && (
                          <div className="flex items-center gap-1.5 mt-2">
                            <input
                              type="text"
                              value={modelDrafts[m.name] ?? ''}
                              onChange={(e) =>
                                setModelDrafts((prev) => ({ ...prev, [m.name]: e.target.value }))
                              }
                              placeholder="add a model…"
                              className="w-40 px-1.5 py-1 border border-gray-300 rounded text-[11px] font-mono"
                            />
                            <button
                              onClick={() => saveModel(m.name)}
                              disabled={savingMode === m.name || !(modelDrafts[m.name] ?? '').trim()}
                              className="px-2 py-1 bg-blue-600 text-white rounded text-[11px] font-medium hover:bg-blue-700 disabled:opacity-40"
                            >
                              {savingMode === m.name ? 'Saving…' : 'Save'}
                            </button>
                          </div>
                        )}
                        {saveError[m.name] && (
                          <p className="text-[11px] text-red-600 mt-1">{saveError[m.name]}</p>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap gap-1">
                          {allOses.map((os) => (
                            <span
                              key={os}
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${
                                m.availableOn.includes(os)
                                  ? 'bg-green-50 text-green-800 border-green-200'
                                  : 'bg-gray-50 text-gray-400 border-gray-200 line-through'
                              }`}
                            >
                              {OS_LABEL[os]}
                            </span>
                          ))}
                        </div>
                        {onlyLinux && (
                          <p className="text-[11px] text-gray-500 mt-1">
                            Linux + NVIDIA only — vllm-metal lacks cross-encoder support.
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-gray-500 mt-4">
          Source: <code>/api/admin/mode-catalog</code> (live Config values).
          Click a settings-page chip to change a default; per-host overrides
          live on the <strong>Role Assignments</strong> page.
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────── ConfirmDialog (kept) ─────────────────────────── */

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        </div>
        <div className="px-6 py-4">
          <p className="text-sm text-gray-700 whitespace-pre-line">{message}</p>
        </div>
        <div className="px-6 py-3 border-t border-gray-200 flex justify-end gap-2 bg-gray-50">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded-md">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 text-white text-sm rounded-md ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
