'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/** Shows the signed-in admin username and a logout button in the admin header. */
export default function AdminUserMenu() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetch('/api/admin/auth/me')
      .then(res => (res.ok ? res.json() : null))
      .then(data => setUsername(data?.user?.username ?? null))
      .catch(() => setUsername(null));
  }, []);

  const logout = async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/admin/auth/logout', { method: 'POST' });
    } finally {
      router.push('/admin/login');
      router.refresh();
    }
  };

  if (!username) return null;

  return (
    <div className="ml-auto flex items-center gap-3">
      <span className="text-sm text-gray-500">
        Signed in as <span className="font-medium text-gray-700">{username}</span>
      </span>
      <button
        onClick={logout}
        disabled={loggingOut}
        className="text-xs font-medium text-gray-600 hover:text-gray-900 border border-gray-300 rounded-md px-2.5 py-1 disabled:opacity-50"
      >
        {loggingOut ? 'Signing out…' : 'Log out'}
      </button>
    </div>
  );
}
