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
import { emitBootEvent } from './boot-events';
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
  reconnectPending: false,
  // What the Activity Log was last told, so each change is logged once.
  told: {} as Record<string, string>,
  connectedSince: null as number | null,
  // The NetBird IP and the time NetBird was last seen running and connected.
  // After a restart with the same IP only sockets opened since then reconnect.
  lastIp: null as string | null,
  lastUpAt: null as number | null,
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
      const nb = r.netbird;
      // Keep the cached status fresh for netbirdSummary() (master heartbeat),
      // and tell the Activity Log about changes and errors.
      if (nb && nb.state !== 'off' && nb.state !== 'removed' && nb.state !== 'error') {
        void cachedStatus(nb.name).then((st) => {
          // Only a helper that was already running: after a (re)start,
          // reconnectMastersWhenUp must see the IP from before it.
          if (nb.state === 'running' && st?.connected && st.ip) {
            G.lastIp = st.ip;
            G.lastUpAt = Date.now();
          }
          return reportNetbird(r, st);
        }).catch(() => {});
      } else {
        void reportNetbird(r, null);
      }
      if (nb && (nb.state === 'created' || nb.state === 'started' || nb.state === 'restarted')) {
        void reconnectMastersWhenUp(nb.name);
      }
      return r;
    })
    .finally(() => { G.running = null; });
  return G.running;
}

/**
 * Log `text` to the Activity Log once per change of `key`. `same` decides what
 * counts as a change (default: the text), so peer counts do not log every minute.
 */
function tell(key: string, text: string | null, level: 'info' | 'warn' | 'error' = 'info', same: string | null = text): void {
  if (G.told[key] === (same ?? '')) return;
  G.told[key] = same ?? '';
  if (text) emitBootEvent(text, level === 'info' ? undefined : { level });
}

/**
 * NetBird and HTTPS lines for the Overview Activity Log: companion changes,
 * errors (from the reconcile or the container log), and the connection state.
 */
async function reportNetbird(r: ReconcileReport, st: NetbirdStatus | null): Promise<void> {
  try {
    if (!r.supported) { tell('supported', `NetBird not available: ${r.reason}`, 'warn'); return; }
    tell('supported', null);
    for (const c of [r.netbird, r.caddy]) {
      if (!c) continue;
      const what = c.name.endsWith('-caddy') ? 'HTTPS (Caddy)' : 'NetBird';
      if (c.state !== 'running') tell(`${c.name}:state`, `${what}: ${c.state}`);
      if (c.state === 'error' || c.error) tell(`${c.name}:error`, `${what} error: ${c.error}`, 'error');
      else tell(`${c.name}:error`, null);
    }
    const nb = r.netbird;
    if (!nb || nb.state === 'off' || nb.state === 'removed' || nb.state === 'error') { tell('conn', null); return; }
    if (st?.connected) {
      tell('conn', `NetBird connected as ${st.fqdn ?? r.fqdn} (${st.ip}), ${st.peersConnected}/${st.peersTotal} peers`, 'info', `up ${st.fqdn} ${st.ip}`);
      tell(`${nb.name}:log`, null);
      G.connectedSince ??= Date.now();
      // Right after connecting the peer list is still empty; warn only when it stays empty.
      if (st.peersTotal === 0 && Date.now() - G.connectedSince > 90_000) {
        tell('peers', 'NetBird gives this peer 0 peers: add it to a group with an access policy in the NetBird dashboard.', 'warn');
      } else if (st.peersTotal > 0) tell('peers', null);
    } else if (nb.state === 'running') {
      G.connectedSince = null;
      // Only read the container log while it is not connected: a healthy
      // NetBird logs transient errors too.
      tell('conn', `NetBird not connected (management ${st?.managementConnected ? 'connected' : 'not connected'})`, 'warn');
      const e = await dockerDeps.lastError(nb.name).catch(() => null);
      if (e) {
        nb.error = e;
        tell(`${nb.name}:log`, `NetBird error: ${e}`, 'error');
      }
    }
  } catch (e) {
    log.warn(`NetBird activity report failed: ${(e as Error).message}`);
  }
}

/**
 * Connect NetBird now: remove <self>-netbird and reconcile, which makes it
 * again with a fresh setup-key hand-off. The peer identity (named volume) is
 * kept. Master sockets reconnect when it is up (reconnectMastersWhenUp).
 */
export async function connectNetbirdNow(): Promise<void> {
  const me = await dockerDeps.self();
  if (!me.ok) throw new Error(me.detail);
  if (!readSettings(netbirdDir()).enabled) throw new Error('NetBird is off. Turn it on first.');
  emitBootEvent('NetBird: connect requested');
  for (const k of Object.keys(G.told)) delete G.told[k];
  G.connectedSince = null;
  await dockerDeps.remove(`${me.name}-netbird`);
  await applyNow();
}

/**
 * After NetBird (re)starts, wait until its tunnel is up, then reconnect master
 * sockets. Sockets opened while the tunnel was down keep the Docker bridge
 * address and cannot reach a master on the NetBird network; they stay OPEN and
 * silent.
 *
 * Every socket reconnects when the NetBird IP is new or unknown (first start in
 * this process, an IP change, or no status after the wait). When the IP is the
 * same, only sockets opened since NetBird was last seen up reconnect: the older
 * ones already use that IP. Dropping all of them on every helper start made
 * every master register again and push its config again.
 */
async function reconnectMastersWhenUp(name: string): Promise<void> {
  if (G.reconnectPending) return;
  G.reconnectPending = true;
  const prevIp = G.lastIp;
  const upAt = G.lastUpAt;
  try {
    let ip: string | null = null;
    for (let i = 0; i < 24; i++) {
      await new Promise((res) => setTimeout(res, 5_000));
      const st = await readNetbirdStatus(dockerDeps, name);
      if (st?.connected) {
        // Tell the Activity Log now, not at the next 60 s reconcile.
        G.status = { at: Date.now(), value: st };
        if (G.last) void reportNetbird(G.last, st);
        ip = st.ip;
        break;
      }
    }
    const { reconnectAllMasters, reconnectMastersWhere } = await import('./ws-client');
    if (ip && ip === prevIp && upAt !== null) {
      G.lastUpAt = Date.now();
      reconnectMastersWhere(
        (s) => s.openedAt === null || s.openedAt > upAt,
        'NetBird restarted, so sockets opened while it was down move to the NetBird address',
      );
      return;
    }
    if (ip) { G.lastIp = ip; G.lastUpAt = Date.now(); }
    reconnectAllMasters('NetBird (re)started, so sockets move to the NetBird address');
  } catch (e) {
    log.warn(`reconnect after NetBird start failed: ${(e as Error).message}`);
  } finally {
    G.reconnectPending = false;
  }
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

/**
 * Small NetBird summary for the master heartbeat (no Docker calls: settings,
 * the last reconcile and the cached status). Null when NetBird is off.
 */
export function netbirdSummary(): {
  fqdn: string; ip: string | null; connected: boolean | null; httpsUrl: string | null; httpsState: string | null;
} | null {
  try {
    const s = readSettings(netbirdDir());
    if (!s.enabled) return null;
    const fqdn = G.status?.value?.fqdn || fqdnOf(effectiveHostname(s, getDockerHostName()), s.https.domain);
    const r = G.last;
    const https = s.https.enabled && !!s.https.domain;
    return {
      fqdn,
      ip: G.status?.value?.ip ?? null,
      connected: G.status ? !!G.status.value?.connected : null,
      httpsUrl: https ? `https://${fqdn}` : null,
      httpsState: https ? (r?.caddy?.state ?? null) : null,
    };
  } catch {
    return null;
  }
}
