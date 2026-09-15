/**
 * Role leases — the accounting behind `activeRequests`.
 *
 * ## Why this exists
 *
 * `handleAcquire` used to do `r.activeRequests++` and nothing in the sidecar
 * ever decremented it on the success path. The balancing `/release` had to
 * arrive from the master, so the counter was only as correct as the most
 * careless master on the fleet. It wasn't:
 *
 *   - Sound Suite's `resolveEndpoint` phase 1 sends `/acquire` purely to read
 *     `activeRequests` back as a load signal for router balancing, and never
 *     releases that probe.
 *   - `ollama-ocr-engine` and `/api/ollama/models` resolve an endpoint and
 *     never release it.
 *   - A second master (Fantom MCP) drives `code-embedding` and its release
 *     behaviour is not ours to guarantee.
 *   - A socket that drops mid-request takes its pending release with it.
 *
 * Measured on 2026-09-15 during an 8-hour code re-embed: two macOS
 * host-ollama hosts reported 6,548 and 6,328 concurrent requests while
 * actually serving a handful. The counter only ever grew.
 *
 * ## What breaks downstream when it leaks
 *
 * `startIdleTimerForRole` only arms when the count reaches 0, so roles are
 * pinned in VRAM forever — the Mac mini held three models resident at once.
 * `getTotalActiveRequests()` feeds the master's status, so every consumer of
 * the aggregate is wrong, and any scheduler reading it as capacity routes
 * around a host that is in fact idle.
 *
 * ## The model
 *
 * Every acquire opens a lease; a release closes one. `activeRequests` is
 * DERIVED — `syncRoleCounter` recomputes `state.perRole[role].activeRequests`
 * from the open-lease count after every mutation, so the dozens of existing
 * readers keep working and there is exactly one writer. A lease that is never
 * closed expires after `leaseTtlMs`, which turns a permanent leak into a
 * bounded one without requiring any master to change.
 *
 * Expiry arms the idle timer exactly as a real release would — the
 * `minOnline >= 1` guard in idle-timers.ts is what decides whether a model is
 * actually evicted, and it is unchanged. `handleTouch` extends a role's open
 * leases so a master that heartbeats keeps its work alive regardless of TTL.
 */
import { state } from './state';
import { createLogger } from './logger';
import { processGlobal } from './process-global';
import { startIdleTimerForRole } from './idle-timers';

const log = createLogger('leases');

export interface Lease {
  id: string;
  role: string;
  /** Who acquired it — a master's serverUrl over WS, or 'http' for the REST route. */
  owner: string;
  /** ms epoch; refreshed by touchRoleLeases(). Expiry is measured from here. */
  at: number;
}

/**
 * How long an unreleased lease survives. Longer than any single legitimate
 * inference (completions can run minutes) and far shorter than the hours a
 * leak used to persist. Override with SS_LEASE_TTL_MS; 0 disables expiry.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;
/** Open leases for one role above this logs a warning — visible in the sidecar's own UI. */
const LEAK_WARN_THRESHOLD = 50;

const G = processGlobal('leases', () => ({
  byId: new Map<string, Lease>(),
  sweepTimer: null as ReturnType<typeof setInterval> | null,
  /** Roles already warned about, so the warning does not repeat every sweep. */
  warned: new Set<string>(),
  seq: 0,
}));

function ttlMs(): number {
  const raw = parseInt(process.env.SS_LEASE_TTL_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

export function countOpenLeases(role: string): number {
  let n = 0;
  for (const l of G.byId.values()) if (l.role === role) n++;
  return n;
}

/**
 * Recompute the role's `activeRequests` from its open leases.
 *
 * The ONLY writer of that field for role-scoped work. When the count reaches
 * zero this arms the idle timer, which is what a release has always done —
 * whether the role is then actually evicted is still decided by the minOnline
 * guard inside startIdleTimerForRole.
 */
function syncRoleCounter(role: string, armIdleTimerAtZero = true): number {
  const r = state.perRole[role];
  if (!r) return 0;
  const n = countOpenLeases(role);
  const was = r.activeRequests;
  r.activeRequests = n;
  if (n === 0 && was !== 0 && armIdleTimerAtZero) startIdleTimerForRole(role);
  if (n > LEAK_WARN_THRESHOLD && !G.warned.has(role)) {
    G.warned.add(role);
    log.warn(
      `Role "${role}" holds ${n} open leases — far more than this host can be serving. ` +
      `A master is acquiring without releasing; leases older than ${ttlMs() / 1000}s ` +
      `will expire on their own. POST /api/reset-counters to clear them now.`,
    );
  }
  if (n <= LEAK_WARN_THRESHOLD) G.warned.delete(role);
  return n;
}

/** Open a lease for `role`. Returns the lease id to hand back to the caller. */
export function openLease(role: string, owner: string): string {
  const id = `lease-${Date.now().toString(36)}-${(G.seq++).toString(36)}`;
  G.byId.set(id, { id, role, owner, at: Date.now() });
  syncRoleCounter(role, false); // an acquire never arms the idle timer
  startSweeper();
  return id;
}

/**
 * Close a lease and report the role's remaining count.
 *
 * `leaseId` is preferred: it makes a duplicate release a no-op instead of a
 * double decrement. Masters that predate leases send only a role, so without
 * an id we close that role's OLDEST open lease — the same net effect the bare
 * counter had, minus the ability to go negative.
 */
export function closeLease(role: string, leaseId?: string): { closed: boolean; remaining: number; role: string } {
  if (leaseId) {
    const l = G.byId.get(leaseId);
    if (!l) {
      log.debug(`Release for unknown lease ${leaseId} (role=${role}) — already closed or expired`);
      return { closed: false, remaining: syncRoleCounter(role), role };
    }
    G.byId.delete(leaseId);
    // The lease's OWN role is authoritative, and it is reported back: a caller
    // that pairs a leaseId with the wrong role would otherwise be told a count
    // for a role it did not ask about, and that role's counter would never be
    // resynced. Unreachable with today's masters, which always release the
    // role they acquired — but the response should not be able to lie.
    if (l.role !== role) {
      log.warn(`Release sent role="${role}" with a lease belonging to "${l.role}" — honouring the lease`);
      syncRoleCounter(role);
    }
    return { closed: true, remaining: syncRoleCounter(l.role), role: l.role };
  }
  let oldest: Lease | undefined;
  for (const l of G.byId.values()) {
    if (l.role !== role) continue;
    if (!oldest || l.at < oldest.at) oldest = l;
  }
  if (!oldest) return { closed: false, remaining: syncRoleCounter(role), role };
  G.byId.delete(oldest.id);
  return { closed: true, remaining: syncRoleCounter(role), role };
}

/**
 * Close every lease held by one owner. Called when a master's WebSocket drops:
 * that master cannot send the releases it still owes, and a reconnect opens
 * fresh leases, so holding the old ones only inflates the count.
 */
export function closeLeasesForOwner(owner: string): number {
  const doomed = [...G.byId.values()].filter((l) => l.owner === owner);
  if (doomed.length === 0) return 0;
  const roles = new Set(doomed.map((l) => l.role));
  for (const l of doomed) G.byId.delete(l.id);
  for (const role of roles) syncRoleCounter(role);
  log.info(`Released ${doomed.length} lease(s) held by ${owner} (roles: ${[...roles].join(', ')})`);
  return doomed.length;
}

/** Close every lease for a role, or for all roles. Used by /api/reset-counters. */
export function closeAllLeases(role?: string): number {
  const doomed = [...G.byId.values()].filter((l) => !role || l.role === role);
  const roles = new Set(doomed.map((l) => l.role));
  for (const l of doomed) G.byId.delete(l.id);
  for (const r of roles) syncRoleCounter(r);
  if (role && !roles.has(role)) syncRoleCounter(role);
  return doomed.length;
}

/**
 * Extend every open lease for a role — the master is telling us the work is
 * still live. This is what makes TTL expiry safe for a long job: a master that
 * heartbeats keeps its leases regardless of how long the job runs.
 */
export function touchRoleLeases(role: string): number {
  const now = Date.now();
  let n = 0;
  for (const l of G.byId.values()) {
    if (l.role !== role) continue;
    l.at = now;
    n++;
  }
  return n;
}

/** Expire leases older than the TTL. Returns how many were reaped. */
export function sweepExpiredLeases(): number {
  const ttl = ttlMs();
  if (ttl === 0) return 0;
  const cutoff = Date.now() - ttl;
  const doomed = [...G.byId.values()].filter((l) => l.at < cutoff);
  if (doomed.length === 0) return 0;
  const roles = new Set(doomed.map((l) => l.role));
  for (const l of doomed) G.byId.delete(l.id);
  for (const role of roles) syncRoleCounter(role);
  log.warn(
    `Expired ${doomed.length} lease(s) older than ${ttl / 1000}s (roles: ${[...roles].join(', ')}). ` +
    `Their master acquired without releasing.`,
  );
  return doomed.length;
}

export function startSweeper(): void {
  if (G.sweepTimer) return;
  G.sweepTimer = setInterval(() => {
    try { sweepExpiredLeases(); } catch (err) {
      log.error(`Lease sweep failed: ${(err as Error).message}`);
    }
  }, SWEEP_INTERVAL_MS);
  G.sweepTimer.unref?.();
}

export function stopSweeper(): void {
  if (!G.sweepTimer) return;
  clearInterval(G.sweepTimer);
  G.sweepTimer = null;
}

/** Diagnostics for /api/status: open leases per role, oldest first. */
export function leaseSummary(): { total: number; ttlMs: number; byRole: Record<string, { open: number; oldestAgeMs: number }> } {
  const byRole: Record<string, { open: number; oldestAgeMs: number }> = {};
  const now = Date.now();
  for (const l of G.byId.values()) {
    const e = byRole[l.role] || (byRole[l.role] = { open: 0, oldestAgeMs: 0 });
    e.open++;
    e.oldestAgeMs = Math.max(e.oldestAgeMs, now - l.at);
  }
  return { total: G.byId.size, ttlMs: ttlMs(), byRole };
}

/** Test seam — drops all lease state without touching role counters. */
export function __resetLeasesForTest(): void {
  G.byId.clear();
  G.warned.clear();
  G.seq = 0;
  stopSweeper();
}
