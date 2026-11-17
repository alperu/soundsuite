'use client';
/** Change the admin password. Other sessions end; this one stays signed in. */
import { useState } from 'react';

export default function AccountPage() {
  const [password, setPassword] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) { setMsg({ ok: false, text: 'The two new passwords are not the same.' }); return; }
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'password', password, newPassword: next }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { setPassword(''); setNext(''); setConfirm(''); }
    setMsg(r.ok ? { ok: true, text: 'Password changed. Other sessions are signed out.' } : { ok: false, text: j.error || `Error ${r.status}` });
  };

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';
  return (
    <main className="mx-auto w-[90%] px-4 py-8">
      <h1 className="mb-4 text-xl font-bold text-slate-900">Account</h1>
      <form onSubmit={submit} className="max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="font-semibold text-slate-800">Change password</h2>
        <input className={input} type="password" placeholder="Current password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <input className={input} type="password" placeholder="New password (10 characters or more)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        <input className={input} type="password" placeholder="New password again" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        {msg && <p className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>}
        <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">Change password</button>
      </form>
    </main>
  );
}
