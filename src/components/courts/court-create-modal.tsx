'use client';

import { useEffect, useState } from 'react';
import {
  createCourt,
  listJurisdictionOptions,
  COURT_TYPES,
  type Court,
  type CourtType,
  type JurisdictionOption,
} from '@/lib/courts/client';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (c: Court) => void;
}

export function CourtCreateModal({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [jurisdictionId, setJurisdictionId] = useState('');
  const [courtType, setCourtType] = useState<CourtType | ''>('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jurisdictions, setJurisdictions] = useState<JurisdictionOption[]>([]);

  useEffect(() => {
    if (!open) return;
    setName('');
    setShortName('');
    setJurisdictionId('');
    setCourtType('');
    setAddress('');
    setPhone('');
    setWebsite('');
    setError(null);
    listJurisdictionOptions().then(setJurisdictions).catch(() => setJurisdictions([]));
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const c = await createCourt({
        name: name.trim(),
        shortName: shortName.trim() || null,
        jurisdictionId: jurisdictionId || null,
        courtType: (courtType as CourtType) || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        website: website.trim() || null,
      });
      onCreated(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create court');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900 mb-4">New Court</h3>

        <div className="space-y-3">
          <Field label="Name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Short name">
              <input
                type="text"
                value={shortName}
                onChange={(e) => setShortName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </Field>
            <Field label="Type">
              <select
                value={courtType}
                onChange={(e) => setCourtType(e.target.value as CourtType | '')}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">—</option>
                {COURT_TYPES.map((t) => (
                  <option key={t} value={t} className="capitalize">
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Jurisdiction">
            <select
              value={jurisdictionId}
              onChange={(e) => setJurisdictionId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">— none —</option>
              {jurisdictions.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.label}
                </option>
              ))}
            </select>
            {jurisdictions.length === 0 && (
              <p className="text-[11px] text-gray-400 mt-1">
                No jurisdictions found — add them under the Haystack panel or skip.
              </p>
            )}
          </Field>

          <Field label="Address">
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </Field>
            <Field label="Website">
              <input
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </Field>
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-50 text-red-700 text-xs rounded border border-red-100">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm text-gray-700 rounded hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !name.trim()}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-40"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required = false,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
