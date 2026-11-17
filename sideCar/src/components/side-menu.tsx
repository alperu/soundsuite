'use client';
/**
 * Left menu on every page: jump between the dashboard sections, Setup and NetBird.
 * Dashboard sections are anchors (/#id), so they work from any page.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

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
];

const item = 'block rounded-md px-3 py-1.5 text-sm';

export default function SideMenu() {
  const path = usePathname();
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
      </div>
    </nav>
  );
}
