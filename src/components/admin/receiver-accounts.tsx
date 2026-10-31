'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/** One sidecar-receiver account, as GET /api/admin/users/sync returns it. */
export interface SyncAccount {
  id: string;
  username: string;
  roots: string[];
  lastLoginMs: number | null;
  connected: boolean;
  userId: string | null;
}

function formatMs(ms: number | null): string {
  if (!ms) return 'Never';
  const d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Read-only list of receiver accounts (no passwords, no hashes). */
export function ReceiverAccountTable({ accounts }: { accounts: SyncAccount[] }) {
  if (!accounts.length) return <p className="text-sm text-gray-500">No receiver accounts.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-gray-200 text-left text-xs font-semibold text-gray-600">
          <th className="py-1.5 pr-3">Account</th>
          <th className="py-1.5 pr-3">Roots</th>
          <th className="py-1.5 pr-3">Connected</th>
          <th className="py-1.5 pr-3">Last Login</th>
          <th className="py-1.5 pr-3">User</th>
        </tr>
      </thead>
      <tbody>
        {accounts.map(a => (
          <tr key={a.id} className="border-b border-gray-100 last:border-0">
            <td className="py-1.5 pr-3 font-medium text-gray-900">{a.username}</td>
            <td className="py-1.5 pr-3 text-gray-600">{a.roots.length ? a.roots.join(', ') : 'none'}</td>
            <td className="py-1.5 pr-3">
              <span className={`inline-flex items-center gap-1.5 text-xs ${a.connected ? 'text-green-700' : 'text-gray-400'}`}>
                <span className={`w-2 h-2 rounded-full ${a.connected ? 'bg-green-500' : 'bg-gray-300'}`} />
                {a.connected ? 'yes' : 'no'}
              </span>
            </td>
            <td className="py-1.5 pr-3 text-gray-500">{formatMs(a.lastLoginMs)}</td>
            <td className="py-1.5 pr-3 text-gray-500">{a.userId ? 'linked' : 'not linked'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Receiver sync logins, read only, with a link to the Users page where they
 * are changed. Used wherever SoundSuite shows sidecar status.
 */
export function ReceiverAccountsPanel() {
  const [data, setData] = useState<{ configured: boolean; accounts: SyncAccount[]; error: string | null } | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/admin/users/sync')
      .then(r => (r.ok ? r.json() : null))
      .then(b => live && setData(b))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-700">Receiver Sync Logins</h3>
        <Link href="/admin/users" className="text-xs font-medium text-blue-600 hover:underline">
          Manage in Users
        </Link>
      </div>
      {!data ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !data.configured ? (
        <p className="text-sm text-gray-500">Receiver not set up.</p>
      ) : (
        <>
          {data.error && <p className="text-sm text-red-700 mb-1">Receiver: {data.error}</p>}
          <ReceiverAccountTable accounts={data.accounts} />
        </>
      )}
    </div>
  );
}
