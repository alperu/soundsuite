'use client';
/** Sign in, or make the first admin account when none exists. */
import { useEffect, useState } from 'react';

export default function LoginPage() {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth', { cache: 'no-store' }).then((r) => r.json()).then((j) => setSetup(!!j.setup)).catch(() => setSetup(false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (setup && password !== confirm) { setErr('The two passwords are not the same.'); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: setup ? 'setup' : 'login', user, password }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || `Error ${r.status}`); return; }
      const next = new URLSearchParams(window.location.search).get('next') || '/';
      window.location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-bold text-slate-900">GPU Sidecar</h1>
          <p className="text-sm text-slate-500">
            {setup === null ? 'Loading…' : setup ? 'Make the admin account for this sidecar.' : 'Sign in to continue.'}
          </p>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-slate-600">User name</span>
          <input className={input} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" required />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-slate-600">Password{setup ? ' (10 characters or more)' : ''}</span>
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={setup ? 'new-password' : 'current-password'} required autoFocus />
        </label>
        {setup && (
          <label className="block space-y-1 text-sm">
            <span className="text-slate-600">Password again</span>
            <input className={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button type="submit" disabled={busy || setup === null}
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {setup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
