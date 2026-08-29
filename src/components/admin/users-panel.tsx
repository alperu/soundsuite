'use client';

import { useCallback, useEffect, useState } from 'react';

interface AdminUserRow {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
  enabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
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

  const load = useCallback(async () => {
    try {
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
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                    No users yet — create the first one above.
                  </td>
                </tr>
              )}
              {users.map(user => (
                <tr key={user.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
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
                  <td className="px-4 py-2.5 text-gray-500">{formatDate(user.lastLoginAt)}</td>
                  <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
