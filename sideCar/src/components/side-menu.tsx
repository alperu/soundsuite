'use client';
/**
 * Left menu on every page: jump between the dashboard sections, Setup and NetBird.
 * Dashboard sections are anchors (/#id), so they work from any page.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

const DASHBOARD = [
  { id: 'overview', label: 'Overview' },
  { id: 'masters', label: 'Master connections' },
  { id: 'vram', label: 'VRAM' },
  { id: 'containers', label: 'Containers' },
  { id: 'virtual', label: 'Virtual containers' },
  { id: 'stats', label: 'Stats' },
  { id: 'timeouts', label: 'Idle timeouts' },
  { id: 'activity', label: 'Activity log' },
];
const PAGES = [
  { href: '/setup', label: 'Setup' },
  { href: '/netbird', label: 'NetBird & HTTPS' },
  { href: '/account', label: 'Account' },
];

async function signOut() {
  await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) });
  window.location.href = '/login';
}

const item = 'block rounded-md px-3 py-1.5 text-sm';

export default function SideMenu({ user }: { user: string }) {
  const path = usePathname();
  // When the session ends, any page's call to a protected /api route gets 401: go to /login.
  useEffect(() => {
    const orig = window.fetch;
    window.fetch = async (input, init) => {
      const res = await orig(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (res.status === 401 && /^(\/|https?:\/\/[^/]+\/)api\//.test(url) && !url.includes('/api/auth')) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
      return res;
    };
    return () => { window.fetch = orig; };
  }, []);
  return (
    <nav className="hidden md:block w-56 shrink-0 border-r border-slate-200 bg-white">
      <div className="sticky top-0 max-h-screen overflow-y-auto p-4">
        <Link href="/" className="mb-4 block px-3 text-sm font-bold text-slate-900">GPU Sidecar</Link>
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Dashboard</div>
        <ul className="mb-4 space-y-0.5">
          {DASHBOARD.map((s) => (
            <li key={s.id}>
              <a href={`/#${s.id}`} className={`${item} text-slate-600 hover:bg-slate-100 hover:text-slate-900`}>{s.label}</a>
            </li>
          ))}
        </ul>
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Settings</div>
        <ul className="space-y-0.5">
          {PAGES.map((p) => (
            <li key={p.href}>
              <Link href={p.href} className={`${item} ${path === p.href ? 'bg-blue-50 font-medium text-blue-800' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>{p.label}</Link>
            </li>
          ))}
        </ul>
        <div className="mt-6 border-t border-slate-200 px-3 pt-3 text-xs text-slate-500">
          Signed in as <span className="font-medium text-slate-700">{user}</span>
          <button type="button" onClick={signOut} className="mt-2 block text-sm text-blue-700 hover:underline">Sign out</button>
        </div>
      </div>
    </nav>
  );
}
