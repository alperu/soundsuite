'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Signed-in admin identity UI. Two placements:
 * - variant="header": "Signed in as <username>" text in the admin header row
 * - variant="aside": full-width Log off button below the docs panel
 */
export default function AdminUserMenu({ variant = 'header' }: { variant?: 'header' | 'aside' }) {
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

  if (variant === 'aside') {
    return (
      <div className="border-t border-gray-200 pt-3">
        <button
          onClick={logout}
          disabled={loggingOut}
          className="w-full px-3 py-2 text-xs font-medium text-gray-600 hover:text-gray-900 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          {loggingOut ? 'Signing out…' : 'Log off'}
        </button>
      </div>
    );
  }

  return (
    <div className="ml-auto flex items-center">
      <span className="text-sm text-gray-500">
        Signed in as <span className="font-medium text-gray-700">{username}</span>
      </span>
    </div>
  );
}
