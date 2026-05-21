'use client';

import { useEffect, useState } from 'react';
import {
  listPersonas,
  mergePersonas,
  type Persona,
  PersonasApiError,
} from '@/lib/personas/client';

interface Props {
  open: boolean;
  keep: Persona;
  onClose: () => void;
  onMerged?: (p: Persona) => void;
}

export function PersonaMergeModal({ open, keep, onClose, onMerged }: Props) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Persona[]>([]);
  const [selected, setSelected] = useState<Persona | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setHits([]);
    setSelected(null);
    setConfirming(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      listPersonas({ q, limit: 20 })
        .then((r) => setHits((r.personas || []).filter(p => p.id !== keep.id)))
        .catch(() => setHits([]));
    }, 200);
    return () => window.clearTimeout(id);
  }, [open, q, keep.id]);

  if (!open) return null;

  const handleMerge = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const result = await mergePersonas(keep.id, [selected.id]);
      onMerged?.(result);
      onClose();
    } catch (err) {
      if (err instanceof PersonasApiError) {
        setError(err.status === 404 ? 'Merge endpoint not yet available' : err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Merge failed');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Merge Persona</h3>
        <p className="text-xs text-gray-600 mb-3">
          The selected persona will be merged INTO <span className="font-medium">{keep.displayName}</span>. All
          role bindings from the merged record will move over; the original record is deleted.
        </p>

        {!confirming ? (
          <>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search personas to merge…"
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="mt-2 max-h-48 overflow-y-auto border border-gray-100 rounded">
              {hits.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-gray-400">No matches.</div>
              ) : (
                hits.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelected(p)}
                    className={`w-full text-left px-2 py-1.5 text-xs hover:bg-blue-50 flex items-center justify-between ${
                      selected?.id === p.id ? 'bg-blue-100' : ''
                    }`}
                  >
                    <span>{p.displayName}</span>
                    <span className="font-mono text-gray-400">@{p.id}</span>
                  </button>
                ))
              )}
            </div>
            {error && (
              <div className="mt-3 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded">
                {error}
              </div>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Cancel</button>
              <button
                type="button"
                disabled={!selected}
                onClick={() => setConfirming(true)}
                className="px-4 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="px-3 py-2 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded">
              You're about to merge <span className="font-medium">{selected?.displayName}</span> into{' '}
              <span className="font-medium">{keep.displayName}</span>. This cannot be undone.
            </div>
            {error && (
              <div className="mt-3 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded">
                {error}
              </div>
            )}
            <div className="mt-5 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setConfirming(false)} className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded">Back</button>
              <button
                type="button"
                disabled={saving}
                onClick={handleMerge}
                className="px-4 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {saving ? 'Merging…' : 'Confirm merge'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
