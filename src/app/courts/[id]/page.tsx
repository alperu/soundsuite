'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  COURT_TYPES,
  deleteCourt,
  getCourt,
  listJurisdictionOptions,
  updateCourt,
  type Court,
  type CourtType,
  type JurisdictionOption,
} from '@/lib/courts/client';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CourtDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();

  const [court, setCourt] = useState<Court | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [jurisdictions, setJurisdictions] = useState<JurisdictionOption[]>([]);

  // Local form state
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [jurisdictionId, setJurisdictionId] = useState('');
  const [courtType, setCourtType] = useState<CourtType | ''>('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await getCourt(id);
      setCourt(c);
      setName(c.name);
      setShortName(c.shortName || '');
      setJurisdictionId(c.jurisdictionId || '');
      setCourtType((c.courtType as CourtType) || '');
      setAddress(c.address || '');
      setPhone(c.phone || '');
      setWebsite(c.website || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load court');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
    listJurisdictionOptions().then(setJurisdictions).catch(() => setJurisdictions([]));
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const c = await updateCourt(id, {
        name: name.trim(),
        shortName: shortName.trim() || null,
        jurisdictionId: jurisdictionId || null,
        courtType: (courtType as CourtType) || null,
        address: address.trim() || null,
        phone: phone.trim() || null,
        website: website.trim() || null,
      });
      setCourt(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete court "${court?.name}"? This cannot be undone.`)) return;
    try {
      await deleteCourt(id);
      router.push('/courts');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete');
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
        Loading…
      </div>
    );
  }
  if (!court) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm">
        <p className="text-gray-600">{error || 'Court not found.'}</p>
        <Link href="/courts" className="text-blue-600 hover:underline">
          Back to courts
        </Link>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-gray-50">
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-4">
          <Link href="/courts" className="hover:underline">
            Courts
          </Link>
          <span>/</span>
          <span className="text-gray-800 truncate">{court.name}</span>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <div className="flex items-start justify-between mb-4">
            <h1 className="text-xl font-semibold text-gray-900">{court.name}</h1>
            <span className="text-xs text-gray-400">
              {court.casesCount ?? 0}{' '}
              {(court.casesCount ?? 0) === 1 ? 'case' : 'cases'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" required>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </Field>
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
            </Field>
            <div className="col-span-2">
              <Field label="Address">
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </Field>
            </div>
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
            <div className="mt-4 px-3 py-2 bg-red-50 text-red-700 text-xs rounded border border-red-100">
              {error}
            </div>
          )}

          <div className="mt-6 flex items-center justify-between">
            <button
              type="button"
              onClick={remove}
              className="text-xs text-red-600 hover:text-red-800"
            >
              Delete court
            </button>
            <div className="flex items-center gap-2">
              <Link
                href="/courts"
                className="px-3 py-1.5 text-sm text-gray-700 rounded hover:bg-gray-100"
              >
                Back
              </Link>
              <button
                type="button"
                onClick={save}
                disabled={saving || !name.trim()}
                className="px-3 py-1.5 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>

        {court.cases && court.cases.length > 0 && (
          <div className="mt-6 bg-white border border-gray-200 rounded-lg p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Cases assigned to this court
            </h2>
            <ul className="divide-y divide-gray-100 text-sm">
              {court.cases.map((cs) => (
                <li key={cs.id} className="py-2 flex items-center gap-2">
                  <span className="text-gray-900">{cs.name}</span>
                  {cs.caseNumber && (
                    <span className="text-gray-500 font-mono text-xs">{cs.caseNumber}</span>
                  )}
                  {cs.jurisdiction && (
                    <span className="text-gray-400 text-xs">{cs.jurisdiction}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
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
