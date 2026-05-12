/**
 * Sidecar reconnect watchdog.
 *
 * Every 2 minutes, scan the persisted `gpu.sidecars` list. For any sidecar that
 * hasn't checked in for >= STALE_MS, attempt a "reverse poll": the master
 * proactively asserts its canonical URL on the sidecar.
 *
 *   1. HTTP GET  http://<sidecar-host>:<port>/api/health   — is it alive?
 *   2. HTTP POST http://<sidecar-host>:<port>/api/masters  with
 *                { serverUrl: <canonical-master-url> }
 *
 * Sidecar implements the POST handler (Agent B). Idempotent on the sidecar
 * side — if the URL already matches an entry, no-op.
 *
 * `<sidecar-host>:<port>` is derived from the registered `agentUrl`. The
 * default sidecar admin port is 8098.
 */

import { createLogger } from '@/lib/logger';
import { getConfig } from '@/lib/db/config';
import { getCanonicalMasterUrl } from '@/lib/gpu/master-identity';

const logger = createLogger('SidecarReconnectWatchdog');

const TICK_MS = 2 * 60_000;
const STALE_MS = 2 * 60_000;
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

const g = globalThis as any;
if (!g.__ss_reconnect_watchdog__) g.__ss_reconnect_watchdog__ = { timer: null as any };
const state: { timer: ReturnType<typeof setInterval> | null } = g.__ss_reconnect_watchdog__;

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

async function reassertOn(entry: SidecarEntry, masterUrl: string): Promise<void> {
  const base = deriveSidecarAdminUrl(entry);
  if (!base) {
    logger.warn('Cannot derive sidecar admin URL for reverse-poll', { agentUrl: entry.url });
    return;
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
      return;
    }
  } catch (err) {
    logger.info('Reverse-poll: sidecar unreachable for health probe', {
      agentUrl: entry.url,
      base,
      error: (err as Error).message,
    });
    return;
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
    } else {
      logger.warn('Reverse-poll: sidecar rejected master URL assertion', {
        agentUrl: entry.url,
        base,
        status: ar.status,
      });
    }
  } catch (err) {
    logger.warn('Reverse-poll: POST /api/masters failed', {
      agentUrl: entry.url,
      base,
      error: (err as Error).message,
    });
  }
}

async function tick(): Promise<void> {
  let masterUrl: string | null = null;
  try {
    masterUrl = await getCanonicalMasterUrl();
  } catch { /* ignore */ }
  if (!masterUrl) {
    // Nothing to push. Skip silently — env/Config not yet set.
    return;
  }

  let sidecars: SidecarEntry[] = [];
  try {
    const cfg = await getConfig();
    sidecars = JSON.parse(cfg.gpuSidecars || '[]') as SidecarEntry[];
  } catch (err) {
    logger.warn('Failed to read sidecar list', { error: (err as Error).message });
    return;
  }

  const now = Date.now();
  for (const entry of sidecars) {
    const last = entry.lastSeenAt
      ?? (entry.lastSeen ? Date.parse(entry.lastSeen) : 0);
    if (!last || now - last >= STALE_MS) {
      // Fire-and-forget. Each reassertOn handles its own errors.
      void reassertOn(entry, masterUrl);
    }
  }
}

/** Start the watchdog loop. Idempotent. */
export function startSidecarReconnectWatchdog(): void {
  if (state.timer) return;
  logger.info('Starting sidecar reconnect watchdog', {
    intervalMs: TICK_MS,
    staleMs: STALE_MS,
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
    logger.info('Stopped sidecar reconnect watchdog');
  }
}
