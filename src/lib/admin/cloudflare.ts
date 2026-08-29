/**
 * Cloudflare Tunnel settings + status for the admin UI.
 *
 * Settings live in the Config table under `cloudflare.*` keys. Secrets
 * (API key, tunnel token) are masked when read for display — only the last
 * 4 characters are shown — and a masked placeholder sent back on save is
 * ignored so a GET→PUT round-trip never clobbers a stored secret.
 *
 * The status probe never throws: every check reports its outcome as a value.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prisma } from '@/lib/db/prisma';

const execFileAsync = promisify(execFile);

export const MASK_CHAR = '•';

/** Config-table keys, in display order. */
const SETTING_KEYS = [
  'domain',
  'accountId',
  'apiKey',
  'tunnelId',
  'tunnelToken',
  'credentialsPath',
  'ingressPaths',
  'metricsAddress',
] as const;

type SettingKey = (typeof SETTING_KEYS)[number];

const SECRET_KEYS: ReadonlySet<SettingKey> = new Set(['apiKey', 'tunnelToken']);

export const DEFAULT_INGRESS_PATHS = ['/api/mcp', '/.well-known/oauth-protected-resource'];
export const DEFAULT_METRICS_ADDRESS = '127.0.0.1:20241';

export type CloudflareSettings = Record<SettingKey, string>;

const configKey = (key: SettingKey) => `cloudflare.${key}`;

/** `sk-abcd1234` → `••••••••1234`. Short secrets are fully masked. */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return MASK_CHAR.repeat(value.length);
  return MASK_CHAR.repeat(Math.max(4, value.length - 4)) + value.slice(-4);
}

/** True when a submitted value is a masked placeholder echoed back from GET. */
export function isMaskedPlaceholder(value: string): boolean {
  return value.length > 0 && new RegExp(`^${MASK_CHAR}+[^${MASK_CHAR}]{0,4}$`).test(value);
}

async function readRawSettings(): Promise<CloudflareSettings> {
  const rows = await prisma.config.findMany({
    where: { key: { in: SETTING_KEYS.map(configKey) } },
  });
  const byKey = new Map(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
  const out = {} as CloudflareSettings;
  for (const k of SETTING_KEYS) out[k] = byKey.get(configKey(k)) ?? '';
  return out;
}

/** Settings for display: secrets masked to their last 4 characters. */
export async function getCloudflareSettings(): Promise<CloudflareSettings> {
  const raw = await readRawSettings();
  for (const k of SETTING_KEYS) {
    if (SECRET_KEYS.has(k)) raw[k] = maskSecret(raw[k]);
  }
  return raw;
}

/**
 * Partial update. Unknown keys are ignored; masked placeholders for secret
 * fields are ignored (the stored secret is kept). Returns the masked view.
 */
export async function updateCloudflareSettings(
  updates: Partial<Record<string, unknown>>,
): Promise<CloudflareSettings> {
  for (const k of SETTING_KEYS) {
    const v = updates[k];
    if (typeof v !== 'string') continue;
    if (SECRET_KEYS.has(k) && isMaskedPlaceholder(v)) continue;
    const key = configKey(k);
    await prisma.config.upsert({
      where: { key },
      update: { value: v },
      create: { key, value: v },
    });
  }
  return getCloudflareSettings();
}

// ─── Status probe ────────────────────────────────────────────────────────────

export interface CloudflareStatus {
  /** Is a `cloudflared` process running on this host? */
  process: 'running' | 'not-running' | 'unknown';
  /** cloudflared's local metrics endpoint. */
  metrics: { state: 'reachable' | 'unreachable' | 'not-configured'; address: string; haConnections?: number };
  /** HEAD https://<domain> — public edge reachability. */
  publicHostname: { state: 'reachable' | 'unreachable' | 'not-configured'; domain?: string; httpStatus?: number };
  checkedAt: string;
}

async function probeProcess(): Promise<CloudflareStatus['process']> {
  try {
    await execFileAsync('pgrep', ['-x', 'cloudflared']);
    return 'running';
  } catch (err) {
    // pgrep exits 1 when no process matches; anything else (ENOENT etc.) is unknown.
    const code = (err as { code?: number | string }).code;
    return code === 1 ? 'not-running' : 'unknown';
  }
}

async function probeMetrics(address: string): Promise<CloudflareStatus['metrics']> {
  if (!/^[\w.-]+:\d+$/.test(address)) return { state: 'not-configured', address };
  try {
    const res = await fetch(`http://${address}/metrics`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { state: 'unreachable', address };
    const body = await res.text();
    // cloudflared exposes cloudflared_tunnel_ha_connections — the count of live
    // edge connections. Absent (or 0) means the tunnel is up but not connected.
    const m = body.match(/^cloudflared_tunnel_ha_connections\s+(\d+)/m);
    return { state: 'reachable', address, haConnections: m ? Number(m[1]) : undefined };
  } catch {
    return { state: 'unreachable', address };
  }
}

async function probePublicHostname(domain: string): Promise<CloudflareStatus['publicHostname']> {
  if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)) {
    return { state: 'not-configured' };
  }
  try {
    const res = await fetch(`https://${domain}/api/mcp`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    // Any HTTP response (even 4xx) proves the edge reached an origin.
    return { state: 'reachable', domain, httpStatus: res.status };
  } catch {
    return { state: 'unreachable', domain };
  }
}

export async function getCloudflareStatus(): Promise<CloudflareStatus> {
  const raw = await readRawSettings();
  const metricsAddress = raw.metricsAddress || DEFAULT_METRICS_ADDRESS;
  const [process, metrics, publicHostname] = await Promise.all([
    probeProcess(),
    probeMetrics(metricsAddress),
    probePublicHostname(raw.domain),
  ]);
  return { process, metrics, publicHostname, checkedAt: new Date().toISOString() };
}

// ─── config.yml generation ───────────────────────────────────────────────────

export interface GeneratedConfig {
  yaml: string;
  /** Shell commands the operator runs by hand (never executed by the app). */
  commands: { title: string; command: string }[];
  ready: boolean;
  missing: string[];
}

/**
 * Render a cloudflared config.yml restricted to the MCP endpoint and the
 * OAuth discovery path. Everything else 404s at the edge.
 */
export async function generateCloudflaredConfig(): Promise<GeneratedConfig> {
  const raw = await readRawSettings();
  const domain = raw.domain || '<your-domain>';
  const tunnelId = raw.tunnelId || '<tunnel-id>';
  const credentialsFile = raw.credentialsPath || `~/.cloudflared/${tunnelId}.json`;
  const metricsAddress = raw.metricsAddress || DEFAULT_METRICS_ADDRESS;
  const paths = (raw.ingressPaths ? raw.ingressPaths.split(',').map(p => p.trim()).filter(Boolean) : DEFAULT_INGRESS_PATHS);

  const missing: string[] = [];
  if (!raw.domain) missing.push('domain');
  if (!raw.tunnelId) missing.push('tunnelId');

  const ingressRules = paths
    .map(p => [
      `  - hostname: ${domain}`,
      `    path: ${p.startsWith('^') ? p : `^${escapeForPathRegex(p)}`}`,
      `    service: http://127.0.0.1:3000`,
      `    originRequest:`,
      `      httpHostHeader: 127.0.0.1:3000`,
    ].join('\n'))
    .join('\n');

  const yaml = [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${credentialsFile}`,
    `metrics: ${metricsAddress}`,
    ``,
    `ingress:`,
    ingressRules,
    `  - service: http_status:404`,
    ``,
  ].join('\n');

  const configPath = '~/.cloudflared/config.yml';
  const commands: GeneratedConfig['commands'] = [
    { title: 'Install cloudflared', command: 'brew install cloudflared' },
    { title: 'Authenticate with Cloudflare', command: 'cloudflared tunnel login' },
    { title: 'Create the tunnel', command: 'cloudflared tunnel create sound-suite-mcp' },
    { title: `Write the config (paste the YAML above into ${configPath})`, command: `mkdir -p ~/.cloudflared && $EDITOR ${configPath}` },
    { title: 'Route DNS to the tunnel', command: `cloudflared tunnel route dns ${tunnelId === '<tunnel-id>' ? 'sound-suite-mcp' : tunnelId} ${domain}` },
    { title: 'Test the tunnel in the foreground', command: 'cloudflared tunnel run' },
    { title: 'Install as a service (launchd on macOS)', command: 'sudo cloudflared service install' },
  ];

  return { yaml, commands, ready: missing.length === 0, missing };
}

/** Ingress `path` is a regex — escape a literal URL path for exact-prefix match. */
function escapeForPathRegex(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
