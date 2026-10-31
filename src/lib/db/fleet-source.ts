/**
 * Sidecar master follow mode (task 57 / 3.6, SPEC §8, decision Q5).
 *
 * `fleet.source` (Config DB; env `SS_FLEET_SOURCE` + `SM_URL` + `SM_TOKEN` override it for tests):
 *   local  — Sound Suite is the master: its own HostRoleAssignment table, config pushes,
 *            min-online loop, provisioning. Everything as before this task.
 *   follow — sidecarmaster is the master. Sound Suite reads the desired fleet from
 *            GET {master}/api/v1/apps/soundsuite/fleet, keeps the last good copy in memory
 *            (30 s) and in system.db (FleetSnapshot), and listens to the master's SSE feed
 *            (src/lib/gpu/fleet-follower.ts). It does NOT push config, start or stop
 *            containers, provision hosts, re-push OpenRouter keys, reassert master URLs or
 *            run the min-online loop. Its relay on 3002 stays on: the sidecars still report
 *            here, so routing (fleet-router resolveEndpoint) keeps its live state.
 *
 * Fallback order for a read: in-memory copy → fetch → stale in-memory copy → system.db
 * snapshot → null (callers then use the local table).
 *
 * Secrets: the app token is read from Config `fleet.master.token` and is never returned,
 * logged or written to an audit row. Views carry only `hasToken` and the last 4 characters.
 */
import type { HostRoleAssignment } from '@prisma/client';
import { createLogger } from '@/lib/logger';

const logger = createLogger('FleetSource');

export const APP_ID = 'soundsuite';
export const FLEET_SOURCE_KEYS = {
  source: 'fleet.source',
  masterUrl: 'fleet.master.url',
  linkUrl: 'fleet.master.linkUrl',
  token: 'fleet.master.token',
} as const;

const SETTINGS_TTL_MS = 10_000;
export const FLEET_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const SKIP_LOG_EVERY_MS = 5 * 60_000;

export type FleetSource = 'local' | 'follow';
export type SseState = 'off' | 'connecting' | 'connected' | 'disconnected';

export interface FleetSourceSettings {
  source: FleetSource;
  masterUrl: string;
  /** Address used for the "open in sidecarmaster" links; defaults to masterUrl. */
  linkUrl: string;
  token: string;
}

/** What the admin API returns. No token, only its last 4 characters. */
export interface FleetSourceView {
  source: FleetSource;
  following: boolean;
  masterUrl: string;
  linkUrl: string;
  hasToken: boolean;
  tokenHint: string | null;
}

/** One role of one host, as sidecarmaster's /api/v1/apps/:id/fleet returns it. */
export interface SmRole {
  mode: string;
  role?: string;
  enabled: boolean;
  minOnline: number;
  idleTimeoutMin: number;
  model?: string | null;
  modelOverride: string | null;
  runtime: string;
  port?: number | null;
  running?: boolean;
}

export interface SmGpu { index: number; name: string; memoryTotalMb: number; memoryUsedMb: number; utilPct?: number | null }
export interface SmContainer { name: string; state: string; role?: string | null; image?: string | null; port?: number | null; model?: string | null }

export interface SmHost {
  hostId: string;
  name: string;
  hostname?: string | null;
  agentUrl: string | null;
  /** Every sidecar URL this host was seen under. Sound Suite keys hosts by URL. */
  aliases?: string[];
  netbirdIp?: string | null;
  os?: string | null;
  online?: boolean;
  lastHeartbeatAt?: string | null;
  masterUrl?: string | null;
  wsPortOverride?: number | null;
  sidecarVersion?: string | null;
  activeRequests?: number | null;
  gpus?: SmGpu[];
  containers?: SmContainer[];
  roles: SmRole[];
}

export interface SmFleet {
  appId: string;
  generatedAt?: string;
  modes?: unknown[];
  hosts: SmHost[];
}

export interface FollowStatus {
  source: FleetSource;
  following: boolean;
  masterUrl: string;
  linkUrl: string;
  hasToken: boolean;
  /** The last fetch from the master worked within the last 90 s. */
  connected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  hostsSeen: number;
  sse: SseState;
  /** When the copy in memory came from system.db instead of the master. */
  fromSnapshot: boolean;
  snapshotAt: string | null;
  fleetAt: string | null;
}

export interface FleetSourcePatch {
  source?: FleetSource;
  masterUrl?: string;
  linkUrl?: string;
  token?: string;
  clearToken?: boolean;
}

export class FleetSourceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Thrown by a local write or a sidecar control call while following sidecarmaster. */
export class FollowModeError extends Error {
  code = 'FOLLOWING_SIDECARMASTER';
  constructor(what: string, public masterUrl: string) {
    super(`${what} is managed by sidecarmaster${masterUrl ? ` at ${masterUrl}` : ''}. Edit it there.`);
  }
}

interface State {
  settings: FleetSourceSettings | null;
  settingsAt: number;
  fleet: SmFleet | null;
  fleetAt: number;
  fromSnapshot: boolean;
  stale: boolean;
  rows: HostRoleAssignment[] | null;
  rowsFor: SmFleet | null;
  inflight: Promise<SmFleet | null> | null;
  lastOkAt: number;
  lastError: string | null;
  sse: SseState;
  snapshotAt: string | null;
  lastWritten: string | null;
  skipLogAt: Record<string, number>;
}

// globalThis: the worker-init context and the API routes are different module instances in
// Next.js; one shared state keeps the copy and the status the same for both.
function st(): State {
  const g = globalThis as unknown as { __ssFleetSource?: State };
  if (!g.__ssFleetSource) {
    g.__ssFleetSource = {
      settings: null, settingsAt: 0, fleet: null, fleetAt: 0, fromSnapshot: false, stale: false,
      rows: null, rowsFor: null, inflight: null, lastOkAt: 0, lastError: null, sse: 'off',
      snapshotAt: null, lastWritten: null, skipLogAt: {},
    };
  }
  return g.__ssFleetSource;
}

async function db() {
  const { prisma } = await import('./prisma');
  return prisma;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function validMasterUrl(u: unknown): u is string {
  return typeof u === 'string' && /^https?:\/\/\S+$/.test(u.trim());
}

export function normalizeMasterUrl(u: string | null | undefined): string {
  return (u ?? '').trim().replace(/\/+$/, '');
}

export function tokenHint(token: string | null | undefined): string | null {
  return token ? token.slice(-4) : null;
}

function envSettings(): FleetSourceSettings | null {
  const src = process.env.SS_FLEET_SOURCE;
  if (!src) return null;
  return {
    source: src === 'follow' ? 'follow' : 'local',
    masterUrl: normalizeMasterUrl(process.env.SM_URL),
    linkUrl: normalizeMasterUrl(process.env.SM_LINK_URL),
    token: (process.env.SM_TOKEN ?? '').trim(),
  };
}

/** Settings from the Config table (cached 10 s). On any DB error the answer is `local`. */
export async function getFleetSourceSettings(opts: { fresh?: boolean } = {}): Promise<FleetSourceSettings> {
  const env = envSettings();
  if (env) return env;
  const s = st();
  const now = Date.now();
  if (!opts.fresh && s.settings && now - s.settingsAt < SETTINGS_TTL_MS) return s.settings;
  try {
    const prisma = await db();
    const rows = await prisma.config.findMany({ where: { key: { in: Object.values(FLEET_SOURCE_KEYS) } } });
    const m = new Map(rows.map((r) => [r.key, r.value]));
    s.settings = {
      source: m.get(FLEET_SOURCE_KEYS.source) === 'follow' ? 'follow' : 'local',
      masterUrl: normalizeMasterUrl(m.get(FLEET_SOURCE_KEYS.masterUrl)),
      linkUrl: normalizeMasterUrl(m.get(FLEET_SOURCE_KEYS.linkUrl)),
      token: (m.get(FLEET_SOURCE_KEYS.token) ?? '').trim(),
    };
  } catch (err) {
    if (!s.settings) s.settings = { source: 'local', masterUrl: '', linkUrl: '', token: '' };
    logger.warn('Could not read fleet.source settings; staying local', { error: errMsg(err) });
  }
  s.settingsAt = now;
  return s.settings;
}

/** Synchronous view of the last loaded source. `local` until the settings were read once. */
export function fleetSource(): FleetSource {
  return envSettings()?.source ?? st().settings?.source ?? 'local';
}

export async function isFollowMode(): Promise<boolean> {
  return (await getFleetSourceSettings()).source === 'follow';
}

function toView(s: FleetSourceSettings): FleetSourceView {
  return {
    source: s.source, following: s.source === 'follow', masterUrl: s.masterUrl, linkUrl: s.linkUrl,
    hasToken: !!s.token, tokenHint: tokenHint(s.token),
  };
}

export async function getFleetSourceView(): Promise<FleetSourceView> {
  return toView(await getFleetSourceSettings());
}

export async function getFollowStatus(): Promise<FollowStatus> {
  const settings = await getFleetSourceSettings();
  const s = st();
  const following = settings.source === 'follow';
  return {
    source: settings.source,
    following,
    masterUrl: settings.masterUrl,
    linkUrl: settings.linkUrl || settings.masterUrl,
    hasToken: !!settings.token,
    connected: following && s.lastOkAt > 0 && Date.now() - s.lastOkAt < 3 * FLEET_TTL_MS,
    lastSyncAt: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : null,
    lastError: following ? s.lastError : null,
    hostsSeen: following ? (s.fleet?.hosts.length ?? 0) : 0,
    sse: following ? s.sse : 'off',
    fromSnapshot: following && s.fromSnapshot,
    snapshotAt: s.snapshotAt,
    fleetAt: s.fleetAt ? new Date(s.fleetAt).toISOString() : null,
  };
}

async function auditRow(action: string, detail: Record<string, unknown>): Promise<void> {
  try {
    const prisma = await db();
    await prisma.actionLog.create({
      data: { action, target: 'sidecarmaster', status: 'success', logType: 'general', detail: JSON.stringify(detail) },
    });
  } catch (err) {
    logger.warn('Could not write the fleet.source audit row', { action, error: errMsg(err) });
  }
}

/**
 * Save settings. `token` is write-only; `clearToken` removes it. Switching to `follow`
 * needs a master URL and a token. Returns the masked view; the audit row has no token.
 */
export async function saveFleetSourceSettings(patch: FleetSourcePatch, actor = 'admin'): Promise<FleetSourceView> {
  if (patch.source !== undefined && patch.source !== 'local' && patch.source !== 'follow') {
    throw new FleetSourceError('source must be "local" or "follow"');
  }
  if (patch.masterUrl !== undefined && patch.masterUrl !== '' && !validMasterUrl(patch.masterUrl)) {
    throw new FleetSourceError('Master URL must start with http:// or https://');
  }
  if (patch.linkUrl !== undefined && patch.linkUrl !== '' && !validMasterUrl(patch.linkUrl)) {
    throw new FleetSourceError('Dashboard link must start with http:// or https://');
  }
  if (patch.token !== undefined && typeof patch.token !== 'string') throw new FleetSourceError('token must be text');

  const current = await getFleetSourceSettings({ fresh: true });
  const next: FleetSourceSettings = {
    source: patch.source ?? current.source,
    masterUrl: patch.masterUrl !== undefined ? normalizeMasterUrl(patch.masterUrl) : current.masterUrl,
    linkUrl: patch.linkUrl !== undefined ? normalizeMasterUrl(patch.linkUrl) : current.linkUrl,
    token: patch.clearToken ? '' : (patch.token?.trim() ? patch.token.trim() : current.token),
  };
  if (next.source === 'follow' && (!next.masterUrl || !next.token)) {
    throw new FleetSourceError('Follow needs a master URL and an app token. Save both first.');
  }

  const prisma = await db();
  const put = (key: string, value: string) =>
    prisma.config.upsert({ where: { key }, update: { value, updatedAt: new Date() }, create: { key, value } });
  await put(FLEET_SOURCE_KEYS.source, next.source);
  await put(FLEET_SOURCE_KEYS.masterUrl, next.masterUrl);
  await put(FLEET_SOURCE_KEYS.linkUrl, next.linkUrl);
  if (next.token) await put(FLEET_SOURCE_KEYS.token, next.token);
  else await prisma.config.deleteMany({ where: { key: FLEET_SOURCE_KEYS.token } });

  const s = st();
  const wasFollowing = current.source === 'follow';
  s.settings = next;
  s.settingsAt = Date.now();
  s.stale = true;
  s.lastError = null;
  if (next.source !== 'follow') {
    s.fleet = null; s.rows = null; s.rowsFor = null; s.fromSnapshot = false; s.lastOkAt = 0; s.sse = 'off';
  }
  logger.info('fleet.source saved', { source: next.source, masterUrl: next.masterUrl, hasToken: !!next.token, by: actor });
  await auditRow(next.source === 'follow' && !wasFollowing ? 'fleet.source.follow' : next.source === 'local' && wasFollowing ? 'fleet.source.local' : 'fleet.source.save', {
    source: next.source, masterUrl: next.masterUrl, linkUrl: next.linkUrl, hasToken: !!next.token, tokenHint: tokenHint(next.token), by: actor,
  });
  return toView(next);
}

async function fetchFleet(masterUrl: string, token: string): Promise<SmFleet> {
  const r = await fetch(`${masterUrl}/api/v1/apps/${APP_ID}/fleet`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) {
    const why = r.status === 401 ? 'token refused' : r.status === 403 ? 'token lacks fleet:read or is for another app' : `HTTP ${r.status}`;
    throw new Error(`sidecarmaster answered ${why}`);
  }
  const body = (await r.json()) as Partial<SmFleet> | null;
  if (!body || !Array.isArray(body.hosts)) throw new Error('sidecarmaster answered without a hosts list');
  return body as SmFleet;
}

async function writeSnapshot(masterUrl: string, fleet: SmFleet): Promise<void> {
  const s = st();
  const payload = JSON.stringify(fleet);
  if (payload === s.lastWritten) return;
  try {
    const prisma = await db();
    const fetchedAt = new Date();
    const generatedAt = fleet.generatedAt ? new Date(fleet.generatedAt) : null;
    const data = { masterUrl, payload, hostCount: fleet.hosts.length, generatedAt, fetchedAt };
    await prisma.fleetSnapshot.upsert({ where: { id: APP_ID }, update: data, create: { id: APP_ID, ...data } });
    s.lastWritten = payload;
    s.snapshotAt = fetchedAt.toISOString();
  } catch (err) {
    logger.warn('Could not save the fleet snapshot to system.db', { error: errMsg(err) });
  }
}

async function readSnapshot(): Promise<{ fleet: SmFleet; fetchedAt: string } | null> {
  try {
    const prisma = await db();
    const row = await prisma.fleetSnapshot.findUnique({ where: { id: APP_ID } });
    if (!row) return null;
    const fleet = JSON.parse(row.payload) as SmFleet;
    if (!fleet || !Array.isArray(fleet.hosts)) return null;
    return { fleet, fetchedAt: new Date(row.fetchedAt).toISOString() };
  } catch (err) {
    logger.warn('Could not read the fleet snapshot from system.db', { error: errMsg(err) });
    return null;
  }
}

/**
 * The fleet as sidecarmaster sees it. In-memory copy for 30 s; a fetch failure keeps the old
 * copy; with no copy the system.db snapshot is used; with nothing the answer is null.
 */
export async function getFollowedFleet(opts: { maxAgeMs?: number; force?: boolean } = {}): Promise<SmFleet | null> {
  const s = st();
  const maxAge = opts.maxAgeMs ?? FLEET_TTL_MS;
  if (!opts.force && !s.stale && s.fleet && Date.now() - s.fleetAt < maxAge) return s.fleet;
  if (s.inflight) return s.inflight;
  s.inflight = (async () => {
    try {
      const settings = await getFleetSourceSettings();
      if (settings.source !== 'follow') return null;
      s.stale = false;
      if (!settings.masterUrl || !settings.token) {
        s.lastError = 'Master URL or app token is not set';
        s.fleetAt = Date.now();
      } else {
        try {
          const fleet = await fetchFleet(settings.masterUrl, settings.token);
          s.fleet = fleet;
          s.fleetAt = Date.now();
          s.lastOkAt = s.fleetAt;
          s.fromSnapshot = false;
          s.lastError = null;
          void writeSnapshot(settings.masterUrl, fleet);
          return fleet;
        } catch (err) {
          s.lastError = errMsg(err);
          s.fleetAt = Date.now();
          logger.warn('Fleet fetch from sidecarmaster failed', { masterUrl: settings.masterUrl, error: s.lastError });
        }
      }
      if (s.fleet) return s.fleet;
      const snap = await readSnapshot();
      if (snap) {
        s.fleet = snap.fleet;
        s.fromSnapshot = true;
        s.snapshotAt = snap.fetchedAt;
        logger.info('Using the fleet snapshot from system.db', { fetchedAt: snap.fetchedAt, hosts: snap.fleet.hosts.length });
        return snap.fleet;
      }
      return null;
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}

/** Next read fetches again (the SSE feed calls this on a change). */
export function invalidateFollowedFleet(): void {
  st().stale = true;
}

export async function refreshFollowedFleet(opts: { ifOlderThanMs?: number } = {}): Promise<SmFleet | null> {
  const s = st();
  if (opts.ifOlderThanMs !== undefined && s.fleet && !s.stale && Date.now() - s.fleetAt < opts.ifOlderThanMs) return s.fleet;
  return getFollowedFleet({ force: true });
}

export function markSse(state: SseState, error?: string): void {
  const s = st();
  s.sse = state;
  if (error) s.lastError = error;
}

function hostUrls(h: SmHost): string[] {
  const out = new Set<string>();
  for (const u of [h.agentUrl, ...(h.aliases ?? [])]) {
    const n = normalizeMasterUrl(u);
    if (n) out.add(n);
  }
  return [...out];
}

/** sidecarmaster rows in HostRoleAssignment shape; one row per (sidecar URL, mode). */
export function toRows(f: SmFleet): HostRoleAssignment[] {
  const now = new Date();
  const out: HostRoleAssignment[] = [];
  for (const h of f.hosts) {
    for (const url of hostUrls(h)) {
      for (const r of h.roles ?? []) {
        out.push({
          id: `sm:${h.hostId}:${r.mode}:${url}`,
          sidecarUrl: url,
          mode: r.mode,
          enabled: r.enabled,
          minOnline: r.minOnline,
          idleTimeoutMin: r.idleTimeoutMin,
          modelOverride: r.modelOverride ?? null,
          runtime: r.runtime,
          createdAt: now,
          updatedAt: now,
        } as HostRoleAssignment);
      }
    }
  }
  return out;
}

/** Role rows from sidecarmaster, or null when not following or nothing is known yet. */
export async function followedAssignments(): Promise<HostRoleAssignment[] | null> {
  if (!(await isFollowMode())) return null;
  const fleet = await getFollowedFleet();
  if (!fleet) return null;
  const s = st();
  if (s.rowsFor !== fleet || !s.rows) {
    s.rows = toRows(fleet);
    s.rowsFor = fleet;
  }
  return s.rows;
}

/** sidecarmaster host OS → the three values Sound Suite's host provisioning knows. */
export function hostOsKind(v: string | null | undefined): 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s === 'linux' || s === 'mac-docker-ollama' || s === 'windows-docker-wsl2') return s;
  if (s.startsWith('mac') || s === 'darwin') return 'mac-docker-ollama';
  if (s.startsWith('win')) return 'windows-docker-wsl2';
  if (s.startsWith('linux') || s === 'ubuntu') return 'linux';
  return null;
}

export interface FollowedProvisioning {
  sidecarUrl: string;
  hostOsOverride: 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | null;
  masterUrlForHost: string | null;
  masterWsPortForHost: number | null;
  notes: string | null;
}

/** Host provisioning rows as sidecarmaster has them, or null when not following. */
export async function followedProvisioning(): Promise<FollowedProvisioning[] | null> {
  if (!(await isFollowMode())) return null;
  const fleet = await getFollowedFleet();
  if (!fleet) return null;
  const out: FollowedProvisioning[] = [];
  for (const h of fleet.hosts) {
    for (const url of hostUrls(h)) {
      out.push({
        sidecarUrl: url,
        hostOsOverride: hostOsKind(h.os),
        masterUrlForHost: h.masterUrl ?? null,
        masterWsPortForHost: typeof h.wsPortOverride === 'number' ? h.wsPortOverride : null,
        notes: `sidecarmaster host "${h.name}"`,
      });
    }
  }
  return out;
}

/** Throw in follow mode: policy edits belong in sidecarmaster. */
export async function assertLocalWrites(what = 'The fleet policy'): Promise<void> {
  const s = await getFleetSourceSettings();
  if (s.source === 'follow') throw new FollowModeError(what, s.linkUrl || s.masterUrl);
}

/** Same as assertLocalWrites, for sidecar control calls (start, stop, push, provision). */
export async function refuseInFollowMode(what: string): Promise<void> {
  const s = await getFleetSourceSettings();
  if (s.source === 'follow') throw new FollowModeError(what, s.linkUrl || s.masterUrl);
}

export interface FollowSkip { skipped: 'follow'; reason: string }

/** Answer for a push that is not done in follow mode. Logs once per label per 5 minutes. */
export function followSkip(label: string, agentUrl?: string): FollowSkip {
  const s = st();
  const now = Date.now();
  if (now - (s.skipLogAt[label] ?? 0) > SKIP_LOG_EVERY_MS) {
    s.skipLogAt[label] = now;
    logger.info(`Follow mode: ${label} skipped, sidecarmaster does this`, agentUrl ? { agentUrl } : undefined);
  }
  return { skipped: 'follow', reason: 'Managed by sidecarmaster' };
}

export interface MasterTestResult {
  ok: boolean;
  status: number | null;
  masterUrl: string;
  hosts: number;
  modes: number;
  generatedAt: string | null;
  error: string | null;
}

/** Try the master with the given or the saved token. The answer never carries the token. */
export async function testMasterConnection(input: { masterUrl?: string; token?: string } = {}, actor = 'admin'): Promise<MasterTestResult> {
  const saved = await getFleetSourceSettings({ fresh: true });
  const masterUrl = normalizeMasterUrl(input.masterUrl || saved.masterUrl);
  const token = (input.token?.trim() || saved.token).trim();
  if (!validMasterUrl(masterUrl)) throw new FleetSourceError('Master URL must start with http:// or https://');
  if (!token) throw new FleetSourceError('No app token: paste the token from sidecarmaster first');
  let out: MasterTestResult;
  try {
    const r = await fetch(`${masterUrl}/api/v1/apps/${APP_ID}/fleet`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      const why = r.status === 401 ? 'token refused (401)' : r.status === 403 ? 'token lacks fleet:read or is for another app (403)' : `HTTP ${r.status}`;
      out = { ok: false, status: r.status, masterUrl, hosts: 0, modes: 0, generatedAt: null, error: why };
    } else {
      const body = (await r.json()) as Partial<SmFleet>;
      out = {
        ok: Array.isArray(body?.hosts), status: r.status, masterUrl,
        hosts: Array.isArray(body?.hosts) ? body.hosts.length : 0,
        modes: Array.isArray(body?.modes) ? body.modes.length : 0,
        generatedAt: body?.generatedAt ?? null,
        error: Array.isArray(body?.hosts) ? null : 'answer had no hosts list',
      };
    }
  } catch (err) {
    out = { ok: false, status: null, masterUrl, hosts: 0, modes: 0, generatedAt: null, error: errMsg(err) };
  }
  await auditRow('fleet.source.test', { masterUrl, ok: out.ok, status: out.status, hosts: out.hosts, error: out.error, by: actor });
  return out;
}

// ─── "Managed by sidecarmaster" view for GET routes and the read-only banner ─────────────────

/** sidecarmaster pages that match the read-only pages here (same names on both sides). */
export const MASTER_PAGES = { gpu: '/gpu', roletypes: '/roletypes', roleassign: '/roleassign', hostprov: '/hostprov' } as const;
export type MasterPage = keyof typeof MASTER_PAGES;

export interface ManagedBy {
  /** Address for the links (linkUrl when set, else masterUrl). */
  url: string;
  pages: Record<MasterPage, string>;
}

export interface FleetSourcePublic {
  fleetSource: FleetSource;
  /** Set only in follow mode. */
  managedBy: ManagedBy | null;
}

export function managedByFor(s: FleetSourceSettings): ManagedBy | null {
  if (s.source !== 'follow') return null;
  const url = s.linkUrl || s.masterUrl;
  return {
    url,
    pages: {
      gpu: url + MASTER_PAGES.gpu,
      roletypes: url + MASTER_PAGES.roletypes,
      roleassign: url + MASTER_PAGES.roleassign,
      hostprov: url + MASTER_PAGES.hostprov,
    },
  };
}

/** `{ fleetSource, managedBy }` for GET answers. Never carries the token. */
export async function fleetSourcePublic(): Promise<FleetSourcePublic> {
  const s = await getFleetSourceSettings();
  return { fleetSource: s.source, managedBy: managedByFor(s) };
}

/** Test hook: forget every cached value. */
export function resetFleetSourceForTests(): void {
  const g = globalThis as unknown as { __ssFleetSource?: State };
  delete g.__ssFleetSource;
}
