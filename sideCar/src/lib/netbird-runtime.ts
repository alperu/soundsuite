/**
 * Runtime side of the NetBird feature: real Docker calls, the reconcile loop
 * and the view the /netbird page shows. Logic lives in netbird.ts and
 * netbird-companion.ts.
 */
import path from 'path';
import { getConfigPath } from './config';
import {
  dockerRequest, dockerRequestWithBody, execInContainer, getDockerHostName, isDockerAvailable,
  buildImageFromDockerfile, pullImage, resolveSelfContainer,
} from './docker';
import { createLogger } from './logger';
import { processGlobal } from './process-global';
import {
  CF_TOKEN_FILE, SETUP_KEY_FILE, keyHint, readSecret, readSettings,
  type NetbirdStatus,
} from './netbird';
import {
  CADDY_BUILT_IMAGE, RECONCILE_INTERVAL_MS, effectiveHostname, lastLoggedError, fqdnOf, probeCertificate, readNetbirdStatus, reconcile,
  type CertInfo, type CompanionDeps, type ReconcileReport,
} from './netbird-companion';

const log = createLogger('netbird');

// The port this server listens on: PORT, else Next.js standalone's default 3000
// (the shipped Dockerfile.run sets PORT=8098).
export const UPSTREAM_PORT = Number(process.env.PORT) || 3000;

export function netbirdDir(): string {
  return process.env.SIDECAR_NETBIRD_DIR || path.join(path.dirname(getConfigPath()), 'netbird');
}

async function ok(p: Promise<{ status: number; body: string }>, what: string, okCodes: number[]): Promise<void> {
  const r = await p;
  if (!okCodes.includes(r.status)) {
    let msg = r.body;
    try { msg = JSON.parse(r.body).message || msg; } catch { /* plain text */ }
    throw new Error(`${what}: ${msg}`);
  }
}

const enc = encodeURIComponent;

export const dockerDeps: CompanionDeps = {
  async inspect(n) {
    const r = await dockerRequest('GET', `/containers/${enc(n)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`inspect ${n}: HTTP ${r.status}`);
    return JSON.parse(r.body);
  },
  create: (n, body) => ok(dockerRequestWithBody('POST', `/containers/create?name=${enc(n)}`, body), `create ${n}`, [201]),
  start: (n) => ok(dockerRequest('POST', `/containers/${enc(n)}/start`), `start ${n}`, [204, 304]),
  restart: (n) => ok(dockerRequest('POST', `/containers/${enc(n)}/restart?t=5`), `restart ${n}`, [204]),
  // v=false: keep the named volumes (NetBird peer identity, certificates).
  remove: (n) => ok(dockerRequest('DELETE', `/containers/${enc(n)}?force=true&v=false`), `remove ${n}`, [204, 404]),
  // The host's own platform, never the amd64 default: on Apple Silicon an
  // amd64 NetBird runs under emulation and cannot set up WireGuard
  // ("wgctl: socket: protocol not supported"). Force re-pull so a cached
  // amd64 image is replaced; the Caddy image is built here, not pulled.
  pull: (image) => pullImage(image, { platform: null, force: image !== CADDY_BUILT_IMAGE }),
  exec: (n, cmd) => execInContainer(n, cmd, { timeoutMs: 10_000 }),
  async buildImage(tag, dockerfile) {
    const b = G.builds[tag];
    if (b?.running) return 'building';
    const r = await dockerRequest('GET', `/images/${enc(tag)}/json`);
    if (r.status === 200) return 'ready';
    // After a failed build, wait 10 minutes before the next try.
    if (b?.error && Date.now() - b.at < 10 * 60_000) return b.error;
    const entry = { running: true, error: null as string | null, at: Date.now() };
    G.builds[tag] = entry;
    log.info(`building ${tag}`);
    buildImageFromDockerfile(tag, dockerfile)
      .then(() => { log.info(`built ${tag}`); runReconcile().catch(() => {}); })
      .catch((e: Error) => { entry.error = e.message; log.warn(`build ${tag} failed: ${e.message}`); })
      .finally(() => { entry.running = false; entry.at = Date.now(); });
    return 'building';
  },
  async lastError(n) {
    const c = await dockerDeps.inspect(n);
    const since = Math.floor(Date.parse(c?.State?.StartedAt || '') / 1000);
    if (!c || !Number.isFinite(since)) return null;
    const r = await dockerRequest('GET', `/containers/${enc(n)}/logs?stdout=1&stderr=1&tail=200&since=${since - 1}`);
    if (r.status !== 200) return null;
    return lastLoggedError(r.body);
  },
  async self() {
    if (!isDockerAvailable()) return { ok: false, detail: 'The Docker API is not reachable.' };
    const r = await resolveSelfContainer();
    return r.ok ? { ok: true, id: r.id, name: r.name } : { ok: false, detail: r.detail };
  },
  dockerHostName: () => getDockerHostName(),
};

const G = processGlobal('netbird', () => ({
  timer: null as ReturnType<typeof setInterval> | null,
  running: null as Promise<ReconcileReport> | null,
  last: null as ReconcileReport | null,
  status: null as { at: number; value: NetbirdStatus | null } | null,
  builds: {} as Record<string, { running: boolean; error: string | null; at: number }>,
}));

/** Run one reconcile; concurrent callers share the run in flight. */
export function runReconcile(): Promise<ReconcileReport> {
  if (G.running) return G.running;
  G.running = reconcile(dockerDeps, netbirdDir(), UPSTREAM_PORT)
    .then((r) => {
      const prev = G.last;
      G.last = r;
      for (const c of [r.netbird, r.caddy]) {
        if (c && c.state !== 'running' && c.state !== 'off') {
          (c.state === 'error' ? log.warn : log.info)(`${c.name}: ${c.state}${c.error ? ` — ${c.error}` : ''}`);
        }
      }
      if (!r.supported && prev?.reason !== r.reason) log.info(`NetBird not available: ${r.reason}`);
      return r;
    })
    .finally(() => { G.running = null; });
  return G.running;
}

export function startNetbirdLoop(): void {
  if (G.timer) return;
  const tick = () => { runReconcile().catch((e) => log.warn(`reconcile failed: ${(e as Error).message}`)); };
  setTimeout(tick, 5_000);
  G.timer = setInterval(tick, RECONCILE_INTERVAL_MS);
  G.timer.unref?.();
}

async function cachedStatus(name: string): Promise<NetbirdStatus | null> {
  const now = Date.now();
  if (G.status && now - G.status.at < 10_000) return G.status.value;
  const value = await readNetbirdStatus(dockerDeps, name);
  G.status = { at: now, value };
  return value;
}

export interface NetbirdView {
  supported: boolean | null;
  reason: string | null;
  enabled: boolean;
  hostname: string;
  hostnameIsDefault: boolean;
  fqdn: string;
  managementUrl: string;
  wireguardPort: number;
  externalIpMap: string;
  hasSetupKey: boolean;
  setupKeyHint: string | null;
  https: {
    enabled: boolean; domain: string; email: string; hasToken: boolean; tokenHint: string | null;
    url: string; certificate: CertInfo | null;
  };
  companions: ReconcileReport['netbird'][];
  lastReconcileAt: string | null;
  status: NetbirdStatus | null;
  updatedAt: string | null;
}

export async function getNetbirdView(): Promise<NetbirdView> {
  const dir = netbirdDir();
  const s = readSettings(dir);
  const hostname = effectiveHostname(s, getDockerHostName());
  const fqdn = fqdnOf(hostname, s.https.domain);
  const key = readSecret(dir, SETUP_KEY_FILE);
  const token = readSecret(dir, CF_TOKEN_FILE);
  const r = G.last;
  const nbName = r?.netbird?.name;
  const status = s.enabled && nbName && r?.netbird?.state !== 'error' ? await cachedStatus(nbName) : null;
  const certificate = s.enabled && s.https.enabled && r?.caddy && r.caddy.state !== 'error'
    ? await probeCertificate(fqdn) : null;
  return {
    supported: r ? r.supported : null,
    reason: r?.reason ?? null,
    enabled: s.enabled,
    hostname,
    hostnameIsDefault: !s.hostname,
    fqdn,
    managementUrl: s.managementUrl,
    wireguardPort: s.wireguardPort,
    externalIpMap: s.externalIpMap,
    hasSetupKey: !!key,
    setupKeyHint: keyHint(key),
    https: {
      enabled: s.https.enabled, domain: s.https.domain, email: s.https.email,
      hasToken: !!token, tokenHint: keyHint(token), url: `https://${fqdn}`, certificate,
    },
    companions: r ? [r.netbird, r.caddy].filter(Boolean) : [],
    lastReconcileAt: r?.at ?? null,
    status,
    updatedAt: s.updatedAt,
  };
}

/** After a settings change: apply now and drop the cached status. */
export async function applyNow(): Promise<void> {
  G.status = null;
  await runReconcile();
}

/**
 * Start the certificate request now: remove <self>-caddy and reconcile, which
 * creates it again with a fresh token hand-off. Caddy otherwise waits minutes
 * between retries. The certificate store (named volume) is kept.
 */
export async function retryHttpsNow(): Promise<void> {
  const me = await dockerDeps.self();
  if (!me.ok) throw new Error(me.detail);
  await dockerDeps.remove(`${me.name}-caddy`);
  await applyNow();
}
