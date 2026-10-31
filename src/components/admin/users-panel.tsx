'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { ReceiverAccountTable, type SyncAccount } from '@/components/admin/receiver-accounts';

interface AdminUserRow {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
  enabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  dashboardLogin: boolean;
  syncEnabled: boolean;
  syncRoots: string[];
  syncLastLoginAt: string | null;
}


interface SyncInfo {
  configured: boolean;
  settings: { receiverUrl: string; receiverToken: string };
  accounts: SyncAccount[];
  /** Every root name the receiver knows. */
  roots?: string[];
  linked: string[];
  error: string | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function UsersPanel() {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'viewer'>('viewer');
  const [creating, setCreating] = useState(false);

  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [syncEdit, setSyncEdit] = useState<string | null>(null);
  const [syncPassword, setSyncPassword] = useState('');
  const [syncRoots, setSyncRoots] = useState<string[]>([]);
  const [syncRootsText, setSyncRootsText] = useState('');

  const load = useCallback(async () => {
    try {
      // Receiver accounts first: this links them to users (by username).
      const sres = await fetch('/api/admin/users/sync').catch(() => null);
      if (sres?.ok) setSync(await sres.json());
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setUsers(data.users);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setNewUsername('');
      setNewPassword('');
      setNewRole('viewer');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const patchUser = async (id: string, patch: Record<string, unknown>) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const putSync = async (user: AdminUserRow, body: Record<string, unknown>) => {
    setBusy(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/sync`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSyncEdit(null);
      setSyncPassword('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const openSyncEdit = (user: AdminUserRow) => {
    setSyncEdit(syncEdit === user.id ? null : user.id);
    setSyncPassword('');
    setSyncRoots(user.syncRoots);
    setSyncRootsText(user.syncRoots.join(', '));
  };

  // Root choices: every root the receiver knows, plus this user's account roots.
  const rootChoices = (user: AdminUserRow): string[] => {
    const acct = accountFor(user);
    const all = new Set([...(sync?.roots ?? []), ...(acct?.roots ?? []), ...user.syncRoots]);
    return [...all].sort((a, b) => a.localeCompare(b));
  };

  const toggleRoot = (root: string) =>
    setSyncRoots(r => (r.includes(root) ? r.filter(x => x !== root) : [...r, root]));

  const saveSync = (user: AdminUserRow) => {
    const roots = rootChoices(user).length
      ? syncRoots
      : syncRootsText.split(',').map(r => r.trim()).filter(Boolean);
    const body: Record<string, unknown> = { enabled: true, roots };
    if (syncPassword) body.password = syncPassword;
    putSync(user, body);
  };

  const accountFor = (user: AdminUserRow) =>
    sync?.accounts.find(a => a.userId === user.id || a.username.toLowerCase() === user.username);

  const resetPassword = async (user: AdminUserRow) => {
    const password = window.prompt(`New password for "${user.username}" (min 8 characters):`);
    if (!password) return;
    await patchUser(user.id, { password });
  };

  const removeUser = async (user: AdminUserRow) => {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    setBusy(user.id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Users</h2>
        <p className="text-sm text-gray-500 mt-0.5">Manage admin dashboard accounts.</p>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <form onSubmit={createUser} className="flex flex-wrap items-end gap-3 p-4 bg-gray-50 border border-gray-200 rounded-lg">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
          <input
            value={newUsername}
            onChange={e => setNewUsername(e.target.value)}
            className="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm w-40"
            placeholder="username"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
          <input
            type="password"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            className="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm w-40"
            placeholder="min 8 characters"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
          <select
            value={newRole}
            onChange={e => setNewRole(e.target.value as 'admin' | 'viewer')}
            className="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm bg-white"
          >
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={creating}
          className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md"
        >
          {creating ? 'Creating…' : 'Create User'}
        </button>
      </form>

      {loading ? (
        <div className="text-sm text-gray-500">Loading users…</div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                <th className="px-4 py-2.5">Username</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Last Login</th>
                <th className="px-4 py-2.5">Sidecar Sync Login</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                    No users yet — create the first one above.
                  </td>
                </tr>
              )}
              {users.map(user => {
                const acct = accountFor(user);
                return (
                <Fragment key={user.id}>
                <tr className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-medium text-gray-900">{user.username}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        user.role === 'admin' ? 'bg-purple-50 text-purple-700' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        user.enabled ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {user.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-gray-500">
                    {user.dashboardLogin ? formatDate(user.lastLoginAt) : <span title="Sync-only user: no dashboard sign-in">Dashboard login off</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {user.syncEnabled ? (
                      <div className="space-y-0.5">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700">
                          <span className={`w-2 h-2 rounded-full ${acct?.connected ? 'bg-green-500' : 'bg-gray-300'}`} />
                          On{acct ? (acct.connected ? ' · connected' : ' · not connected') : ' · not in receiver'}
                        </span>
                        <div className="text-xs text-gray-500">
                          Roots: {user.syncRoots.length ? user.syncRoots.join(', ') : 'all'} · last login{' '}
                          {formatDate(acct?.lastLoginMs ? new Date(acct.lastLoginMs).toISOString() : user.syncLastLoginAt)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">Off</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                    <button
                      onClick={() => patchUser(user.id, { dashboardLogin: !user.dashboardLogin })}
                      disabled={busy === user.id}
                      className="text-xs font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
                      title="Allow or block sign-in to this dashboard"
                    >
                      {user.dashboardLogin ? 'Dashboard Off' : 'Dashboard On'}
                    </button>
                    <button
                      onClick={() => openSyncEdit(user)}
                      disabled={busy === user.id || !sync?.configured}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                      title={sync?.configured ? 'Sidecar sync login' : 'Receiver not set up'}
                    >
                      Sync Login
                    </button>
                    <button
                      onClick={() => patchUser(user.id, { enabled: !user.enabled })}
                      disabled={busy === user.id}
                      className="text-xs font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
                    >
                      {user.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => resetPassword(user)}
                      disabled={busy === user.id}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                    >
                      Reset Password
                    </button>
                    <button
                      onClick={() => removeUser(user)}
                      disabled={busy === user.id}
                      className="text-xs font-medium text-red-600 hover:text-red-800 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                {syncEdit === user.id && (
                  <tr className="bg-blue-50/40 border-b border-gray-100">
                    <td colSpan={6} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            Sync password {user.syncEnabled ? '(leave empty to keep)' : ''}
                          </label>
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={syncPassword}
                            onChange={e => setSyncPassword(e.target.value)}
                            className="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm w-48"
                            placeholder="min 8 characters"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            Allowed roots (none ticked = all roots)
                          </label>
                          {rootChoices(user).length ? (
                            <div className="flex flex-wrap gap-x-3 gap-y-1 pb-1.5">
                              {rootChoices(user).map(root => (
                                <label key={root} className="inline-flex items-center gap-1 text-xs text-gray-700">
                                  <input
                                    type="checkbox"
                                    checked={syncRoots.includes(root)}
                                    onChange={() => toggleRoot(root)}
                                  />
                                  {root}
                                </label>
                              ))}
                            </div>
                          ) : (
                            <input
                              value={syncRootsText}
                              onChange={e => setSyncRootsText(e.target.value)}
                              className="border border-gray-300 rounded-md px-2.5 py-1.5 text-sm w-56"
                              placeholder="Root1, Root2 (empty = all)"
                            />
                          )}
                        </div>
                        <button
                          onClick={() => saveSync(user)}
                          disabled={busy === user.id || (!user.syncEnabled && !syncPassword)}
                          className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md"
                        >
                          {user.syncEnabled ? 'Save' : 'Turn On'}
                        </button>
                        {user.syncEnabled && (
                          <button
                            onClick={() => {
                              if (window.confirm(`Turn off the sync login for "${user.username}"? Its sidecar will be logged out.`)) {
                                putSync(user, { enabled: false });
                              }
                            }}
                            disabled={busy === user.id}
                            className="px-3 py-1.5 text-sm font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-50 rounded-md"
                          >
                            Turn Off
                          </button>
                        )}
                        <button onClick={() => setSyncEdit(null)} className="text-xs text-gray-500 hover:text-gray-800">
                          Cancel
                        </button>
                      </div>
                      <p className="text-xs text-gray-500 mt-2">
                        The sync password is write only. The sidecar receiver keeps it; SoundSuite does not store it.
                      </p>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="p-4 border border-gray-200 rounded-lg space-y-2">
        <h3 className="text-sm font-semibold text-gray-900">Sidecar sync login</h3>
        {!sync || !sync.configured ? (
          <p className="text-sm text-gray-500">
            Receiver not set up. Set SIDECAR_RECEIVER_URL and SIDECAR_RECEIVER_TOKEN (URL {sync?.settings.receiverUrl ?? 'not set'}, token{' '}
            {sync?.settings.receiverToken ?? 'not set'}).
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500">
              Receiver accounts. Each sync login belongs to a user above (linked by username). Use Sync Login on a user to change it.
            </p>
            {sync.error && <p className="text-sm text-red-700">Receiver: {sync.error}</p>}
            {sync.linked.length > 0 && <p className="text-xs text-blue-700">Linked to users: {sync.linked.join(', ')}</p>}
            <ReceiverAccountTable accounts={sync.accounts} />
          </>
        )}
      </div>
    </div>
  );
}
