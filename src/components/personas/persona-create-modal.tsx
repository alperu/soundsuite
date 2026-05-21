'use client';

import { useEffect, useState } from 'react';
import {
  INTRINSIC_MARKERS,
  createPersona,
  type IntrinsicMarker,
  type Persona,
  PersonasApiError,
} from '@/lib/personas/client';
import { MarkerChip } from './persona-chips';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: (p: Persona) => void;
}

interface JurisdictionRow {
  id?: string;
  code?: string;
  name?: string;
  displayName?: string;
}

export function PersonaCreateModal({ open, onClose, onCreated }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [barNumber, setBarNumber] = useState('');
  const [jurisdiction, setJurisdiction] = useState('');
  const [markers, setMarkers] = useState<IntrinsicMarker[]>([]);
  const [jurisdictions, setJurisdictions] = useState<JurisdictionRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setDisplayName('');
    setEmail('');
    setBarNumber('');
    setJurisdiction('');
    setMarkers([]);
    setError(null);
  }, [open]);

  // Load jurisdictions from haystack/read (best effort)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/haystack/read?filter=jurisdiction')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data) return;
        const rows = (data.rows || []) as JurisdictionRow[];
        setJurisdictions(rows);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  const toggleMarker = (m: IntrinsicMarker) => {
    setMarkers((cur) => cur.includes(m) ? cur.filter(x => x !== m) : [...cur, m]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const p = await createPersona({
        displayName: displayName.trim(),
        email: email.trim() || null,
        barNumber: barNumber.trim() || null,
        jurisdiction: jurisdiction.trim() || null,
        markers,
      });
      onCreated?.(p);
      onClose();
    } catch (err) {
      if (err instanceof PersonasApiError) {
        setError(err.status === 404 ? 'Personas backend not yet available' : err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create persona');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6"
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-4">New Persona</h3>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Display Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Jane Doe"
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Bar Number</label>
              <input
                type="text"
                value={barNumber}
                onChange={(e) => setBarNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Jurisdiction</label>
            {jurisdictions.length > 0 ? (
              <select
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— none —</option>
                {jurisdictions.map((j, i) => {
                  const code = j.code || j.id || '';
                  const name = j.displayName || j.name || code;
                  return <option key={`${code}-${i}`} value={code}>{name}</option>;
                })}
              </select>
            ) : (
              <input
                type="text"
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value)}
                placeholder="e.g. TX-DALLAS"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Intrinsic Markers</label>
            <div className="flex flex-wrap gap-1.5">
              {INTRINSIC_MARKERS.map((m) => (
                <MarkerChip
                  key={m}
                  marker={m}
                  active={markers.includes(m)}
                  onToggle={() => toggleMarker(m)}
                />
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded">
            {error}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Creating…' : 'Create Persona'}
          </button>
        </div>
      </form>
    </div>
  );
}
