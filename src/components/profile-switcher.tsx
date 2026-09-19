'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Profile switcher — the dropdown above "Cases" in the sidebar.
 *
 * One active profile per server (docs/tasks/54-profiles.md). Switching posts
 * to `/api/profiles/active` and reloads the page: every list on screen came
 * from the old profile's database, and a reload is the honest way to drop it.
 * A new profile is created inline; its settings can be copied from the
 * active one so API keys carry over.
 */

interface ProfileRow {
  name: string;
  displayName: string;
  active: boolean;
  cases: Array<{ id: string }>;
}

interface Listing {
  active: string;
  legacy: boolean;
  profiles: ProfileRow[];
}

export function ProfileSwitcher({ collapsed }: { collapsed: boolean }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [copySettings, setCopySettings] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/profiles?cases=1');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setListing((await res.json()) as Listing);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchTo = useCallback(async (name: string) => {
    if (!listing || name === listing.active) return;
    setBusy(`Switching to ${name}…`);
    setError(null);
    try {
      const res = await fetch('/api/profiles/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [listing]);

  const create = useCallback(async () => {
    const name = newName.trim().toLowerCase();
    if (!name) return;
    setBusy(`Creating ${name}…`);
    setError(null);
    try {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          copySettingsFrom: copySettings && listing && !listing.legacy ? listing.active : undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      setCreating(false);
      setNewName('');
      await load();
      await switchTo(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [newName, copySettings, listing, load, switchTo]);

  if (!listing) return null;

  const active = listing.profiles.find((p) => p.active);
  const initial = (active?.displayName ?? listing.active).slice(0, 1).toUpperCase();

  if (collapsed) {
    return (
      <div
        className="mx-1 mb-1 flex h-8 items-center justify-center rounded-md bg-gray-100 text-xs font-semibold text-gray-700"
        title={`Profile: ${active?.displayName ?? listing.active}`}
      >
        {initial}
      </div>
    );
  }

  return (
    <div className="mx-1 mb-1 px-2 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">Profile</div>
      {busy ? (
        <div className="mt-1 text-xs text-gray-600">{busy}</div>
      ) : creating ? (
        <div className="mt-1 space-y-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') setCreating(false);
            }}
            placeholder="new-profile-name"
            className="w-full rounded border border-gray-300 px-1.5 py-1 font-mono text-xs"
          />
          {!listing.legacy && (
            <label className="flex items-center gap-1 text-[10px] text-gray-600">
              <input type="checkbox" checked={copySettings} onChange={(e) => setCopySettings(e.target.checked)} />
              copy settings from {listing.active}
            </label>
          )}
          <div className="flex gap-2 text-[11px]">
            <button onClick={() => void create()} className="text-blue-700 hover:underline">create</button>
            <button onClick={() => setCreating(false)} className="text-gray-500 hover:underline">cancel</button>
          </div>
        </div>
      ) : (
        <select
          value={listing.active}
          onChange={(e) => {
            if (e.target.value === '__new__') setCreating(true);
            else void switchTo(e.target.value);
          }}
          disabled={listing.legacy}
          title={listing.legacy ? 'Run scripts/profiles-migrate.mjs to enable profiles' : 'Switch profile (reloads the page)'}
          className="mt-1 w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm font-medium text-gray-800"
        >
          {listing.profiles.map((p) => (
            <option key={p.name} value={p.name}>
              {p.displayName} · {p.cases.length} case{p.cases.length === 1 ? '' : 's'}
            </option>
          ))}
          {!listing.legacy && <option value="__new__">＋ New profile…</option>}
        </select>
      )}
      {error && <div className="mt-1 text-[10px] text-red-600">{error}</div>}
    </div>
  );
}
