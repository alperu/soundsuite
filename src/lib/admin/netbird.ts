/**
 * NetBird + HTTPS settings for the Admin → NetBird tab. Same design as
 * mcpfantom src/admin/netbirdRoutes.ts (see fileSystemSideCar docs/https-netbird.md).
 *
 * The app shares the folder NETBIRD_CTL_DIR (default /netbird-ctl) with two
 * sidecar containers:
 *   - soundsuite-netbird (docker/netbird-entrypoint.sh) reads config.json and
 *     writes status.json (`netbird status --json`) every 10 s;
 *   - soundsuite-caddy (docker/caddy-entrypoint.sh) reads config.json and
 *     writes caddy-status.json.
 * We write config.json (mode 600). The setup key and the Cloudflare token
 * never leave the server and are never logged: views give only hasKey /
 * hasToken and the last 4 characters.
 */

import * as fs from 'fs';
import * as path from 'path';

export const NETBIRD_CTL_ENV = 'NETBIRD_CTL_DIR';
export const DEFAULT_CTL_DIR = '/netbird-ctl';
export const DEFAULT_MANAGEMENT_URL = 'https://vpn.bas.co:443';
export const DEFAULT_HOSTNAME = 'soundsuite';
export const DEFAULT_HTTPS_DOMAIN = 'vpn.bas.co';
/** A status file older than this counts as "not connected" (container stopped). */
export const STATUS_STALE_MS = 60_000;

export interface HttpsConfig {
  enabled: boolean;
  domain: string;
  cloudflareToken: string;
  email: string;
}

/** Key order matters: docker/netbird-entrypoint.sh reads top-level fields with sed. */
export interface NetbirdConfig {
  setupKey: string;
  hostname: string;
  managementUrl: string;
  wireguardPort: number;
  /** netbird up --external-ip-map, e.g. "99.92.186.153". Empty = not set. */
  externalIpMap: string;
  enabled: boolean;
  https: HttpsConfig;
  updatedAt: string;
}

export interface CaddyStatus {
  running: boolean;
  certificate: { names: string[]; notAfter: string | null } | null;
  error: string | null;
  updatedAt: string | null;
  stale: boolean;
}

export interface HttpsView {
  enabled: boolean;
  domain: string;
  email: string;
  hasToken: boolean;
  tokenHint: string | null;
  address: string;
  status: CaddyStatus | null;
}

export interface NetbirdStatus {
  connected: boolean;
  fqdn: string | null;
  ip: string | null;
  peersConnected: number;
  peersTotal: number;
  updatedAt: string | null;
}

export interface NetbirdView {
  configured: boolean;
  enabled: boolean;
  hostname: string;
  managementUrl: string;
  hasKey: boolean;
  keyHint: string | null;
  wireguardPort: number;
  externalIpMap: string;
  status: NetbirdStatus | null;
  https: HttpsView;
}

export interface NetbirdOptions {
  env?: Record<string, string | undefined>;
  /** Folder used when NETBIRD_CTL_DIR does not exist (local dev, this Mac). */
  fallbackDir?: string;
  now?: number;
}

/** Bad input: the API route answers 400 with the message. */
export class NetbirdError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'NetbirdError';
  }
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const EMAIL_RE = /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/;

export function validHostname(h: unknown): h is string {
  return typeof h === 'string' && HOSTNAME_RE.test(h);
}

export function validManagementUrl(u: unknown): u is string {
  if (typeof u !== 'string' || !u.trim()) return false;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

export function validDomain(d: unknown): d is string {
  return typeof d === 'string' && DOMAIN_RE.test(d);
}

export function validWireguardPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 0 && p <= 65535;
}

const IPV4 = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(\\.(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}';
const IP_MAP_ENTRY_RE = new RegExp(`^${IPV4}(/(${IPV4}|[A-Za-z0-9_.-]{1,15}))?$`);

/** "" or a comma list of IP, IP/localIP or IP/interface (netbird up --external-ip-map). */
export function validExternalIpMap(m: unknown): m is string {
  return typeof m === 'string' && m.length <= 500 && (m === '' || m.split(',').every(e => IP_MAP_ENTRY_RE.test(e)));
}

export function keyHint(key: string): string | null {
  return key ? key.slice(-4) : null;
}

/** Map `netbird status --json` output to the small status the tab shows. */
export function parseNetbirdStatus(raw: unknown, mtimeMs: number | null, now: number): NetbirdStatus | null {
  if (!isObj(raw)) return null;
  const ip = typeof raw.netbirdIp === 'string' && raw.netbirdIp ? raw.netbirdIp.split('/')[0] : null;
  const fqdn = typeof raw.fqdn === 'string' && raw.fqdn ? raw.fqdn : null;
  const mgmtUp = isObj(raw.management) && raw.management.connected === true;
  const fresh = mtimeMs !== null && now - mtimeMs <= STATUS_STALE_MS;
  const peers = isObj(raw.peers) ? raw.peers : {};
  return {
    connected: mgmtUp && !!ip && fresh,
    fqdn,
    ip,
    peersConnected: Number(peers.connected) || 0,
    peersTotal: Number(peers.total) || 0,
    updatedAt: mtimeMs !== null ? new Date(mtimeMs).toISOString() : null,
  };
}

/** Map caddy-status.json (written by docker/caddy-entrypoint.sh) to the tab view. */
export function parseCaddyStatus(raw: unknown, mtimeMs: number | null, now: number): CaddyStatus | null {
  if (!isObj(raw)) return null;
  const stale = mtimeMs === null || now - mtimeMs > STATUS_STALE_MS;
  const c = isObj(raw.certificate) ? raw.certificate : null;
  return {
    running: raw.running === true && !stale,
    certificate: c
      ? {
          names: Array.isArray(c.names) ? c.names.filter((n: unknown): n is string => typeof n === 'string') : [],
          notAfter: typeof c.notAfter === 'string' && c.notAfter ? c.notAfter : null,
        }
      : null,
    error: typeof raw.error === 'string' && raw.error ? raw.error : null,
    updatedAt: mtimeMs !== null ? new Date(mtimeMs).toISOString() : null,
    stale,
  };
}

function defaultFallbackDir(env: Record<string, string | undefined>): string {
  const base = env.SOUND_SUITE_DATA_DIR?.trim() || path.join(process.cwd(), 'data');
  return path.join(base, 'netbird-ctl');
}

function ctlDir(opts: NetbirdOptions): { dir: string; configured: boolean } {
  const env = opts.env ?? process.env;
  const dir = env[NETBIRD_CTL_ENV]?.trim() || DEFAULT_CTL_DIR;
  try {
    if (fs.statSync(dir).isDirectory()) return { dir, configured: true };
  } catch { /* missing */ }
  return { dir: opts.fallbackDir ?? defaultFallbackDir(env), configured: false };
}

function readConfig(dir: string): NetbirdConfig {
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch { /* none yet */ }
  const r = isObj(raw) ? raw : {};
  const h = isObj(r.https) ? r.https : {};
  return {
    setupKey: typeof r.setupKey === 'string' ? r.setupKey : '',
    hostname: validHostname(r.hostname) ? r.hostname : DEFAULT_HOSTNAME,
    managementUrl: validManagementUrl(r.managementUrl) ? r.managementUrl : DEFAULT_MANAGEMENT_URL,
    wireguardPort: validWireguardPort(r.wireguardPort) ? r.wireguardPort : 0,
    externalIpMap: validExternalIpMap(r.externalIpMap) ? r.externalIpMap : '',
    enabled: r.enabled === true,
    https: {
      enabled: h.enabled === true,
      domain: validDomain(h.domain) ? h.domain : DEFAULT_HTTPS_DOMAIN,
      cloudflareToken: typeof h.cloudflareToken === 'string' ? h.cloudflareToken : '',
      email: typeof h.email === 'string' ? h.email : '',
    },
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
}

function writeConfig(dir: string, cfg: NetbirdConfig): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function readJsonWithMtime(file: string): { raw: unknown; mtimeMs: number } | null {
  try {
    const st = fs.statSync(file);
    return { raw: JSON.parse(fs.readFileSync(file, 'utf8')), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Settings + last status, secrets reduced to hints. */
export function getNetbirdView(opts: NetbirdOptions = {}): NetbirdView {
  const now = opts.now ?? Date.now();
  const { dir, configured } = ctlDir(opts);
  const cfg = readConfig(dir);
  const nb = configured ? readJsonWithMtime(path.join(dir, 'status.json')) : null;
  const cd = configured ? readJsonWithMtime(path.join(dir, 'caddy-status.json')) : null;
  return {
    configured,
    enabled: cfg.enabled,
    hostname: cfg.hostname,
    managementUrl: cfg.managementUrl,
    hasKey: !!cfg.setupKey,
    keyHint: keyHint(cfg.setupKey),
    wireguardPort: cfg.wireguardPort,
    externalIpMap: cfg.externalIpMap,
    status: nb ? parseNetbirdStatus(nb.raw, nb.mtimeMs, now) : null,
    https: {
      enabled: cfg.https.enabled,
      domain: cfg.https.domain,
      email: cfg.https.email,
      hasToken: !!cfg.https.cloudflareToken,
      tokenHint: keyHint(cfg.https.cloudflareToken),
      address: `https://${cfg.hostname}.${cfg.https.domain}`,
      status: cd ? parseCaddyStatus(cd.raw, cd.mtimeMs, now) : null,
    },
  };
}

/**
 * Partial update. Body:
 *   { setupKey?, hostname?, managementUrl?, wireguardPort?, externalIpMap?, enabled?,
 *     https?: { enabled?, domain?, cloudflareToken?, email? } }
 * Throws NetbirdError on bad input (nothing is written then).
 */
export function updateNetbirdSettings(body: unknown, opts: NetbirdOptions = {}): NetbirdView {
  const b = isObj(body) ? body : {};
  const { dir } = ctlDir(opts);
  const cfg = readConfig(dir);
  if (b.setupKey !== undefined) {
    if (typeof b.setupKey !== 'string' || !b.setupKey.trim()) throw new NetbirdError('Setup key must not be empty');
    if (/\s/.test(b.setupKey.trim())) throw new NetbirdError('Setup key must not contain spaces');
    cfg.setupKey = b.setupKey.trim();
  }
  if (b.hostname !== undefined) {
    const h = typeof b.hostname === 'string' ? b.hostname.trim().toLowerCase() : b.hostname;
    if (!validHostname(h)) {
      throw new NetbirdError('Hostname must be 1-63 characters: a-z, 0-9 and "-" (not at the start or end)');
    }
    cfg.hostname = h;
  }
  if (b.managementUrl !== undefined) {
    if (!validManagementUrl(b.managementUrl)) throw new NetbirdError('Management URL must be an https:// URL');
    cfg.managementUrl = b.managementUrl.trim();
  }
  if (b.wireguardPort !== undefined) {
    if (!validWireguardPort(b.wireguardPort)) {
      throw new NetbirdError('WireGuard port must be a whole number from 0 to 65535 (0 = NetBird picks)');
    }
    cfg.wireguardPort = b.wireguardPort;
  }
  if (b.externalIpMap !== undefined) {
    const m = typeof b.externalIpMap === 'string' ? b.externalIpMap.replace(/\s+/g, '') : b.externalIpMap;
    if (!validExternalIpMap(m)) {
      throw new NetbirdError('Advertised public IP must be empty or an IPv4 address like 99.92.186.153 (or IP/local-IP, comma separated)');
    }
    cfg.externalIpMap = m;
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw new NetbirdError('enabled must be true or false');
    cfg.enabled = b.enabled;
  }
  if (b.https !== undefined) {
    if (!isObj(b.https)) throw new NetbirdError('https must be an object');
    const h = b.https;
    if (h.enabled !== undefined) {
      if (typeof h.enabled !== 'boolean') throw new NetbirdError('https.enabled must be true or false');
      cfg.https.enabled = h.enabled;
    }
    if (h.domain !== undefined) {
      const dom = typeof h.domain === 'string' ? h.domain.trim().toLowerCase() : h.domain;
      if (!validDomain(dom)) throw new NetbirdError('Domain must be a DNS name like vpn.bas.co');
      cfg.https.domain = dom;
    }
    if (h.cloudflareToken !== undefined) {
      const t = typeof h.cloudflareToken === 'string' ? h.cloudflareToken.trim() : '';
      if (!TOKEN_RE.test(t)) {
        throw new NetbirdError('Cloudflare token must be 20-200 characters: letters, digits, "-" and "_"');
      }
      cfg.https.cloudflareToken = t;
    }
    if (h.email !== undefined) {
      const e = typeof h.email === 'string' ? h.email.trim() : null;
      if (e === null || (e !== '' && !EMAIL_RE.test(e))) throw new NetbirdError('Email must be empty or a valid address');
      cfg.https.email = e;
    }
  }
  if (cfg.enabled && !cfg.setupKey) throw new NetbirdError('Paste a setup key before you enable NetBird');
  cfg.updatedAt = new Date(opts.now ?? Date.now()).toISOString();
  writeConfig(dir, cfg);
  return getNetbirdView(opts);
}

/** Remove the setup key and turn NetBird off. */
export function removeNetbirdKey(opts: NetbirdOptions = {}): NetbirdView {
  const { dir } = ctlDir(opts);
  const cfg = readConfig(dir);
  cfg.setupKey = '';
  cfg.enabled = false;
  cfg.updatedAt = new Date(opts.now ?? Date.now()).toISOString();
  writeConfig(dir, cfg);
  return getNetbirdView(opts);
}

/** Remove the Cloudflare token (Caddy stops). */
export function removeHttpsToken(opts: NetbirdOptions = {}): NetbirdView {
  const { dir } = ctlDir(opts);
  const cfg = readConfig(dir);
  cfg.https.cloudflareToken = '';
  cfg.updatedAt = new Date(opts.now ?? Date.now()).toISOString();
  writeConfig(dir, cfg);
  return getNetbirdView(opts);
}
