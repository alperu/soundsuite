'use client';

/**
 * AdminRoleTypes — read-only Mode Types reference.
 *
 * The 4-mode catalog (ss-embedding, ss-completion, ss-ocr, ss-reranker) is
 * server-defined and resolved per-OS by the sidecar. Operators no longer pick
 * image/port/VRAM/priority — they only choose which modes run on which
 * sidecar (see the Role Assignments tab).
 *
 * Source: GET /api/admin/mode-catalog
 *
 * The `RoleType` type and `ConfirmDialog` component are re-exported because
 * other files still import them; they remain for backwards compatibility.
 */

import { useCallback, useEffect, useState } from 'react';

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

/* ─────────────────────────── Hard-coded fallback ───────────────────────────
 * Used when /api/admin/mode-catalog 404s. Mirrors the spec.
 */
const FALLBACK_CATALOG: ModeCatalogEntry[] = [
  {
    name: 'ss-embedding',
    label: 'Embedding',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {
      linux: 'qwen3-embedding:0.6b',
      darwin: 'qwen3-embedding:0.6b',
      win32: 'qwen3-embedding:0.6b',
    },
    description: 'Document and query embeddings for vector search.',
  },
  {
    name: 'ss-completion',
    label: 'Completion',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {
      linux: 'qwen3.5:9b',
      darwin: 'qwen3.5:9b',
      win32: 'qwen3.5:9b',
    },
    description: 'Chat/completion model for agent calls.',
  },
  {
    name: 'ss-ocr',
    label: 'OCR',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {
      linux: 'richardyoung/olmocr2:7b',
      darwin: 'richardyoung/olmocr2:7b',
      win32: 'richardyoung/olmocr2:7b',
    },
    description: 'Vision-LLM OCR for scanned PDFs and exhibit images.',
  },
  {
    name: 'ss-reranker',
    label: 'Reranker',
    availableOn: ['linux'],
    defaultModel: {
      linux: 'Qwen/Qwen3-Reranker-8B',
    },
    description:
      'Cross-encoder reranking. Linux+NVIDIA only — vllm-metal does not support cross-encoders.',
  },
];

const OS_LABEL: Record<ModeOs, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};

/* ─────────────────────────── Component ─────────────────────────── */

export default function AdminRoleTypes() {
  const [catalog, setCatalog] = useState<ModeCatalogEntry[]>(FALLBACK_CATALOG);
  const [loading, setLoading] = useState(true);
  const [backendMissing, setBackendMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/mode-catalog');
      if (res.status === 404) {
        setBackendMissing(true);
        setCatalog(FALLBACK_CATALOG);
        setError(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const modes: ModeCatalogEntry[] = Array.isArray(data?.modes) ? data.modes : [];
      setCatalog(modes.length > 0 ? modes : FALLBACK_CATALOG);
      setBackendMissing(modes.length === 0);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
      setCatalog(FALLBACK_CATALOG);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-900">
        <strong>Mode Types</strong> are a fixed catalog. Sidecars auto-resolve
        the underlying image / port / VRAM based on their host OS. To assign
        modes to hosts, use the <em>Role Assignments</em> tab.
      </div>

      {backendMissing && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 text-sm text-yellow-900">
          Backend endpoint <code>/api/admin/mode-catalog</code> is not deployed
          yet — showing built-in defaults.
        </div>
      )}

      {error && !backendMissing && (
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
                  <th className="text-left py-2 px-3 font-medium text-gray-600">Default model (per OS)</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-600 w-44">Available on</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((m) => {
                  const allOses: ModeOs[] = ['linux', 'darwin', 'win32'];
                  const onlyLinux = m.availableOn.length === 1 && m.availableOn[0] === 'linux';
                  return (
                    <tr key={m.name} className="border-b border-gray-100 align-top">
                      <td className="py-3 px-3">
                        <div className="font-mono text-sm font-medium text-gray-900">{m.name}</div>
                        {m.description && (
                          <div className="text-[11px] text-gray-500 mt-1">{m.description}</div>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <ul className="space-y-0.5">
                          {allOses.map((os) => {
                            const model = m.defaultModel?.[os];
                            const available = m.availableOn.includes(os);
                            return (
                              <li key={os} className="font-mono text-xs">
                                <span className="inline-block w-14 text-gray-500">{OS_LABEL[os]}:</span>{' '}
                                {available && model ? (
                                  <span className="text-gray-800">{model}</span>
                                ) : (
                                  <span className="text-gray-400">— not available —</span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
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
          Source: <code>/api/admin/mode-catalog</code>. Want a different model?{' '}
          Override per-host on the <strong>Role Assignments</strong> page.
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
