/**
 * NetBird and Caddy companion containers for this sidecar.
 *
 * Self-update only replaces code inside the sidecar container; it cannot add
 * caps, devices or ports. So the sidecar creates two more containers through the
 * Docker socket it already has, both with NetworkMode container:<sidecar-id>:
 *
 *   <self>-netbird  netbirdio/netbird. The image's own entrypoint runs
 *                   `netbird service run` + `netbird up`, configured by env
 *                   (NB_SETUP_KEY_FILE, NB_MANAGEMENT_URL, NB_HOSTNAME, ...).
 *                   NB_SETUP_KEY_FILE points at the plain-text hand-off copy
 *                   (run/setup-key). The sidecar writes it before each start and
 *                   deletes it 2 minutes after NetBird runs; NetBird keeps its
 *                   login in its state volume, so later restarts need no key.
 *                   The sidecar gets wt0, a 100.x IP and NetBird DNS.
 *   <self>-caddy    caddy:2. Adds the caddy-dns/cloudflare module on first start,
 *                   then serves https://<hostname>.<domain> → 127.0.0.1:<port>.
 *                   Its start script reads run/cf-token into memory and deletes it.
 *
 * Both use restart policy "no": a container that Docker restarts by itself would
 * find no hand-off file. reconcile() (every 60 s) starts them again instead.
 *
 * Nothing is published on the host: no UDP port, so the Windows reserved-range
 * failure (Windows/Hyper-V reserved UDP ranges) cannot hit a sidecar.
 *
 * reconcile() runs at boot, every 60 s and after each settings change:
 *   - off            → remove the companion;
 *   - spec changed or owned by an older sidecar container → remove + create;
 *   - stopped        → start;
 *   - started before the sidecar's current start → restart (the sidecar's
 *     network namespace is new after its own restart, and a joined container
 *     keeps the old, dead one until it restarts).
 *
 * Docker access is injected (CompanionDeps) so tests run with a fake.
 */
import crypto from 'crypto';
import path from 'path';
import tls from 'tls';
import {
  CF_TOKEN_FILE, RUN_DIR, SETUP_KEY_FILE, buildCaddyfile, handoffAgeMs, removeHandoff, writeHandoff, defaultHostname, parseNetbirdStatus,
  readSecret, readSettings, secretFingerprint, writeCaddyfile,
  type NetbirdSettings, type NetbirdStatus,
} from './netbird';

export const NETBIRD_IMAGE = process.env.SIDECAR_NETBIRD_IMAGE || 'netbirdio/netbird:latest';
export const CADDY_IMAGE = process.env.SIDECAR_CADDY_IMAGE || 'caddy:2';
export const RECONCILE_INTERVAL_MS = 60_000;

export type CompanionState =
  | 'off' | 'removed' | 'created' | 'started' | 'restarted' | 'running' | 'waiting' | 'error';

export interface CompanionResult { name: string; state: CompanionState; error: string | null }

export interface ReconcileReport {
  supported: boolean;
  reason: string | null;
  hostname: string;
  fqdn: string;
  netbird: CompanionResult | null;
  caddy: CompanionResult | null;
  at: string;
}

interface Inspect {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> };
  State?: { Running?: boolean; StartedAt?: string };
  Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>;
}

export interface CompanionDeps {
  inspect(nameOrId: string): Promise<Inspect | null>;
  create(name: string, body: Record<string, unknown>): Promise<void>;
  start(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  pull(image: string): Promise<boolean>;
  exec(name: string, cmd: string[]): Promise<{ exitCode: number; output: string }>;
  self(): Promise<{ ok: true; id: string; name: string } | { ok: false; detail: string }>;
  dockerHostName(): string | null;
}

export const LABEL_ROLE = 'sidecar.companion';
export const LABEL_OWNER = 'sidecar.owner';
export const LABEL_HASH = 'sidecar.spec';

const hash = (v: unknown): string => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** The Binds entry that gives a companion the sidecar's own folder `dir` at the same path. */
export function configBind(self: Inspect, dir: string): string | null {
  const m = (self.Mounts || [])
    .filter((x) => x.Destination && (dir === x.Destination || dir.startsWith(x.Destination.replace(/\/$/, '') + '/')))
    .sort((a, b) => (b.Destination!.length - a.Destination!.length))[0];
  if (!m) return null;
  const src = m.Type === 'volume' ? m.Name : m.Source;
  return src ? `${src}:${m.Destination}` : null;
}

export const fqdnOf = (hostname: string, domain: string): string => (domain ? `${hostname}.${domain}` : hostname);

export function effectiveHostname(s: NetbirdSettings, dockerHostName: string | null): string {
  return s.hostname || defaultHostname(dockerHostName);
}

export function netbirdSpec(
  selfId: string, selfName: string, bind: string, dir: string, s: NetbirdSettings, hostname: string, keyFp: string,
): { body: Record<string, unknown>; hash: string } {
  const env = [
    `NB_SETUP_KEY_FILE=${path.posix.join(dir, RUN_DIR, SETUP_KEY_FILE)}`,
    `NB_MANAGEMENT_URL=${s.managementUrl}`,
    `NB_HOSTNAME=${hostname}`,
    'NB_LOG_FILE=console',
  ];
  if (s.wireguardPort > 0) env.push(`NB_WIREGUARD_PORT=${s.wireguardPort}`);
  if (s.externalIpMap) env.push(`NB_EXTERNAL_IP_MAP=${s.externalIpMap}`);
  const host = {
    NetworkMode: `container:${selfId}`,
    CapAdd: ['NET_ADMIN', 'SYS_ADMIN', 'SYS_RESOURCE'],
    Devices: [{ PathOnHost: '/dev/net/tun', PathInContainer: '/dev/net/tun', CgroupPermissions: 'rwm' }],
    Binds: [bind, `${selfName}-netbird-state:/var/lib/netbird`],
    RestartPolicy: { Name: 'no' },
  };
  const h = hash({ image: NETBIRD_IMAGE, env, host: { ...host, NetworkMode: 'self' }, keyFp });
  return {
    hash: h,
    body: {
      Image: NETBIRD_IMAGE,
      Env: env,
      Labels: { [LABEL_ROLE]: 'netbird', [LABEL_OWNER]: selfId, [LABEL_HASH]: h },
      HostConfig: host,
    },
  };
}

export function caddySpec(
  selfId: string, selfName: string, bind: string, dir: string, caddyfile: string, tokenFp: string,
): { body: Record<string, unknown>; hash: string } {
  const tokenPath = path.posix.join(dir, RUN_DIR, CF_TOKEN_FILE);
  const cfg = path.posix.join(dir, 'Caddyfile');
  const boot =
    `T="$(cat '${tokenPath}' 2>/dev/null)"; rm -f '${tokenPath}'; ` +
    '[ -n "$T" ] || { echo "no Cloudflare token hand-off; the sidecar starts me again" >&2; exit 1; }; ' +
    'caddy list-modules 2>/dev/null | grep -q dns.providers.cloudflare || ' +
    'caddy add-package github.com/caddy-dns/cloudflare || exit 1; ' +
    `CF_API_TOKEN="$T" exec caddy run --config '${cfg}' --adapter caddyfile`;
  const host = {
    NetworkMode: `container:${selfId}`,
    Binds: [bind, `${selfName}-caddy-data:/data`],
    RestartPolicy: { Name: 'no' },
  };
  const h = hash({ image: CADDY_IMAGE, boot, caddyfile, host: { ...host, NetworkMode: 'self' }, tokenFp });
  return {
    hash: h,
    body: {
      Image: CADDY_IMAGE,
      Entrypoint: ['/bin/sh', '-c', boot],
      Cmd: [],
      Labels: { [LABEL_ROLE]: 'caddy', [LABEL_OWNER]: selfId, [LABEL_HASH]: h },
      HostConfig: host,
    },
  };
}

/** Bring one companion to the wanted state. Never throws. */
export async function ensureCompanion(
  deps: CompanionDeps, name: string, want: { body: Record<string, unknown>; hash: string } | null,
  selfId: string, selfStartedAt: number, prepare: () => void = () => {},
): Promise<CompanionResult> {
  try {
    const cur = await deps.inspect(name);
    if (!want) {
      if (cur) { await deps.remove(name); return { name, state: 'removed', error: null }; }
      return { name, state: 'off', error: null };
    }
    const labels = cur?.Config?.Labels || {};
    const stale = !!cur && (labels[LABEL_HASH] !== want.hash || labels[LABEL_OWNER] !== selfId);
    if (stale) await deps.remove(name);
    if (!cur || stale) {
      const image = String(want.body.Image);
      if (!(await deps.pull(image))) return { name, state: 'error', error: `Could not pull ${image}.` };
      await deps.create(name, want.body);
      prepare();
      await deps.start(name);
      return { name, state: 'created', error: null };
    }
    if (!cur.State?.Running) { prepare(); await deps.start(name); return { name, state: 'started', error: null }; }
    const started = Date.parse(cur.State.StartedAt || '');
    if (Number.isFinite(started) && Number.isFinite(selfStartedAt) && started < selfStartedAt) {
      prepare();
      await deps.restart(name);
      return { name, state: 'restarted', error: null };
    }
    return { name, state: 'running', error: null };
  } catch (err) {
    return { name, state: 'error', error: explainDockerError((err as Error).message) };
  }
}

export function explainDockerError(msg: string): string {
  if (/\/dev\/net\/tun/i.test(msg)) return `This host has no /dev/net/tun, so NetBird cannot run in Docker here. (${msg})`;
  if (/NET_ADMIN|operation not permitted/i.test(msg)) return `Docker refused NET_ADMIN (rootless Docker?). (${msg})`;
  return msg;
}

export async function reconcile(deps: CompanionDeps, dir: string, upstreamPort: number): Promise<ReconcileReport> {
  const s = readSettings(dir);
  const hostname = effectiveHostname(s, deps.dockerHostName());
  const fqdn = fqdnOf(hostname, s.https.domain);
  const at = new Date().toISOString();
  const base = { hostname, fqdn, at };

  const me = await deps.self();
  if (!me.ok) {
    return { ...base, supported: false, reason: `NetBird needs the sidecar to run in Docker. ${me.detail}`, netbird: null, caddy: null };
  }
  const self = await deps.inspect(me.id);
  if (!self) return { ...base, supported: false, reason: 'Docker cannot inspect this sidecar container.', netbird: null, caddy: null };
  const bind = configBind(self, dir);
  if (!bind) {
    return {
      ...base, supported: false,
      reason: `${dir} is not on a Docker volume, so the companions cannot read it. Run the sidecar with -v <volume>:/app/config.`,
      netbird: null, caddy: null,
    };
  }
  const selfStartedAt = Date.parse(self.State?.StartedAt || '');

  const nbOn = s.enabled && !!readSecret(dir, SETUP_KEY_FILE);
  const nbWant = nbOn
    ? netbirdSpec(me.id, me.name, bind, dir, s, hostname, secretFingerprint(dir, SETUP_KEY_FILE))
    : null;
  const netbird = await ensureCompanion(deps, `${me.name}-netbird`, nbWant, me.id, selfStartedAt,
    () => { writeHandoff(dir, SETUP_KEY_FILE); });
  clearHandoff(dir, SETUP_KEY_FILE, netbird.state);

  const httpsOn = nbOn && s.https.enabled && !!s.https.domain && !!readSecret(dir, CF_TOKEN_FILE);
  let caddyWant: ReturnType<typeof caddySpec> | null = null;
  if (httpsOn) {
    const caddyfile = buildCaddyfile(fqdn, upstreamPort, s.https.email);
    writeCaddyfile(dir, caddyfile);
    caddyWant = caddySpec(me.id, me.name, bind, dir, caddyfile, secretFingerprint(dir, CF_TOKEN_FILE));
  }
  const caddy = await ensureCompanion(deps, `${me.name}-caddy`, caddyWant, me.id, selfStartedAt,
    () => { writeHandoff(dir, CF_TOKEN_FILE); });
  clearHandoff(dir, CF_TOKEN_FILE, caddy.state);

  return { ...base, supported: true, reason: null, netbird, caddy };
}

export const HANDOFF_TTL_MS = 120_000;

/**
 * Delete a hand-off copy 2 minutes after it was written (the companion read it at
 * start), or at once when the companion is off. A failed start writes it again.
 */
export function clearHandoff(dir: string, file: string, state: CompanionState, now = Date.now()): void {
  const age = handoffAgeMs(dir, file, now);
  if (age === null) return;
  if (state === 'off' || state === 'removed' || age > HANDOFF_TTL_MS) removeHandoff(dir, file);
}

/** `netbird status --json` inside the companion. Null when it is not up. */
export async function readNetbirdStatus(deps: CompanionDeps, name: string): Promise<NetbirdStatus | null> {
  try {
    const { exitCode, output } = await deps.exec(name, ['netbird', 'status', '--json']);
    if (exitCode !== 0) return null;
    const i = output.indexOf('{');
    return i < 0 ? null : parseNetbirdStatus(JSON.parse(output.slice(i)));
  } catch {
    return null;
  }
}

export interface CertInfo { names: string[]; notAfter: string | null; issuer: string | null; trusted: boolean }

/** TLS handshake to 127.0.0.1:443 (same network namespace as Caddy) for <fqdn>. */
export function probeCertificate(fqdn: string, timeoutMs = 4000): Promise<CertInfo | null> {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port: 443, servername: fqdn, rejectUnauthorized: false });
    const done = (v: CertInfo | null) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.on('error', () => done(null));
    sock.on('secureConnect', () => {
      const c = sock.getPeerCertificate();
      if (!c || !c.valid_to) return done(null);
      const names = (c.subjectaltname || '').split(',').map((x) => x.trim().replace(/^DNS:/, '')).filter(Boolean);
      done({
        names,
        notAfter: new Date(c.valid_to).toISOString(),
        issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null,
        trusted: sock.authorized,
      });
    });
  });
}
