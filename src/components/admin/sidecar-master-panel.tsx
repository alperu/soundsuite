'use client';

/**
 * Admin → Sidecar master tab (task 57 / 3.6).
 *
 * Master URL, dashboard link, app token (write-only, last 4 shown), "Follow sidecarmaster"
 * switch, Test connection, and the follow status (connected, last sync, hosts seen, SSE,
 * snapshot). Talks to /api/admin/sidecar-master. The token never comes back from the API.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FleetSourceView, FollowStatus, MasterTestResult } from '@/lib/db/fleet-source';

const INPUT = 'w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50';

function Badge({ settings, status }: { settings: FleetSourceView | null; status: FollowStatus | null }) {
  if (!settings) return null;
  if (!settings.following) {
    return <span className="px-3 py-1 rounded-full text-sm font-medium bg-gray-200 text-gray-700">Local mode</span>;
  }
  if (status?.connected) {
    return <span className="px-3 py-1 rounded-full text-sm font-medium bg-green-100 text-green-800">Following, connected</span>;
  }
  if (status?.fromSnapshot) {
    return <span className="px-3 py-1 rounded-full text-sm font-medium bg-yellow-100 text-yellow-800">Following, using snapshot</span>;
  }
  return <span className="px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800">Following, not connected</span>;
}

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

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export default function SidecarMasterPanel() {
  const [settings, setSettings] = useState<FleetSourceView | null>(null);
  const [status, setStatus] = useState<FollowStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [masterUrl, setMasterUrl] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [token, setToken] = useState('');
  const [following, setFollowing] = useState(false);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [testResult, setTestResult] = useState<MasterTestResult | null>(null);

  const fill = (v: FleetSourceView) => {
    setMasterUrl(v.masterUrl); setLinkUrl(v.linkUrl); setFollowing(v.following);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/sidecar-master', { cache: 'no-store' });
      if (res.status === 403) { setForbidden(true); return; }
      const body = await res.json();
      if (!res.ok) { setLoadError(body.error || `HTTP ${res.status}`); return; }
      setLoadError(null);
      setSettings(body.settings);
      setStatus(body.status);
      setLoaded(prev => { if (!prev) fill(body.settings); return true; });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const save = async (patch: Record<string, unknown>, okText: string) => {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch('/api/admin/sidecar-master', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) { setMessage({ text: body.error || `HTTP ${res.status}`, ok: false }); return false; }
      setSettings(body.settings); setStatus(body.status); fill(body.settings);
      setToken('');
      setMessage({ text: okText, ok: true });
      return true;
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), ok: false });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => save(
    { masterUrl, linkUrl, ...(token.trim() ? { token } : {}) },
    'Saved.',
  );

  const onToggleFollow = async (on: boolean) => {
    if (on && !settings?.hasToken && !token.trim()) {
      setMessage({ text: 'Paste the app token first, then turn Follow on.', ok: false });
      return;
    }
    setFollowing(on);
    const ok = await save(
      { source: on ? 'follow' : 'local', masterUrl, linkUrl, ...(token.trim() ? { token } : {}) },
      on ? 'Following sidecarmaster. The GPU pages are read only now.' : 'Local mode. Sound Suite manages its fleet again.',
    );
    if (!ok) setFollowing(!on);
  };

  const onClearToken = () => save({ clearToken: true, source: 'local' }, 'Token removed. Local mode.');

  const onTest = async () => {
    setBusy(true); setMessage(null); setTestResult(null);
    try {
      const res = await fetch('/api/admin/sidecar-master', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ masterUrl, ...(token.trim() ? { token } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) { setMessage({ text: body.error || `HTTP ${res.status}`, ok: false }); return; }
      setTestResult(body as MasterTestResult);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : String(err), ok: false });
    } finally {
      setBusy(false);
    }
  };

  if (forbidden) {
    return <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 text-sm text-yellow-900">Admin role needed for this page.</div>;
  }

  return (
    <div className="space-y-6">
      {loadError && <div className="bg-red-50 text-red-800 border border-red-200 rounded-md p-3 text-sm">{loadError}</div>}
      {message && (
        <div className={`p-3 rounded-md text-sm ${message.ok ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
          {message.text}
        </div>
      )}

      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Sidecar master</h2>
          <Badge settings={settings} status={status} />
        </div>
        <p className="text-sm text-gray-600 mb-4">
          When <strong>Follow sidecarmaster</strong> is on, sidecarmaster owns the GPU fleet: role assignments, host
          provisioning, config pushes, container start/stop and the minimum-online loop. Sound Suite only reads the
          fleet from sidecarmaster and keeps routing its own GPU work. The sidecars stay connected to this server&apos;s
          relay on port {status ? '3002' : '3002'}.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Master URL</label>
            <input className={INPUT} value={masterUrl} onChange={e => setMasterUrl(e.target.value)}
              placeholder="http://10.10.20.192:3010" disabled={busy} />
            <p className="text-[11px] text-gray-500 mt-1">
              Address this server uses to read the fleet. On basws42 the LAN address or http://host.docker.internal:3010 is fastest.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Dashboard link (optional)</label>
            <input className={INPUT} value={linkUrl} onChange={e => setLinkUrl(e.target.value)}
              placeholder="https://sidecarmaster.vpn.bas.co" disabled={busy} />
            <p className="text-[11px] text-gray-500 mt-1">Used for the &quot;open in sidecarmaster&quot; links on the read-only pages. Empty = master URL.</p>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              App token {settings?.hasToken && <span className="font-normal text-gray-500">(set, ends in {settings.tokenHint})</span>}
            </label>
            <input className={INPUT} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)}
              placeholder={settings?.hasToken ? 'Leave empty to keep the current token' : 'smk_soundsuite_…'} disabled={busy} />
            <p className="text-[11px] text-gray-500 mt-1">
              Issue it in sidecarmaster: Apps → soundsuite → Issue token (scope fleet:read). It is shown there once. Sound Suite
              stores it and never shows it again.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-5">
          <button onClick={onSave} disabled={busy}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50">Save</button>
          <button onClick={onTest} disabled={busy || !masterUrl}
            className="px-4 py-2 bg-gray-100 text-gray-800 text-sm rounded-md hover:bg-gray-200 disabled:opacity-50">Test connection</button>
          {settings?.hasToken && (
            <button onClick={onClearToken} disabled={busy}
              className="px-4 py-2 text-red-700 text-sm rounded-md hover:bg-red-50 disabled:opacity-50">Remove token</button>
          )}
          <div className="ml-auto">
            <Toggle on={following} onChange={onToggleFollow} label="Follow sidecarmaster" disabled={busy || !loaded} />
          </div>
        </div>

        {testResult && (
          <div className={`mt-4 p-3 rounded-md text-sm ${testResult.ok ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
            {testResult.ok
              ? <>Connected to <code className="font-mono">{testResult.masterUrl}</code>: {testResult.hosts} host(s), {testResult.modes} mode(s).</>
              : <>Test failed: {testResult.error}{testResult.status ? ` (HTTP ${testResult.status})` : ''}</>}
          </div>
        )}
      </div>

      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Status</h2>
        {!status ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : !status.following ? (
          <div className="text-sm text-gray-600">Local mode. Sound Suite manages its own fleet.</div>
        ) : (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-gray-500">Connected</dt>
            <dd className={status.connected ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>{status.connected ? 'yes' : 'no'}</dd>
            <dt className="text-gray-500">Last sync</dt>
            <dd>{ago(status.lastSyncAt)}{status.lastSyncAt && <span className="text-gray-400"> ({new Date(status.lastSyncAt).toLocaleTimeString()})</span>}</dd>
            <dt className="text-gray-500">Hosts seen</dt>
            <dd>{status.hostsSeen}</dd>
            <dt className="text-gray-500">Event feed (SSE)</dt>
            <dd>{status.sse}</dd>
            <dt className="text-gray-500">Fleet copy</dt>
            <dd>{status.fromSnapshot ? `from the system.db snapshot (${ago(status.snapshotAt)})` : status.fleetAt ? `live, read ${ago(status.fleetAt)}` : 'none yet'}</dd>
            <dt className="text-gray-500">Snapshot saved</dt>
            <dd>{status.snapshotAt ? ago(status.snapshotAt) : 'never'}</dd>
            {status.lastError && (
              <>
                <dt className="text-gray-500">Last error</dt>
                <dd className="text-red-700 break-all">{status.lastError}</dd>
              </>
            )}
          </dl>
        )}
        {status?.following && status.linkUrl && (
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            {(['gpu', 'roleassign', 'hostprov', 'roletypes'] as const).map(p => (
              <a key={p} href={`${status.linkUrl}/${p}`} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                sidecarmaster /{p} ↗
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
