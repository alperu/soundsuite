'use client';

/**
 * Cloudflare Tunnel admin panel: settings form, live tunnel status card,
 * and the generated cloudflared config.yml + setup commands.
 *
 * Secrets round-trip masked (last 4 chars) — the API ignores masked
 * placeholders on save, so leaving a secret field untouched keeps it.
 */

import { useState, useEffect, useCallback } from 'react';
import { CopyButton } from '@/components/copy-button';

interface Settings {
  domain: string;
  accountId: string;
  apiKey: string;
  tunnelId: string;
  tunnelToken: string;
  credentialsPath: string;
  ingressPaths: string;
  metricsAddress: string;
}

interface Status {
  process: 'running' | 'not-running' | 'unknown';
  metrics: { state: string; address: string; haConnections?: number };
  publicHostname: { state: string; domain?: string; httpStatus?: number };
  checkedAt: string;
}

interface GeneratedConfig {
  yaml: string;
  commands: { title: string; command: string }[];
  ready: boolean;
  missing: string[];
}

const EMPTY_SETTINGS: Settings = {
  domain: '', accountId: '', apiKey: '', tunnelId: '',
  tunnelToken: '', credentialsPath: '', ingressPaths: '', metricsAddress: '',
};

function Badge({ tone, children }: { tone: 'green' | 'yellow' | 'red' | 'gray'; children: React.ReactNode }) {
  const cls = {
    green: 'bg-green-100 text-green-700',
    yellow: 'bg-yellow-100 text-yellow-700',
    red: 'bg-red-100 text-red-700',
    gray: 'bg-gray-100 text-gray-500',
  }[tone];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{children}</span>;
}

export default function CloudflarePanel() {
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<GeneratedConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/cloudflare');
      const data = await res.json();
      if (data.settings) setSettings({ ...EMPTY_SETTINGS, ...data.settings });
    } catch { /* leave form empty */ }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/cloudflare/config');
      setConfig(await res.json());
    } catch { setConfig(null); }
  }, []);

  const refreshStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/admin/cloudflare/status');
      const data = await res.json();
      if (data.status) setStatus(data.status);
    } catch { /* keep last status */ }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([loadSettings(), loadConfig(), refreshStatus()]);
      setLoading(false);
    })();
  }, [loadSettings, loadConfig, refreshStatus]);

  // 30s auto-refresh of tunnel status
  useEffect(() => {
    const id = setInterval(refreshStatus, 30_000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/cloudflare', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (res.ok && data.settings) {
        setSettings({ ...EMPTY_SETTINGS, ...data.settings });
        setMessage({ text: 'Settings saved', ok: true });
        await loadConfig();
      } else {
        setMessage({ text: data.error || 'Save failed', ok: false });
      }
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Save failed', ok: false });
    }
    setSaving(false);
  };

  const field = (key: keyof Settings, label: string, opts?: { secret?: boolean; placeholder?: string; hint?: string }) => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={opts?.secret ? 'password' : 'text'}
        value={settings[key]}
        onChange={e => setSettings(s => ({ ...s, [key]: e.target.value }))}
        placeholder={opts?.placeholder}
        autoComplete="off"
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {opts?.hint && <p className="text-xs text-gray-500 mt-1">{opts.hint}</p>}
    </div>
  );

  if (loading) {
    return <div className="text-gray-500 text-sm">Loading Cloudflare settings...</div>;
  }

  const procTone = status?.process === 'running' ? 'green' : status?.process === 'not-running' ? 'red' : 'gray';
  const metricsTone = status?.metrics.state === 'reachable'
    ? (status.metrics.haConnections ? 'green' : 'yellow')
    : status?.metrics.state === 'unreachable' ? 'red' : 'gray';
  const publicTone = status?.publicHostname.state === 'reachable' ? 'green'
    : status?.publicHostname.state === 'unreachable' ? 'red' : 'gray';

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Status card */}
      <div className="border border-gray-200 rounded-lg p-4 bg-white">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900">Tunnel Status</h2>
          <button
            onClick={refreshStatus}
            disabled={refreshing}
            className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-gray-500 text-xs">cloudflared process</span>
            <Badge tone={procTone}>
              {status?.process === 'running' ? 'Running' : status?.process === 'not-running' ? 'Not running' : 'Unknown'}
            </Badge>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-500 text-xs">Metrics ({status?.metrics.address ?? '—'})</span>
            <Badge tone={metricsTone}>
              {status?.metrics.state === 'reachable'
                ? `Reachable${status.metrics.haConnections !== undefined ? ` · ${status.metrics.haConnections} edge conns` : ''}`
                : status?.metrics.state === 'unreachable' ? 'Unreachable' : 'Not configured'}
            </Badge>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-gray-500 text-xs">Public hostname</span>
            <Badge tone={publicTone}>
              {status?.publicHostname.state === 'reachable'
                ? `Reachable (HTTP ${status.publicHostname.httpStatus})`
                : status?.publicHostname.state === 'unreachable' ? 'Unreachable' : 'No domain set'}
            </Badge>
          </div>
        </div>
        {status && (
          <p className="text-xs text-gray-400 mt-3">Last checked {new Date(status.checkedAt).toLocaleTimeString()} · auto-refreshes every 30s</p>
        )}
      </div>

      {/* Settings form */}
      <div className="border border-gray-200 rounded-lg p-4 bg-white">
        <h2 className="text-base font-semibold text-gray-900 mb-3">Tunnel Settings</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {field('domain', 'Domain', { placeholder: 'mcp.example.com', hint: 'Public hostname routed through the tunnel' })}
          {field('accountId', 'Cloudflare Account ID')}
          {field('apiKey', 'API Key / Token', { secret: true, hint: 'Stored server-side; shown masked (last 4 chars)' })}
          {field('tunnelId', 'Tunnel ID', { placeholder: 'UUID from cloudflared tunnel create' })}
          {field('tunnelToken', 'Tunnel Token', { secret: true, hint: 'Optional — for token-based (remotely-managed) tunnels' })}
          {field('credentialsPath', 'Credentials File Path', { placeholder: '~/.cloudflared/<tunnel-id>.json' })}
          {field('ingressPaths', 'Ingress Paths', { placeholder: '/api/mcp, /.well-known/oauth-protected-resource', hint: 'Comma-separated; blank uses the MCP defaults' })}
          {field('metricsAddress', 'Metrics Address', { placeholder: '127.0.0.1:20241' })}
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          {message && (
            <span className={`text-sm ${message.ok ? 'text-green-600' : 'text-red-600'}`}>{message.text}</span>
          )}
        </div>
      </div>

      {/* Generated config */}
      <div className="border border-gray-200 rounded-lg p-4 bg-white">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Generated config.yml</h2>
        <p className="text-xs text-gray-500 mb-3">
          Ingress is restricted to the MCP endpoint and OAuth discovery path; everything else returns 404 at the edge.
          {config && !config.ready && (
            <span className="text-yellow-600"> Missing: {config.missing.join(', ')} — placeholders shown.</span>
          )}
        </p>
        {config && (
          <>
            <div className="relative">
              <pre className="bg-gray-900 text-gray-100 text-xs rounded-md p-3 overflow-x-auto font-mono whitespace-pre">{config.yaml}</pre>
              <div className="absolute top-2 right-2 bg-gray-800 rounded">
                <CopyButton text={config.yaml} className="text-gray-300 hover:text-white hover:bg-gray-700" />
              </div>
            </div>
            <h3 className="text-sm font-semibold text-gray-900 mt-4 mb-2">Setup commands</h3>
            <p className="text-xs text-gray-500 mb-2">Run these on the host yourself — the app never executes cloudflared.</p>
            <div className="space-y-2">
              {config.commands.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500">{i + 1}. {c.title}</div>
                    <code className="block text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 font-mono overflow-x-auto whitespace-nowrap">{c.command}</code>
                  </div>
                  <CopyButton text={c.command} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
