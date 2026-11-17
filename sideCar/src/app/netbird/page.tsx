'use client';

/**
 * /netbird — join this sidecar to NetBird as <hostname>.<domain>, and serve
 * https://<hostname>.<domain> with a Let's Encrypt certificate (Cloudflare DNS).
 * Secrets are write-only: the API returns only their last 4 characters.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { NetbirdView } from '@/lib/netbird-runtime';

const TOKEN_KEY = 'sidecarAdminToken';

function headers(): Record<string, string> {
  const t = typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;
  return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

const card = 'bg-white rounded-lg border border-slate-200 p-5 space-y-4';
const input = 'w-full rounded border border-slate-300 px-3 py-2 text-sm font-mono';
const label = 'block text-sm font-medium text-slate-700 mb-1';
const help = 'text-xs text-slate-500 mt-1';
const btn = 'rounded px-4 py-2 text-sm font-medium disabled:opacity-50';

function Chip({ ok, text }: { ok: boolean | null; text: string }) {
  const c = ok === null ? 'bg-slate-100 text-slate-600' : ok ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800';
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${c}`}>{text}</span>;
}

export default function NetbirdPage() {
  const [v, setV] = useState<NetbirdView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needToken, setNeedToken] = useState(false);
  const [adminToken, setAdminToken] = useState('');

  const [setupKey, setSetupKey] = useState('');
  const [hostname, setHostname] = useState('');
  const [managementUrl, setManagementUrl] = useState('');
  const [wgPort, setWgPort] = useState('0');
  const [ipMap, setIpMap] = useState('');
  const [domain, setDomain] = useState('');
  const [email, setEmail] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fill = (x: NetbirdView) => {
    setHostname(x.hostnameIsDefault ? '' : x.hostname);
    setManagementUrl(x.managementUrl);
    setWgPort(String(x.wireguardPort));
    setIpMap(x.externalIpMap);
    setDomain(x.https.domain);
    setEmail(x.https.email);
  };

  const load = useCallback(async (refill: boolean) => {
    const r = await fetch('/api/netbird', { headers: headers(), cache: 'no-store' });
    if (r.status === 401) { setNeedToken(true); return; }
    setNeedToken(false);
    const x = (await r.json()) as NetbirdView;
    setV(x);
    if (refill) fill(x);
  }, []);

  useEffect(() => {
    load(true).catch((e) => setErr(String(e)));
    const t = setInterval(() => { load(false).catch(() => {}); }, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function send(method: 'PUT' | 'DELETE', url: string, body: unknown, done: string) {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch(url, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { setNeedToken(true); throw new Error(j.error || 'Admin token required.'); }
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setV(j as NetbirdView); fill(j as NetbirdView);
      setSetupKey(''); setCfToken('');
      setMsg(done);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function save(enabled?: boolean, httpsEnabled?: boolean) {
    const body: Record<string, unknown> = {
      hostname: hostname.trim(),
      managementUrl: managementUrl.trim(),
      wireguardPort: Number(wgPort) || 0,
      externalIpMap: ipMap.trim(),
      https: {
        domain: domain.trim(),
        email: email.trim(),
        ...(cfToken.trim() ? { cloudflareToken: cfToken.trim() } : {}),
        ...(httpsEnabled !== undefined ? { enabled: httpsEnabled } : {}),
      },
      ...(setupKey.trim() ? { setupKey: setupKey.trim() } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
    send('PUT', '/api/netbird', body, 'Saved. The change is applied now.');
  }

  if (needToken) {
    return (
      <main className="max-w-xl mx-auto p-6 space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">NetBird</h1>
        <div className={card}>
          <label className={label}>Admin token (SIDECAR_ADMIN_TOKEN)</label>
          <input className={input} type="password" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
          <button className={`${btn} bg-slate-900 text-white`} onClick={() => {
            window.localStorage.setItem(TOKEN_KEY, adminToken.trim()); load(true).catch(() => {});
          }}>Unlock</button>
          {err && <p className="text-sm text-red-700">{err}</p>}
        </div>
      </main>
    );
  }

  if (!v) return <main className="mx-auto w-[90%] p-6 text-slate-500">{err || 'Loading…'}</main>;

  const st = v.status;
  const cert = v.https.certificate;
  return (
    <main className="mx-auto w-[90%] p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">NetBird</h1>
      </div>
      <p className="text-sm text-slate-600">
        This sidecar joins NetBird as <span className="font-mono">{v.fqdn}</span>. Masters then reach it, and it reaches
        them, over NetBird. No port is opened on the host.
      </p>

      {v.supported === false && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{v.reason}</div>
      )}
      {err && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">{msg}</div>}

      <section className={card}>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-900">Status</h2>
          <Chip ok={v.enabled ? !!st?.connected : null} text={!v.enabled ? 'off' : st?.connected ? 'connected' : 'not connected'} />
        </div>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Name</dt><dd className="font-mono">{st?.fqdn || v.fqdn}</dd>
          <dt className="text-slate-500">NetBird IP</dt><dd className="font-mono">{st?.ip || '—'}</dd>
          <dt className="text-slate-500">Management</dt><dd>{st ? (st.managementConnected ? 'connected' : 'not connected') : '—'}</dd>
          <dt className="text-slate-500">Peers</dt><dd>{st ? `${st.peersConnected} / ${st.peersTotal}` : '—'}</dd>
          {v.companions.map((c) => c && (
            <Fragment key={c.name}><dt className="text-slate-500 font-mono text-xs pt-0.5">{c.name}</dt>
              <dd>{c.state}{c.error ? <span className="text-red-700"> — {c.error}</span> : null}</dd></Fragment>
          ))}
          <dt className="text-slate-500">Last check</dt><dd>{v.lastReconcileAt ? new Date(v.lastReconcileAt).toLocaleTimeString() : '—'}</dd>
        </dl>
      </section>

      <section className={card}>
        <h2 className="text-lg font-semibold text-slate-900">NetBird</h2>
        <div>
          <label className={label}>Setup key</label>
          <input className={input} type="password" placeholder={v.hasSetupKey ? `saved (…${v.setupKeyHint})` : 'paste the setup key'}
            value={setupKey} onChange={(e) => setSetupKey(e.target.value)} autoComplete="off" />
          <p className={help}>NetBird dashboard → Setup Keys. Use a reusable key with the group <span className="font-mono">sidecars</span>.</p>
        </div>
        <div>
          <label className={label}>Hostname</label>
          <input className={input} placeholder={v.hostnameIsDefault ? v.hostname : ''} value={hostname} onChange={(e) => setHostname(e.target.value)} />
          <p className={help}>Empty = <span className="font-mono">{v.hostnameIsDefault ? v.hostname : '<host>-sidecar'}</span>. The peer name is <span className="font-mono">{(hostname.trim() || v.hostname)}{domain.trim() ? `.${domain.trim()}` : ''}</span>.</p>
        </div>
        <div>
          <label className={label}>Management URL</label>
          <input className={input} value={managementUrl} onChange={(e) => setManagementUrl(e.target.value)} />
          <p className={help}>Your NetBird server. Default: NetBird cloud (https://api.netbird.io:443).</p>
        </div>
        <div>
          <label className={label}>Domain</label>
          <input className={input} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="for example netbird.example.com" />
          <p className={help}>The NetBird DNS domain of your network. HTTPS needs it.</p>
        </div>
        <button className="text-sm text-blue-700 hover:underline" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? 'Hide' : 'Show'} advanced
        </button>
        {showAdvanced && (
          <div className="space-y-3">
            <div>
              <label className={label}>WireGuard port</label>
              <input className={input} value={wgPort} onChange={(e) => setWgPort(e.target.value)} />
              <p className={help}>0 = automatic (keep it). The port is not published on the host.</p>
            </div>
            <div>
              <label className={label}>External IP map</label>
              <input className={input} value={ipMap} onChange={(e) => setIpMap(e.target.value)} placeholder="empty" />
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} className={`${btn} bg-slate-900 text-white`} onClick={() => save(true)}>
            {v.enabled ? 'Save' : 'Save and connect'}
          </button>
          {v.enabled && <button disabled={busy} className={`${btn} bg-slate-200`} onClick={() => save(false)}>Turn off</button>}
          {v.hasSetupKey && (
            <button disabled={busy} className={`${btn} text-red-700`} onClick={() => {
              if (window.confirm('Remove the setup key? NetBird turns off.')) send('DELETE', '/api/netbird/key', null, 'Setup key removed.');
            }}>Remove key</button>
          )}
        </div>
      </section>

      <section className={card}>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-900">HTTPS</h2>
          <Chip ok={v.https.enabled ? !!cert?.trusted : null} text={!v.https.enabled ? 'off' : cert ? (cert.trusted ? 'certificate OK' : 'certificate not trusted yet') : 'waiting'} />
        </div>
        <p className="text-sm text-slate-600">
          Serves <a className="font-mono text-blue-700" href={v.https.url}>{v.https.url}</a> on the NetBird IP, with a Let&apos;s Encrypt
          certificate (Cloudflare DNS check, no open port). Needs NetBird on and the domain set above.
        </p>
        {cert && <p className="text-xs text-slate-500">Certificate: {cert.names.join(', ')} · {cert.issuer} · until {cert.notAfter?.slice(0, 10)}</p>}
        <div>
          <label className={label}>Cloudflare API token</label>
          <input className={input} type="password" placeholder={v.https.hasToken ? `saved (…${v.https.tokenHint})` : 'paste the token'}
            value={cfToken} onChange={(e) => setCfToken(e.target.value)} autoComplete="off" />
          <p className={help}>Cloudflare → My Profile → API Tokens → Custom token: Zone.DNS Edit on the zone of the domain.</p>
        </div>
        <div>
          <label className={label}>Email (Let&apos;s Encrypt, optional)</label>
          <input className={input} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} className={`${btn} bg-slate-900 text-white`} onClick={() => save(undefined, true)}>
            {v.https.enabled ? 'Save' : 'Save and turn on HTTPS'}
          </button>
          {v.https.enabled && <button disabled={busy} className={`${btn} bg-slate-200`} onClick={() => save(undefined, false)}>Turn off HTTPS</button>}
          {v.https.hasToken && (
            <button disabled={busy} className={`${btn} text-red-700`} onClick={() => {
              if (window.confirm('Remove the Cloudflare token? HTTPS turns off.')) send('DELETE', '/api/netbird/https-token', null, 'Token removed.');
            }}>Remove token</button>
          )}
        </div>
      </section>
    </main>
  );
}
