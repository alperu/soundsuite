'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Profile switcher — the dropdown above "Cases" in the sidebar, with an edit
 * button beside it.
 *
 * One active profile per server (docs/tasks/54-profiles.md). Switching posts
 * to `/api/profiles/active` and reloads the page: every list on screen came
 * from the old profile's database, and a reload is the honest way to drop it.
 *
 * The edit panel is the CRUD surface: display name and description for any
 * profile; rename (directory name) and delete only for a profile that is not
 * active — switch away first. Delete moves the folder to `data/.trash/`.
 */

interface ProfileRow {
  name: string;
  displayName: string;
  description?: string;
  active: boolean;
  cases: Array<{ id: string }>;
}

interface Listing {
  active: string;
  legacy: boolean;
  profiles: ProfileRow[];
}

type Mode = 'idle' | 'create' | 'edit';

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${res.status}`;
}

export function ProfileSwitcher({ collapsed }: { collapsed: boolean }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);

  // create
  const [newName, setNewName] = useState('');
  const [copySettings, setCopySettings] = useState(true);

  // edit
  const [editTarget, setEditTarget] = useState<string>('');
  const [editDisplay, setEditDisplay] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editName, setEditName] = useState('');
  const [deleteArmed, setDeleteArmed] = useState('');

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
      if (!res.ok) throw new Error(await readError(res));
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
      if (!res.ok) throw new Error(await readError(res));
      setMode('idle');
      setNewName('');
      await load();
      await switchTo(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [newName, copySettings, listing, load, switchTo]);

  const openEdit = useCallback((name: string) => {
    const row = listing?.profiles.find((p) => p.name === name);
    if (!row) return;
    setEditTarget(name);
    setEditDisplay(row.displayName);
    setEditDescription(row.description ?? '');
    setEditName(name);
    setDeleteArmed('');
    setError(null);
    setMode('edit');
  }, [listing]);

  const save = useCallback(async () => {
    if (!editTarget) return;
    setBusy('Saving…');
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(editTarget)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: editDisplay,
          description: editDescription.trim() ? editDescription : null,
          ...(editName.trim().toLowerCase() !== editTarget ? { newName: editName.trim().toLowerCase() } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setMode('idle');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [editTarget, editDisplay, editDescription, editName, load]);

  const remove = useCallback(async () => {
    if (!editTarget || deleteArmed !== editTarget) return;
    setBusy(`Deleting ${editTarget}…`);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(editTarget)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res));
      setMode('idle');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [editTarget, deleteArmed, load]);

  if (!listing) return null;

  const active = listing.profiles.find((p) => p.active);
  const initial = (active?.displayName ?? listing.active).slice(0, 1).toUpperCase();
  const editing = listing.profiles.find((p) => p.name === editTarget);
  const editingActive = !!editing?.active;

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

  const input = 'w-full rounded border border-gray-300 px-1.5 py-1 text-xs';

  return (
    <div className="mx-1 mb-1 px-2 py-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-gray-400">Profile</div>

      {busy ? (
        <div className="mt-1 text-xs text-gray-600">{busy}</div>
      ) : mode === 'create' ? (
        <div className="mt-1 space-y-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') setMode('idle');
            }}
            placeholder="new-profile-name"
            className={`${input} font-mono`}
          />
          {!listing.legacy && (
            <label className="flex items-center gap-1 text-[10px] text-gray-600">
              <input type="checkbox" checked={copySettings} onChange={(e) => setCopySettings(e.target.checked)} />
              copy settings from {listing.active}
            </label>
          )}
          <div className="flex gap-2 text-[11px]">
            <button onClick={() => void create()} className="text-blue-700 hover:underline">create</button>
            <button onClick={() => setMode('idle')} className="text-gray-500 hover:underline">cancel</button>
          </div>
        </div>
      ) : mode === 'edit' && editing ? (
        <div className="mt-1 space-y-1.5">
          <label className="block text-[10px] text-gray-500">
            Display name
            <input value={editDisplay} onChange={(e) => setEditDisplay(e.target.value)} className={input} autoFocus />
          </label>
          <label className="block text-[10px] text-gray-500">
            Description
            <input value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className={input} placeholder="optional" />
          </label>
          <label className="block text-[10px] text-gray-500">
            Folder name {editingActive && <span className="text-gray-400">(active — switch away to rename)</span>}
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={editingActive}
              className={`${input} font-mono disabled:bg-gray-50 disabled:text-gray-400`}
            />
          </label>
          <div className="flex gap-2 text-[11px]">
            <button onClick={() => void save()} className="text-blue-700 hover:underline">save</button>
            <button onClick={() => setMode('idle')} className="text-gray-500 hover:underline">cancel</button>
          </div>
          {!editingActive && listing.profiles.length > 1 && (
            <div className="border-t border-gray-100 pt-1.5">
              {deleteArmed === editTarget ? (
                <div className="space-y-1">
                  <div className="text-[10px] text-red-700">
                    Moves <span className="font-mono">data/{editTarget}</span> to <span className="font-mono">data/.trash/</span>. Sure?
                  </div>
                  <div className="flex gap-2 text-[11px]">
                    <button onClick={() => void remove()} className="text-red-700 hover:underline">yes, delete</button>
                    <button onClick={() => setDeleteArmed('')} className="text-gray-500 hover:underline">keep</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setDeleteArmed(editTarget)} className="text-[11px] text-red-600 hover:underline">
                  delete profile…
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1">
          <select
            value={listing.active}
            onChange={(e) => {
              if (e.target.value === '__new__') setMode('create');
              else void switchTo(e.target.value);
            }}
            disabled={listing.legacy}
            title={listing.legacy ? 'Run scripts/profiles-migrate.mjs to enable profiles' : 'Switch profile (reloads the page)'}
            className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm font-medium text-gray-800"
          >
            {listing.profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.displayName} · {p.cases.length} case{p.cases.length === 1 ? '' : 's'}
              </option>
            ))}
            {!listing.legacy && <option value="__new__">＋ New profile…</option>}
          </select>
          <button
            onClick={() => openEdit(listing.active)}
            disabled={listing.legacy}
            title="Edit profiles"
            aria-label="Edit profiles"
            className="shrink-0 rounded-md border border-gray-300 bg-white p-1.5 text-gray-500 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-40"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
            </svg>
          </button>
        </div>
      )}

      {mode === 'edit' && listing.profiles.length > 1 && (
        <div className="mt-1.5 text-[10px] text-gray-500">
          Editing:{' '}
          <select
            value={editTarget}
            onChange={(e) => openEdit(e.target.value)}
            className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px]"
          >
            {listing.profiles.map((p) => (
              <option key={p.name} value={p.name}>{p.displayName}{p.active ? ' (active)' : ''}</option>
            ))}
          </select>
        </div>
      )}

      {error && <div className="mt-1 text-[10px] text-red-600">{error}</div>}
    </div>
  );
}
