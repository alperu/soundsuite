/**
 * NetBird + HTTPS settings for this sidecar (the /netbird page).
 *
 * The sidecar joins NetBird as <hostname>.<domain> (domain from the page or
 * SIDECAR_NETBIRD_DOMAIN)
 * through a companion container that shares its network namespace, and can
 * serve https://<hostname>.<domain> through a Caddy companion with a
 * Let's Encrypt certificate (Cloudflare DNS-01). See netbird-companion.ts.
 *
 * Storage: one folder (default /app/config/netbird, on the config volume):
 *   settings.json  non-secret settings
 *   setup-key      NetBird setup key   (mode 600, read by the companion as NB_SETUP_KEY_FILE)
 *   cf-token       Cloudflare API token (mode 600, read by the Caddy companion)
 *   Caddyfile      written by netbird-companion.ts
 * Secrets never leave this folder: the view carries only the last 4 characters.
 *
 * Pure apart from fs on the folder passed in, so tests run on a temp dir.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** NetBird's public cloud, unless SIDECAR_NETBIRD_MANAGEMENT_URL names a self-hosted server. */
export const defaultManagementUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  validManagementUrl(env.SIDECAR_NETBIRD_MANAGEMENT_URL) ? env.SIDECAR_NETBIRD_MANAGEMENT_URL.trim() : 'https://api.netbird.io:443';
/** The NetBird DNS domain (for example netbird.cloud or your own). Empty = not set. */
export const defaultDomain = (env: NodeJS.ProcessEnv = process.env): string => {
  const d = env.SIDECAR_NETBIRD_DOMAIN?.trim().toLowerCase() ?? '';
  return validDomain(d) ? d : '';
};
export const SETUP_KEY_FILE = 'setup-key';
export const CF_TOKEN_FILE = 'cf-token';
export const SETTINGS_FILE = 'settings.json';

export interface HttpsSettings { enabled: boolean; domain: string; email: string }

export interface NetbirdSettings {
  enabled: boolean;
  /** Empty = derived from the Docker host name (see defaultHostname). */
  hostname: string;
  managementUrl: string;
  /** 0 = NetBird picks the port. Nothing is published on the host either way. */
  wireguardPort: number;
  externalIpMap: string;
  https: HttpsSettings;
  updatedAt: string | null;
}

export class NetbirdInputError extends Error {}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SETUP_KEY_RE = /^[A-Za-z0-9-]{20,100}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const EMAIL_RE = /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/;
const IPV4 = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}';
const IP_MAP_ENTRY_RE = new RegExp(`^${IPV4}(/(${IPV4}|[A-Za-z0-9_.-]{1,15}))?$`);

export const validHostname = (h: unknown): h is string => typeof h === 'string' && HOSTNAME_RE.test(h);
export const validDomain = (d: unknown): d is string => typeof d === 'string' && DOMAIN_RE.test(d);
export const validWireguardPort = (p: unknown): p is number =>
  typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 65535;
export const validExternalIpMap = (m: unknown): m is string =>
  typeof m === 'string' && m.length <= 500 && (m === '' || m.split(',').every((e) => IP_MAP_ENTRY_RE.test(e)));
export function validManagementUrl(u: unknown): u is string {
  if (typeof u !== 'string' || !u.trim()) return false;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

export const keyHint = (k: string | null): string | null => (k ? k.slice(-4) : null);

/**
 * Default peer name: the Docker host's name + "-sidecar", so each sidecar gets a
 * different name under the domain (gpu-box → gpu-box-sidecar.<domain>).
 */
export function defaultHostname(dockerHostName: string | null | undefined): string {
  const base = (dockerHostName || 'host')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return `${base || 'host'}-sidecar`;
}

const defaults = (): NetbirdSettings => ({
  enabled: false,
  hostname: '',
  managementUrl: defaultManagementUrl(),
  wireguardPort: 0,
  externalIpMap: '',
  https: { enabled: false, domain: defaultDomain(), email: '' },
  updatedAt: null,
});

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function readSettings(dir: string): NetbirdSettings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'));
  } catch { /* none yet */ }
  if (!isObj(raw)) return defaults();
  const h = isObj(raw.https) ? raw.https : {};
  return {
    enabled: raw.enabled === true,
    hostname: validHostname(raw.hostname) ? raw.hostname : '',
    managementUrl: validManagementUrl(raw.managementUrl) ? raw.managementUrl : defaultManagementUrl(),
    wireguardPort: validWireguardPort(raw.wireguardPort) ? raw.wireguardPort : 0,
    externalIpMap: validExternalIpMap(raw.externalIpMap) ? raw.externalIpMap : '',
    https: {
      enabled: h.enabled === true,
      domain: validDomain(h.domain) ? h.domain : defaultDomain(),
      email: typeof h.email === 'string' && EMAIL_RE.test(h.email) ? h.email : '',
    },
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export function readSecret(dir: string, file: string): string | null {
  try {
    const v = fs.readFileSync(path.join(dir, file), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Short fingerprint of a secret, so a changed secret changes a companion's spec hash. */
export function secretFingerprint(dir: string, file: string): string {
  const v = readSecret(dir, file);
  return v ? crypto.createHash('sha256').update(v).digest('hex').slice(0, 16) : '';
}

/** temp file + rename, so a reader never sees half a file. */
function writeAtomic(file: string, data: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function writeSettings(dir: string, s: NetbirdSettings): void {
  writeAtomic(path.join(dir, SETTINGS_FILE), JSON.stringify(s, null, 2) + '\n', 0o644);
}

/**
 * Partial update. Body:
 *   { setupKey?, hostname?, managementUrl?, wireguardPort?, externalIpMap?, enabled?,
 *     https?: { enabled?, domain?, email?, cloudflareToken? } }
 * Throws NetbirdInputError on a bad field and writes nothing in that case.
 */
export function updateSettings(dir: string, body: unknown, now: () => Date = () => new Date()): NetbirdSettings {
  if (!isObj(body)) throw new NetbirdInputError('Body must be a JSON object.');
  const s = readSettings(dir);
  let setupKey: string | null = null;
  let cfToken: string | null = null;

  if (body.setupKey !== undefined) {
    const k = typeof body.setupKey === 'string' ? body.setupKey.trim() : '';
    if (!SETUP_KEY_RE.test(k)) throw new NetbirdInputError('Setup key: letters, digits and dashes, 20-100 characters.');
    setupKey = k;
  }
  if (body.hostname !== undefined) {
    const h = typeof body.hostname === 'string' ? body.hostname.trim().toLowerCase() : null;
    if (h === null || (h !== '' && !validHostname(h))) {
      throw new NetbirdInputError('Hostname: a-z, 0-9 and dashes, 1-63 characters, or empty for the default.');
    }
    s.hostname = h;
  }
  if (body.managementUrl !== undefined) {
    if (!validManagementUrl(body.managementUrl)) throw new NetbirdInputError('Management URL must be an https:// URL.');
    s.managementUrl = body.managementUrl.trim();
  }
  if (body.wireguardPort !== undefined) {
    if (!validWireguardPort(body.wireguardPort)) throw new NetbirdInputError('WireGuard port: 0-65535 (0 = automatic).');
    s.wireguardPort = body.wireguardPort;
  }
  if (body.externalIpMap !== undefined) {
    const m = typeof body.externalIpMap === 'string' ? body.externalIpMap.replace(/\s+/g, '') : null;
    if (!validExternalIpMap(m)) throw new NetbirdInputError('External IP map: IP, IP/IP or IP/interface, comma separated.');
    s.externalIpMap = m;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new NetbirdInputError('enabled must be true or false.');
    s.enabled = body.enabled;
  }
  if (body.https !== undefined) {
    if (!isObj(body.https)) throw new NetbirdInputError('https must be an object.');
    const h = body.https;
    if (h.enabled !== undefined) {
      if (typeof h.enabled !== 'boolean') throw new NetbirdInputError('https.enabled must be true or false.');
      s.https.enabled = h.enabled;
    }
    if (h.domain !== undefined) {
      const d = typeof h.domain === 'string' ? h.domain.trim().toLowerCase() : '';
      if (d !== '' && !validDomain(d)) throw new NetbirdInputError('Domain: for example netbird.example.com.');
      s.https.domain = d;
    }
    if (h.email !== undefined) {
      const e = typeof h.email === 'string' ? h.email.trim() : '';
      if (e !== '' && !EMAIL_RE.test(e)) throw new NetbirdInputError('Email is not valid.');
      s.https.email = e;
    }
    if (h.cloudflareToken !== undefined) {
      const t = typeof h.cloudflareToken === 'string' ? h.cloudflareToken.trim() : '';
      if (!TOKEN_RE.test(t)) throw new NetbirdInputError('Cloudflare token: letters, digits, _ and -, 20-200 characters.');
      cfToken = t;
    }
  }

  if (s.enabled && !setupKey && !readSecret(dir, SETUP_KEY_FILE)) {
    throw new NetbirdInputError('Paste a setup key before you turn NetBird on.');
  }
  if (s.https.enabled && !s.https.domain) {
    throw new NetbirdInputError('Set the domain before you turn HTTPS on.');
  }
  if (s.https.enabled && !cfToken && !readSecret(dir, CF_TOKEN_FILE)) {
    throw new NetbirdInputError('Paste a Cloudflare token before you turn HTTPS on.');
  }

  if (setupKey) writeAtomic(path.join(dir, SETUP_KEY_FILE), setupKey + '\n', 0o600);
  if (cfToken) writeAtomic(path.join(dir, CF_TOKEN_FILE), cfToken + '\n', 0o600);
  s.updatedAt = now().toISOString();
  writeSettings(dir, s);
  return s;
}

/** Remove the setup key (turns NetBird off) or the Cloudflare token (turns HTTPS off). */
export function removeSecret(dir: string, which: 'setupKey' | 'cloudflareToken', now: () => Date = () => new Date()): NetbirdSettings {
  const s = readSettings(dir);
  const file = which === 'setupKey' ? SETUP_KEY_FILE : CF_TOKEN_FILE;
  fs.rmSync(path.join(dir, file), { force: true });
  if (which === 'setupKey') s.enabled = false;
  else s.https.enabled = false;
  s.updatedAt = now().toISOString();
  writeSettings(dir, s);
  return s;
}

export interface NetbirdStatus {
  connected: boolean;
  fqdn: string | null;
  ip: string | null;
  managementConnected: boolean;
  peersConnected: number;
  peersTotal: number;
}

/** Map `netbird status --json` to the small status the page shows. */
export function parseNetbirdStatus(raw: unknown): NetbirdStatus | null {
  if (!isObj(raw)) return null;
  const ip = typeof raw.netbirdIp === 'string' && raw.netbirdIp ? raw.netbirdIp.split('/')[0] : null;
  const fqdn = typeof raw.fqdn === 'string' && raw.fqdn ? raw.fqdn : null;
  const mgmt = isObj(raw.management) && raw.management.connected === true;
  const peers = isObj(raw.peers) ? raw.peers : {};
  return {
    connected: mgmt && !!ip,
    fqdn,
    ip,
    managementConnected: mgmt,
    peersConnected: Number(peers.connected) || 0,
    peersTotal: Number(peers.total) || 0,
  };
}

/** The Caddyfile for https://<fqdn> → the sidecar's own port. The token comes from env. */
export function buildCaddyfile(fqdn: string, upstreamPort: number, email: string): string {
  const global = email ? `{\n\temail ${email}\n}\n\n` : '';
  return (
    `${global}${fqdn} {\n` +
    `\ttls {\n\t\tdns cloudflare {env.CF_API_TOKEN}\n\t}\n` +
    `\treverse_proxy 127.0.0.1:${upstreamPort}\n` +
    `}\n`
  );
}

export function writeCaddyfile(dir: string, content: string): void {
  writeAtomic(path.join(dir, 'Caddyfile'), content, 0o644);
}
