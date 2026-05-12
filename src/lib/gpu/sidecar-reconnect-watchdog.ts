/**
 * Sidecar reconnect watchdog.
 *
 * Scans the persisted `gpu.sidecars` list on a 30s tick. Per-sidecar state
 * machine governs when to reverse-poll (push the master's canonical URL to
 * the sidecar's /api/masters):
 *
 *   healthy : last heartbeat < 60s ago     -> skip
 *   stale   : 60s <= age < 5min            -> push every 30s until success,
 *                                             then back off to 5min
 *   dormant : age >= 5min OR never seen    -> push every 5min
 *
 *   1. HTTP GET  http://<sidecar-host>:<port>/api/health   - is it alive?
 *   2. HTTP POST http://<sidecar-host>:<port>/api/masters  with
 *                { serverUrl: <canonical-master-url> }
 *
 * Sidecar implements the POST handler (Agent B). Idempotent on the sidecar
 * side - if the URL already matches an entry, no-op.
 *
 * `<sidecar-host>:<port>` is derived from the registered `agentUrl`. The
 * default sidecar admin port is 8098.
 *
 * Exports `triggerReassertNow(agentUrl, fallbackMasterUrl?)` for immediate
 * fire from heartbeat/register routes when the sidecar arrives with an empty
 * masters[] (i.e. lost its config, needs the URL re-asserted right now).
 */

import { createLogger } from '@/lib/logger';
import { getConfig } from '@/lib/db/config';
import { resolveMasterUrlForHost } from '@/lib/gpu/resolve-master-url-for-host';

const logger = createLogger('SidecarReconnectWatchdog');

const TICK_MS = 30_000;
const HEALTHY_AGE_MS = 60_000;          // < 60s = healthy, skip
const DORMANT_AGE_MS = 5 * 60_000;      // >= 5min = dormant
const STALE_RETRY_MS = 30_000;          // re-try stale every 30s
const DORMANT_RETRY_MS = 5 * 60_000;    // re-try dormant every 5min
const SUCCESS_BACKOFF_MS = 5 * 60_000;  // after a successful push, wait 5min
const HTTP_TIMEOUT_MS = 4_000;
const DEFAULT_SIDECAR_ADMIN_PORT = 8098;

interface SidecarEntry {
  url: string;
  hostname?: string;
  lastSeen?: string;
  lastSeenAt?: number;
  lastSeenFromIp?: string;
  status?: string;
}

interface PerSidecarState {
  /** When the next reverse-poll attempt is allowed (epoch ms). */
  nextAttemptAt: number;
  /** Last successful reassert. 0 if never. */
  lastSuccessAt: number;
}

const g = globalThis as any;
if (!g.__ss_reconnect_watchdog__) {
  g.__ss_reconnect_watchdog__ = {
    timer: null as any,
    tickMs: 0,
    perSidecar: new Map<string, PerSidecarState>(),
  };
}
// Migration: older runtimes only had `timer`. Backfill the rest.
if (!g.__ss_reconnect_watchdog__.perSidecar) {
  g.__ss_reconnect_watchdog__.perSidecar = new Map<string, PerSidecarState>();
}
if (typeof g.__ss_reconnect_watchdog__.tickMs !== 'number') {
  g.__ss_reconnect_watchdog__.tickMs = 0;
}
const state: {
  timer: ReturnType<typeof setInterval> | null;
  tickMs: number;
  perSidecar: Map<string, PerSidecarState>;
} = g.__ss_reconnect_watchdog__;

/**
 * Build the sidecar admin base URL. Prefers the agent URL's host, swapping the
 * port to the admin port (8098) since the agent URL may point at a worker
 * container port. Falls back to lastSeenFromIp + default port.
 */
function deriveSidecarAdminUrl(entry: SidecarEntry): string | null {
  // Try the agent URL host
  try {
    if (entry.url) {
      const u = new URL(entry.url);
      const port = process.env.SIDECAR_ADMIN_PORT
        ? parseInt(process.env.SIDECAR_ADMIN_PORT, 10)
        : DEFAULT_SIDECAR_ADMIN_PORT;
      return `${u.protocol}//${u.hostname}:${port}`;
    }
  } catch { /* fall through */ }
  if (entry.lastSeenFromIp) {
    return `http://${entry.lastSeenFromIp}:${DEFAULT_SIDECAR_ADMIN_PORT}`;
  }
  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Returns true on a successful POST /api/masters; false otherwise. */
async function reassertOn(entry: SidecarEntry, masterUrl: string): Promise<boolean> {
  const base = deriveSidecarAdminUrl(entry);
  if (!base) {
    logger.warn('Cannot derive sidecar admin URL for reverse-poll', { agentUrl: entry.url });
    return false;
  }
  // 1. health probe
  try {
    const hr = await fetchWithTimeout(`${base}/api/health`, { method: 'GET' }, HTTP_TIMEOUT_MS);
    if (!hr.ok) {
      logger.info('Reverse-poll: sidecar health probe failed', {
        agentUrl: entry.url,
        base,
        status: hr.status,
      });
      return false;
    }
  } catch (err) {
    logger.info('Reverse-poll: sidecar unreachable for health probe', {
      agentUrl: entry.url,
      base,
      error: (err as Error).message,
    });
    return false;
  }
  // 2. assert master URL
  try {
    const ar = await fetchWithTimeout(
      `${base}/api/masters`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverUrl: masterUrl }),
      },
      HTTP_TIMEOUT_MS,
    );
    if (ar.ok) {
      logger.info('Reverse-poll: reasserted master URL on sidecar', {
        agentUrl: entry.url,
        base,
        masterUrl,
      });
      return true;
    }
    logger.warn('Reverse-poll: sidecar rejected master URL assertion', {
      agentUrl: entry.url,
      base,
      status: ar.status,
    });
    return false;
  } catch (err) {
    logger.warn('Reverse-poll: POST /api/masters failed', {
      agentUrl: entry.url,
      base,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Phase classifier from the entry's last-heartbeat timestamp. */
function classify(entry: SidecarEntry, now: number): 'healthy' | 'stale' | 'dormant' {
  const last = entry.lastSeenAt
    ?? (entry.lastSeen ? Date.parse(entry.lastSeen) : 0);
  if (!last) return 'dormant';
  const age = now - last;
  if (age < HEALTHY_AGE_MS) return 'healthy';
  if (age < DORMANT_AGE_MS) return 'stale';
  return 'dormant';
}

async function tick(): Promise<void> {
  let sidecars: SidecarEntry[] = [];
  try {
    const cfg = await getConfig();
    sidecars = JSON.parse(cfg.gpuSidecars || '[]') as SidecarEntry[];
  } catch (err) {
    logger.warn('Failed to read sidecar list', { error: (err as Error).message });
    return;
  }

  const now = Date.now();
  // Prune state map for sidecars no longer in the list (operator removed).
  if (state.perSidecar.size) {
    const active = new Set(sidecars.map(s => s.url));
    for (const key of state.perSidecar.keys()) {
      if (!active.has(key)) state.perSidecar.delete(key);
    }
  }

  for (const entry of sidecars) {
    const phase = classify(entry, now);
    if (phase === 'healthy') continue;

    // Per-host URL only - no global fallback. Skip silently if operator
    // hasn't configured this host on /admin/host-provisioning.
    const masterUrl = await resolveMasterUrlForHost(entry.url).catch(() => null);
    if (!masterUrl) continue;

    let st = state.perSidecar.get(entry.url);
    if (!st) {
      st = { nextAttemptAt: 0, lastSuccessAt: 0 };
      state.perSidecar.set(entry.url, st);
    }
    if (now < st.nextAttemptAt) continue;

    // Optimistic backoff for dormant: regardless of result, wait 5min.
    // Stale: 30s on failure, 5min on success.
    const wasDormant = phase === 'dormant';
    void reassertOn(entry, masterUrl).then(ok => {
      const after = Date.now();
      if (ok) {
        st!.lastSuccessAt = after;
        st!.nextAttemptAt = after + SUCCESS_BACKOFF_MS;
      } else if (wasDormant) {
        st!.nextAttemptAt = after + DORMANT_RETRY_MS;
      } else {
        st!.nextAttemptAt = after + STALE_RETRY_MS;
      }
    }).catch(() => {
      // reassertOn already logs; treat as failure for backoff purposes.
      const after = Date.now();
      st!.nextAttemptAt = after + (wasDormant ? DORMANT_RETRY_MS : STALE_RETRY_MS);
    });
    // Tentative throttle so concurrent ticks don't all fire at once.
    st.nextAttemptAt = now + (wasDormant ? DORMANT_RETRY_MS : STALE_RETRY_MS);
  }
}

/**
 * Immediate-fire trigger for the heartbeat/register routes when they detect
 * a sidecar arriving with empty masters[] (i.e. lost its config).
 *
 * Resolves the master URL via:
 *   1. resolveMasterUrlForHost(agentUrl)   - explicit per-host provisioning
 *   2. fallbackMasterUrl                   - request-scoped bootstrap (Host hdr)
 *
 * If both are null, returns without acting (preserves "operator disabled" no-op).
 * Does NOT persist anything; the bootstrap URL stays request-scoped.
 *
 * Returns true on a successful reassert, false otherwise.
 */
export async function triggerReassertNow(
  agentUrl: string,
  fallbackMasterUrl?: string | null,
): Promise<boolean> {
  if (!agentUrl) return false;
  let masterUrl: string | null = null;
  try {
    masterUrl = await resolveMasterUrlForHost(agentUrl);
  } catch {
    masterUrl = null;
  }
  if (!masterUrl && fallbackMasterUrl) masterUrl = fallbackMasterUrl;
  if (!masterUrl) {
    logger.info('triggerReassertNow: no master URL available, skipping', { agentUrl });
    return false;
  }

  // Look up the sidecar entry from the persisted list to derive the admin URL.
  let entry: SidecarEntry | null = null;
  try {
    const cfg = await getConfig();
    const sidecars = JSON.parse(cfg.gpuSidecars || '[]') as SidecarEntry[];
    entry = sidecars.find(s => s.url === agentUrl) || null;
  } catch {
    entry = null;
  }
  // If we don't have an entry yet (race against heartbeat persistence), build
  // a synthetic one from agentUrl so deriveSidecarAdminUrl can still resolve.
  if (!entry) entry = { url: agentUrl };

  const ok = await reassertOn(entry, masterUrl);
  const after = Date.now();
  let st = state.perSidecar.get(agentUrl);
  if (!st) {
    st = { nextAttemptAt: 0, lastSuccessAt: 0 };
    state.perSidecar.set(agentUrl, st);
  }
  if (ok) {
    st.lastSuccessAt = after;
    st.nextAttemptAt = after + SUCCESS_BACKOFF_MS;
  } else {
    st.nextAttemptAt = after + STALE_RETRY_MS;
  }
  return ok;
}

/** Start the watchdog loop. Idempotent. If TICK_MS changed (hot reload), reset. */
export function startSidecarReconnectWatchdog(): void {
  if (state.timer && state.tickMs === TICK_MS) return;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    logger.info('Sidecar reconnect watchdog: re-arming with new tick interval', {
      oldTickMs: state.tickMs,
      newTickMs: TICK_MS,
    });
  }
  state.tickMs = TICK_MS;
  logger.info('Starting sidecar reconnect watchdog', {
    intervalMs: TICK_MS,
    healthyAgeMs: HEALTHY_AGE_MS,
    dormantAgeMs: DORMANT_AGE_MS,
  });
  state.timer = setInterval(() => {
    void tick().catch((err) => {
      logger.warn('Watchdog tick failed', { error: (err as Error).message });
    });
  }, TICK_MS);
  // Don't keep the process alive solely for this loop.
  if (typeof state.timer.unref === 'function') state.timer.unref();
}

/** Stop the watchdog loop. */
export function stopSidecarReconnectWatchdog(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
    state.tickMs = 0;
    logger.info('Stopped sidecar reconnect watchdog');
  }
}
