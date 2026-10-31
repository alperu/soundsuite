'use client';

/**
 * Admin → NetBird tab. Same design as mcpfantom dashboard/src/app/netbird/page.tsx:
 * setup key (last-4 hint), hostname, management URL, enabled, Advanced
 * (WireGuard port, advertised public IP) and HTTPS (Cloudflare token last-4 hint, certificate status).
 * Secrets are write-only: the API returns only hasKey/hasToken + last 4 chars.
 */

import { useCallback, useEffect, useState } from 'react';
import type { NetbirdView } from '@/lib/admin/netbird';

function Badge({ data }: { data: NetbirdView | null }) {
  if (!data) return null;
  if (!data.configured) {
    return <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">Container missing</span>;
  }
  if (data.status?.connected) {
    return <span className="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Connected</span>;
  }
  return <span className="px-3 py-1 rounded-full text-sm font-medium bg-gray-200 text-gray-700">Not connected</span>;
}

const INPUT = 'w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50';

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-3 cursor-pointer select-none">
      <button
        type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-gray-300'} disabled:opacity-50`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}

export default function NetbirdPanel() {
  const [data, setData] = useState<NetbirdView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [setupKey, setSetupKey] = useState('');
  const [hostname, setHostname] = useState('soundsuite');
  const [managementUrl, setManagementUrl] = useState('https://vpn.bas.co:443');
  const [enabled, setEnabled] = useState(false);
  const [wireguardPort, setWireguardPort] = useState('0');
  const [externalIpMap, setExternalIpMap] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [httpsEnabled, setHttpsEnabled] = useState(false);
  const [domain, setDomain] = useState('vpn.bas.co');
  const [email, setEmail] = useState('');
  const [cfToken, setCfToken] = useState('');

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const fill = (v: NetbirdView) => {
    setHostname(v.hostname); setManagementUrl(v.managementUrl); setEnabled(v.enabled);
    setWireguardPort(String(v.wireguardPort)); setExternalIpMap(v.externalIpMap ?? '');
    setHttpsEnabled(v.https.enabled); setDomain(v.https.domain); setEmail(v.https.email);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/netbird', { cache: 'no-store' });
      if (res.status === 403) { setForbidden(true); return; }
      const body = await res.json();
      if (!res.ok) { setLoadError(body.error || `HTTP ${res.status}`); return; }
      setLoadError(null);
      setData(body);
      setLoaded(prev => { if (!prev) fill(body); return true; });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const send = async (method: 'PUT' | 'DELETE', url: string, body?: unknown, okText = 'Saved. The containers pick up the change in about 10 seconds.') => {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const out = await res.json();
      if (!res.ok) { setMessage({ text: out.error || `HTTP ${res.status}`, ok: false }); return; }
      setData(out); fill(out); setSetupKey(''); setCfToken('');
      setMessage({ text: okText, ok: true });
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), ok: false });
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const port = Number(wireguardPort.trim() || '0');
    send('PUT', '/api/admin/netbird', {
      ...(setupKey.trim() ? { setupKey: setupKey.trim() } : {}),
      hostname: hostname.trim(),
      managementUrl: managementUrl.trim(),
      wireguardPort: port,
      externalIpMap: externalIpMap.trim(),
      enabled,
      https: {
        enabled: httpsEnabled,
        domain: domain.trim(),
        email: email.trim(),
        ...(cfToken.trim() ? { cloudflareToken: cfToken.trim() } : {}),
      },
    });
  };

  if (forbidden) return <p className="text-sm text-gray-500">Only admins can see NetBird settings.</p>;
  if (!loaded && !loadError) return <div className="text-gray-500 text-sm">Loading NetBird settings...</div>;

  const st = data?.status;
  const hs = data?.https.status;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-900">NetBird</h2>
        <p className="text-sm text-gray-500">Join this server to the NetBird network and serve it over HTTPS.</p>
      </div>

      {/* Status */}
      <div className="border border-gray-200 rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="font-medium text-gray-900">Status</span>
          <Badge data={data} />
          {st?.connected && (
            <>
              <span className="text-gray-600">Name: <b className="font-mono">{st.fqdn ?? '—'}</b></span>
              <span className="text-gray-600">NetBird IP: <b className="font-mono">{st.ip ?? '—'}</b></span>
              <span className="text-gray-600">Peers: {st.peersConnected} / {st.peersTotal}</span>
            </>
          )}
          {st?.updatedAt && <span className="text-gray-500">Checked: {new Date(st.updatedAt).toLocaleString()}</span>}
          <button onClick={load} className="ml-auto text-xs text-blue-600 hover:underline">Refresh</button>
        </div>
        {data && !data.configured && (
          <p className="mt-3 p-3 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-md text-sm">
            NetBird container not configured. You can still save the settings; they apply when the container runs.
          </p>
        )}
        {loadError && <p className="mt-3 p-3 bg-red-50 text-red-700 rounded-md text-sm">{loadError}</p>}
      </div>

      <form onSubmit={e => { e.preventDefault(); save(); }} className="border border-gray-200 rounded-lg p-6 space-y-4">
        <p className="text-sm text-gray-600">
          Make a setup key in the NetBird admin (Setup Keys), paste it here, then Save.
          The service will appear as <b className="font-mono">{hostname || 'soundsuite'}.vpn.bas.co</b>.
        </p>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Setup key</label>
          <input
            type="password" value={setupKey} onChange={e => setSetupKey(e.target.value)} autoComplete="off" className={INPUT}
            placeholder={data?.hasKey ? 'Leave empty to keep the saved key' : 'Paste the setup key'}
          />
          <p className="text-xs text-gray-500 mt-1">{data?.hasKey ? `Key saved, ends in ${data.keyHint}` : 'No key saved'}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Hostname</label>
          <input type="text" value={hostname} onChange={e => setHostname(e.target.value)} required className={INPUT} placeholder="soundsuite" />
          <p className="text-xs text-gray-500 mt-1">Lowercase letters, digits and &quot;-&quot;. Up to 63 characters.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Management URL</label>
          <input type="url" value={managementUrl} onChange={e => setManagementUrl(e.target.value)} required className={INPUT} placeholder="https://vpn.bas.co:443" />
        </div>

        <Toggle on={enabled} onChange={setEnabled} label="Enable NetBird" />

        {/* Advanced */}
        <div className="border-t border-gray-200 pt-4">
          <button type="button" onClick={() => setShowAdvanced(s => !s)} className="text-sm font-medium text-gray-700 hover:text-gray-900">
            {showAdvanced ? '▾' : '▸'} Advanced
          </button>
          {showAdvanced && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-gray-700 mb-1">WireGuard port</label>
              <input
                type="number" min={0} max={65535} value={wireguardPort}
                onChange={e => setWireguardPort(e.target.value)} className={`${INPUT} max-w-[10rem]`}
              />
              <p className="text-xs text-gray-500 mt-1">0 = NetBird picks a free port. Set a fixed port to forward it on the firewall (UDP) for direct peer-to-peer links.</p>
              <label className="block text-sm font-medium text-gray-700 mb-1 mt-3">Advertised public IP (optional)</label>
              <input
                type="text" value={externalIpMap} placeholder="99.92.186.153"
                onChange={e => setExternalIpMap(e.target.value)} className={`${INPUT} max-w-[20rem]`}
              />
              <p className="text-xs text-gray-500 mt-1">The public IP that forwards the WireGuard port (UDP) to this host. Peers then connect here directly instead of through the relay. Empty = not set. Passed as netbird up --external-ip-map.</p>
            </div>
          )}
        </div>

        {/* HTTPS */}
        <div className="border-t border-gray-200 pt-4 space-y-4">
          <h3 className="text-sm font-semibold text-gray-900">HTTPS</h3>
          <Toggle on={httpsEnabled} onChange={setHttpsEnabled} label="Serve HTTPS on the NetBird name" />
          <p className="text-xs text-gray-500">Address: <b className="font-mono">https://{hostname || 'soundsuite'}.{domain || 'vpn.bas.co'}</b></p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Domain</label>
            <input type="text" value={domain} onChange={e => setDomain(e.target.value)} className={INPUT} placeholder="vpn.bas.co" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Cloudflare API token</label>
            <input
              type="password" value={cfToken} onChange={e => setCfToken(e.target.value)} autoComplete="off" className={INPUT}
              placeholder={data?.https.hasToken ? 'Leave empty to keep the saved token' : 'Paste a token (Edit zone DNS, bas.co)'}
            />
            <p className="text-xs text-gray-500 mt-1">{data?.https.hasToken ? `Token saved, ends in ${data.https.tokenHint}` : 'No token saved'}</p>
            <div className="mt-2 text-xs text-gray-600 bg-blue-50 border border-blue-100 rounded-md p-3 space-y-1" data-testid="cf-token-help">
              <div className="font-medium text-gray-800">How to make the token</div>
              <div>Cloudflare: My Profile → API Tokens → Create Token → Custom token.</div>
              <table className="mt-1">
                <tbody>
                  <tr><td className="pr-3 align-top">Permissions</td><td><b>Zone → DNS → Edit</b> (adds the _acme-challenge TXT records)</td></tr>
                  <tr><td className="pr-3 align-top">Permissions</td><td><b>Zone → Zone → Read</b> (finds the zone ID of bas.co)</td></tr>
                  <tr><td className="pr-3 align-top">Zone Resources</td><td><b>Include → Specific zone → bas.co</b></td></tr>
                  <tr><td className="pr-3 align-top">IP filtering</td><td>Optional: allow only the office public IP</td></tr>
                  <tr><td className="pr-3 align-top">TTL</td><td>Optional: an end date (then paste a new token in every service)</td></tr>
                </tbody>
              </table>
              <div>No other permissions. Do not give Account or User permissions.</div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email (optional)</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={INPUT} />
          </div>
          <div className="text-sm bg-gray-50 rounded-md p-3 space-y-1">
            <div className="font-medium text-gray-800">Certificate</div>
            {!hs ? (
              <div className="text-gray-500">No status from the Caddy container yet.</div>
            ) : (
              <>
                <div className="text-gray-600">Caddy: {hs.running ? 'running' : 'not running'}{hs.stale ? ' (status is old)' : ''}</div>
                <div className="text-gray-600">Names: <span className="font-mono">{hs.certificate?.names.join(', ') || '—'}</span></div>
                <div className="text-gray-600">Expires: {hs.certificate?.notAfter ? new Date(hs.certificate.notAfter).toLocaleString() : '—'}</div>
                {hs.error && <div className="text-red-700">Last error: {hs.error}</div>}
              </>
            )}
          </div>
        </div>

        {message && (
          <p className={`p-3 rounded-md text-sm ${message.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{message.text}</p>
        )}

        <div className="flex flex-wrap justify-end gap-3 pt-2">
          <button
            type="button" disabled={!data?.https.hasToken || busy}
            onClick={() => { if (confirm('Remove the Cloudflare token? HTTPS stops.')) send('DELETE', '/api/admin/netbird/https-token', undefined, 'Token removed.'); }}
            className="px-4 py-2 text-sm text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-md disabled:opacity-50"
          >
            Remove token
          </button>
          <button
            type="button" disabled={!data?.hasKey || busy}
            onClick={() => { if (confirm('Remove the setup key and turn NetBird off?')) send('DELETE', '/api/admin/netbird/key', undefined, 'Key removed; NetBird is off.'); }}
            className="px-4 py-2 text-sm text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-md disabled:opacity-50"
          >
            Remove key
          </button>
          <button type="submit" disabled={busy} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-md">
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
