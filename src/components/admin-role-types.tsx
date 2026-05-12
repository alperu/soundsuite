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

export type ModeOs = 'linux' | 'darwin' | 'win32';

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
    label: 'Embedding',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {},
    description: 'Document and query embedding via Ollama. Lightweight; used in both indexing and search.',
  },
  {
    name: 'ss-completion',
    label: 'Completion',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {},
    description: 'Chat completion via Ollama. Used at search time.',
  },
  {
    name: 'ss-ocr',
    label: 'OCR',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {},
    description: 'Visual OCR for low-density PDF pages and exhibit images.',
  },
  {
    name: 'ss-reranker',
    label: 'Reranker (cross-encoder)',
    availableOn: ['linux'],
    defaultModel: {},
    description: "vLLM cross-encoder reranker. Linux-only — vllm-metal lacks cross-encoder support.",
  },
];

const OS_LABEL: Record<ModeOs, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};

/* ─────────────────────────── Component ─────────────────────────── */

export default function AdminRoleTypes() {
  const [catalog, setCatalog] = useState<ModeCatalogEntry[]>(FALLBACK_CATALOG_NO_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [backendOffline, setBackendOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
                  const allOses: ModeOs[] = ['linux', 'darwin', 'win32'];
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
