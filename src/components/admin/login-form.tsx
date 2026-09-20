'use client';

/**
 * Login form for Sound Suite's own self-hosted admin dashboard. Submits to the
 * local /api/admin/auth/login route, which verifies against the AdminUser table
 * and sets an httpOnly session cookie. First-party UI for this application.
 *
 * Developer-mode fragment sign-in (docs/jev-browser.md): a browser agent
 * cannot fill password fields or set cookies, so on load the form reads a URL
 * fragment `#auth=<base64 of user:pass>`, strips it from the address bar at
 * once, and submits it through the very same /api/admin/auth/login call the
 * form makes. It is honoured only when the page host is localhost or
 * 127.0.0.1 AND /api/health reports `devMode: true` (the gitignored
 * `config/dev-mode` marker exists on the server). Fragments never reach the
 * server; password verification is unchanged.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const HEALTH_URL = '/api/health';

/** Pull `#auth=` off the current URL. Returns the raw value or null. */
export function readAuthFragment(win: Pick<Window, 'location' | 'history'> = window): string | null {
  const hash = win.location.hash || '';
  const m = /^#auth=([^&]+)/.exec(hash);
  if (!m) return null;
  // Strip immediately so the credentials do not survive a reload, a copy of
  // the URL, or a referrer header.
  try {
    win.history.replaceState(null, '', win.location.pathname + win.location.search);
  } catch {
    /* ignore */
  }
  return decodeURIComponent(m[1]);
}

/** Decode base64 `user:pass`; null when malformed. */
export function decodeAuthFragment(value: string): { username: string; password: string } | null {
  let text: string;
  try {
    text = atob(value);
  } catch {
    return null;
  }
  const i = text.indexOf(':');
  if (i <= 0 || i === text.length - 1) return null;
  return { username: text.slice(0, i), password: text.slice(i + 1) };
}

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

export default function LoginForm({ showBootstrapHint = false }: { showBootstrapHint?: boolean }) {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const login = async (creds: { username: string; password: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(creds),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.push('/admin/general');
      router.refresh();
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await login({ username, password });
  };

  // Developer-mode fragment sign-in. Order matters: strip the fragment first
  // (always), then decide whether to honour it.
  useEffect(() => {
    const raw = readAuthFragment();
    if (!raw) return;
    if (!isLocalHost(window.location.hostname)) return;
    const creds = decodeAuthFragment(raw);
    if (!creds) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(HEALTH_URL, { cache: 'no-store' });
        const health = await res.json().catch(() => ({}));
        if (cancelled || health?.devMode !== true) return;
        await login(creds);
      } catch {
        /* dev-mode probe failed: fall through to the normal form */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-full max-w-sm">
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-8">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-gray-900">Sound Suite Admin</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to continue</p>
        </div>

        {showBootstrapHint && (
          <div className="mb-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
            A first-run admin account was just created. Sign in with it, then change its
            password immediately in the Users tab.
          </div>
        )}

        {error && (
          <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Username</label>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoComplete="username"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoComplete="current-password"
              required
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full px-3 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-md"
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
