'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LS_KEY = 'nav-collapsed';

const links = [
  { href: '/', label: 'Cases', icon: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
  { href: '/search', label: 'Search', icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z' },
  { href: '/draft', label: 'Draft', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
  { href: '/vectors', label: 'Vectors', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4' },
  { href: '/workflow', label: 'Workflows', icon: 'M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z' },
  { href: '/case-explorer', label: 'Explorer', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { href: '/mcp-explorer', label: 'MCP', icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z' },
  { href: '/case-management', label: 'Management', icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z' },
  // Directly below Management, and pointing at the route that already exists:
  // /scope renders the block view full-page over the whole corpus, with both
  // tabs and no case or preset context required. Until now it was reachable
  // only from the Settings panel and the case-management embeds.
  // Opens on the Editor tab: the name says MANAGEMENT, and the mapping
  // workbench is what that means here. Filtering is one click away in-page.
  { href: '/scope?tab=editor', label: 'Haystack Management', icon: 'M4 6a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM13 15a2 2 0 012-2h3a2 2 0 012 2v3a2 2 0 01-2 2h-3a2 2 0 01-2-2v-3zM11 7.5h4a2 2 0 012 2V11M9 12.5v2a2 2 0 002 2h2' },
  { href: '/personas', label: 'Personas', icon: 'M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6 5.87a4 4 0 10-8 0M16 3.13a4 4 0 010 7.75M12 7a4 4 0 11-8 0 4 4 0 018 0z' },
  { href: '/courts', label: 'Courts', icon: 'M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6M9 12h.01M15 12h.01' },
  { href: '/admin', label: 'Admin', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z' },
];

const docsLink = { href: '/docs', label: 'Docs', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' };

export default function Navigation() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // The admin login page stands alone — no app chrome while logged off.
  const isLoginPage = pathname?.startsWith('/admin/login');

  // Load persisted state
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(LS_KEY) === 'true');
    } catch {}
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(LS_KEY, String(next)); } catch {}
    // Dispatch custom event so other components (Draft page) can react
    window.dispatchEvent(new CustomEvent('nav-collapse-toggle', { detail: { collapsed: next } }));
  };

  if (isLoginPage) return null;

  return (
    <aside
      className={`bg-white border-r border-gray-200 flex flex-col shrink-0 transition-all duration-200 ${
        collapsed ? 'w-12' : 'w-56'
      }`}
    >
      {/* Logo */}
      <div className="h-14 flex items-center border-b border-gray-200 overflow-hidden">
        {collapsed ? (
          <Link href="/" className="w-full flex items-center justify-center" title="Sound Suite">
            <img src="/brand/soundsuite-mark.svg" alt="Sound Suite" className="h-7 w-7" />
          </Link>
        ) : (
          <Link href="/" className="flex items-center px-3 w-full" title="Sound Suite">
            <img src="/brand/soundsuite-logo.svg" alt="Sound Suite" className="h-7 w-auto" />
          </Link>
        )}
      </div>

      {/* Nav links */}
      <nav className="flex-1 py-3 px-1 space-y-0.5 overflow-y-auto overflow-x-hidden">
        {links.map((link) => {
          // Compare on the PATH only: an entry may carry a query (the block
          // view opens on its Editor tab), and `pathname` never includes one,
          // so matching the raw href would leave that item permanently unlit.
          const path = link.href.split('?')[0];
          const active = path === '/'
            ? pathname === '/'
            : pathname === path || pathname.startsWith(path + '/');

          return (
            <Link
              key={link.href}
              href={link.href}
              title={collapsed ? link.label : undefined}
              className={`
                flex items-center rounded-md text-sm font-medium transition-colors overflow-hidden
                ${collapsed ? 'justify-center px-0 py-2' : 'gap-3 px-3 py-2'}
                ${active
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-700 hover:bg-gray-100'
                }
              `}
            >
              <svg
                className={`w-4 h-4 shrink-0 ${active ? 'text-blue-600' : 'text-gray-400'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={link.icon} />
              </svg>
              {!collapsed && <span className="whitespace-nowrap">{link.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Docs link — pinned just above the collapse toggle */}
      {(() => {
        const active = pathname === docsLink.href || pathname.startsWith(docsLink.href + '/');
        return (
          <Link
            href={docsLink.href}
            title={collapsed ? docsLink.label : undefined}
            className={`
              flex items-center rounded-md text-sm font-medium transition-colors overflow-hidden mx-1 mb-1
              ${collapsed ? 'justify-center px-0 py-2' : 'gap-3 px-3 py-2'}
              ${active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'}
            `}
          >
            <svg
              className={`w-4 h-4 shrink-0 ${active ? 'text-blue-600' : 'text-gray-400'}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={docsLink.icon} />
            </svg>
            {!collapsed && <span className="whitespace-nowrap">{docsLink.label}</span>}
          </Link>
        );
      })()}

      {/* Collapse toggle */}
      <button
        onClick={toggle}
        className="h-10 flex items-center justify-center border-t border-gray-200 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg
          className={`w-4 h-4 transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    </aside>
  );
}
