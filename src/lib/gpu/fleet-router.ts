/**
 * Fleet Router — Central module for GPU sidecar fleet management.
 *
 * Generalizes the dual-mode communication pattern from reranker-lifecycle.ts
 * (direct HTTP first, WebSocket tunnel fallback) to any sidecar in the fleet.
 *
 * Stateless: all persistent state comes from Config DB ("gpu.sidecars" key)
 * and live WebSocket connections tracked by ws-relay.ts.
 */

import { createLogger } from '@/lib/logger';
import { getConfig, setConfigValue } from '@/lib/db/config';
import * as wsRelay from '@/lib/gpu/ws-relay';
import { queueSidecarCommand } from '@/lib/gpu/command-queue';
import * as statusCache from '@/lib/gpu/status-cache';
import {
  getEnabledModesForHost,
  getModelOverridesForHost,
  getEffectiveMinOnline,
  getEffectiveIdleTimeoutsMs,
  getRuntimesForHost,
  listAllAssignments,
} from '@/lib/db/role-registry';
import { resolveModelFromConfig, type ModeName } from '@/lib/gpu/mode-catalog';
import { ocrModelCaps } from '@/lib/gpu/ocr-model-caps';
import { seedAssignmentsForHost } from '@/lib/db/role-registry-seed';
import { getProvisioning } from '@/lib/db/host-provisioning';

const logger = createLogger('FleetRouter');

// ─── Per-(sidecar, role) acquire back-off (Task #31) ─────────────────────────
//
// enforceMinOnline ticks every ~5s. Without back-off, a persistent /acquire
// failure (network blip, sidecar handleAcquire bug, host-Ollama unloaded
// model) produces a log storm and amplifies downstream bugs. Schedule:
//   1st & 2nd consecutive failure → no delay (transient blips not penalized)
//   3rd → 30s   4th → 60s   5th → 120s   6th+ → 300s (cap)
// A success resets the counter.

interface AcquireBackoffState {
  consecutiveFailures: number;
  nextAttemptAt: number; // epoch ms
  lastSuccessAt: number; // 0 if never
  lastSkipLogAt: number; // for INFO log throttling (once per minute)
}

const acquireBackoff = new Map<string, AcquireBackoffState>();

function backoffKey(sidecarUrl: string, role: string): string {
  return `${sidecarUrl}::${role}`;
}

function shouldSkipAcquire(sidecarUrl: string, role: string): boolean {
  const st = acquireBackoff.get(backoffKey(sidecarUrl, role));
  if (!st) return false;
  return Date.now() < st.nextAttemptAt;
}

function recordAcquireSuccess(sidecarUrl: string, role: string): void {
  const k = backoffKey(sidecarUrl, role);
  acquireBackoff.set(k, {
    consecutiveFailures: 0,
    nextAttemptAt: 0,
    lastSuccessAt: Date.now(),
    lastSkipLogAt: 0,
  });
}

function recordAcquireFailure(sidecarUrl: string, role: string): void {
  const k = backoffKey(sidecarUrl, role);
  const prev = acquireBackoff.get(k) ?? {
    consecutiveFailures: 0,
    nextAttemptAt: 0,
    lastSuccessAt: 0,
    lastSkipLogAt: 0,
  };
  const n = prev.consecutiveFailures + 1;
  // index = clamped failure count; values for n=1,2 → 0 (immediate retry).
  const delaysMs = [0, 0, 0, 30_000, 60_000, 120_000, 300_000];
  const delay = delaysMs[Math.min(n, delaysMs.length - 1)];
  acquireBackoff.set(k, {
    consecutiveFailures: n,
    nextAttemptAt: Date.now() + delay,
    lastSuccessAt: prev.lastSuccessAt,
    lastSkipLogAt: prev.lastSkipLogAt,
  });
}

function maybeLogAcquireSkip(sidecarUrl: string, role: string): void {
  const k = backoffKey(sidecarUrl, role);
  const st = acquireBackoff.get(k);
  if (!st) return;
  const now = Date.now();
  if (now - st.lastSkipLogAt < 60_000) return;
  st.lastSkipLogAt = now;
  const remainingMs = Math.max(0, st.nextAttemptAt - now);
  logger.info(
    `min-online: backing off /acquire for ${role} on ${sidecarUrl} — ${st.consecutiveFailures} consecutive failures, next attempt in ${Math.round(remainingMs / 1000)}s`,
  );
}

// ─── dockerMode=none skip log throttling ─────────────────────────────────────
// Throttle to once per (sidecar, role) per hour. Operator only needs the
// "fix this sidecar" hint once, not every 30s tick.
const dockerModeNoneLogged = new Map<string, number>();
function logDockerModeNoneSkip(sidecarUrl: string, role: string): void {
  const k = `${sidecarUrl}::${role}`;
  const now = Date.now();
  const last = dockerModeNoneLogged.get(k) ?? 0;
  if (now - last < 60 * 60_000) return;
  dockerModeNoneLogged.set(k, now);
  logger.warn(
    `min-online: skipping ${role} on ${sidecarUrl} — sidecar reports dockerMode=none (no /var/run/docker.sock mount). ` +
    `Recreate the sidecar container with -v /var/run/docker.sock:/var/run/docker.sock to enable docker-runtime roles.`,
  );
}

// ─── hostOs=unknown skip log throttling (Task #36) ───────────────────────────
const unknownHostOsLogged = new Set<string>();
function logUnknownHostOsSkipOnce(role: string): void {
  if (unknownHostOsLogged.has(role)) return;
  unknownHostOsLogged.add(role);
  logger.info(
    `Skipping registry entry for role=${role}: hostOs unknown, awaiting detection`,
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SidecarEntry {
  url: string;
  hostname: string;
  mode: 'direct' | 'websocket';
  lastSeen: string;
  status: 'connected' | 'disconnected';
  containers: string[];
  note?: string;
}

export interface SidecarStatus {
  agent: { uptime: number; version?: string };
  container: { status: string; id?: string; image?: string };
  activeRequests: number;
  idleTimerActive: boolean;
  idleTimeouts: Record<string, number>;
  [key: string]: unknown;
}

export interface FleetSidecar extends SidecarEntry {
  sidecarStatus?: SidecarStatus;
}

export type GpuRole = 'embedding' | 'completion' | 'ocr' | 'reranker';

export interface ResolvedEndpoint {
  host: string;       // e.g. "http://10.10.20.5:11434"
  sidecarUrl: string; // e.g. "http://10.10.20.5:8098"
  role: GpuRole;
}

export interface GpuInfo {
  index: number;
  name: string;
  memoryTotal: number;
  memoryUsed: number;
  memoryFree: number;
  temperature: number;
}

export interface FleetStatus {
  sidecars: FleetSidecar[];
  wsRelayPort: number;
  connectedViaWs: number;
}

export interface IdleTimeouts {
  embedding: number; // minutes (0 = never stop)
  completion: number;
  ocr: number;
  reranker: number;
}

// ─── Core Communication ──────────────────────────────────────────────────────

/**
 * Send a command to a sidecar via the gossip protocol.
 *
 * Priority:
 *   1. WebSocket tunnel (instant, if sidecar has active WS connection)
 *   2. Command queue (sidecar polls for pending commands via HTTP)
 *
 * Direct HTTP push is no longer attempted — sidecars may be on
 * unreachable subnets (NAT, Docker, different VLAN).
 */
export async function sendToSidecar(
  agentUrl: string,
  path: string,
  body?: object,
  method: string = body ? 'POST' : 'GET',
  timeoutMs?: number,
): Promise<any> {
  const defaultTimeout = method === 'GET' ? 5_000 : 15_000;
  const timeout = timeoutMs ?? defaultTimeout;
  const action = path.replace(/^\//, '');

  // For read-only status queries, try the cache first
  if (action === 'status' && !body) {
    const cached = statusCache.getSidecarStatus(agentUrl);
    if (cached && (Date.now() - cached.lastSeen) < 15_000) {
      logger.info(`sendToSidecar: cache hit for /${action}`, {
        agentUrl,
        cacheAge: `${Date.now() - cached.lastSeen}ms`,
      });
      return cached;
    }
  }

  logger.info(`sendToSidecar: /${action}`, { agentUrl, timeout: `${timeout}ms` });
  const startTime = Date.now();
  try {
    const result = await queueSidecarCommand(agentUrl, action, body, timeout);
    const elapsed = Date.now() - startTime;
    logger.info(`sendToSidecar: /${action} completed`, { agentUrl, elapsed: `${elapsed}ms` });
    return result;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`sendToSidecar: /${action} failed`, {
      agentUrl,
      elapsed: `${elapsed}ms`,
      error: (err as Error).message,
    });
    throw err;
  }
}

// ─── Registry Management ─────────────────────────────────────────────────────

/** Read the sidecar list from Config DB. */
async function readSidecarList(): Promise<SidecarEntry[]> {
  const config = await getConfig();
  try {
    return JSON.parse(config.gpuSidecars || '[]');
  } catch {
    return [];
  }
}

/** Write the sidecar list to Config DB. */
async function writeSidecarList(list: SidecarEntry[]): Promise<void> {
  await setConfigValue('gpu.sidecars', JSON.stringify(list));
}

/**
 * Get fleet status: merges DB sidecar list with live WS connections + status cache.
 */
export async function getFleetStatus(): Promise<FleetStatus> {
  const dbList = await readSidecarList();
  const allCached = statusCache.getAllSidecarStatuses();
  const cachedMap = new Map(allCached.map(s => [s.agentUrl, s]));

  // Note: wsRelay.getConnectedSidecars() is unreliable due to Next.js module
  // isolation — the WS relay's in-memory Map lives in the instrumentation context
  // while API routes run in a different context. Use status cache instead:
  // wsConnected flag is set by the WS relay heartbeat handler and shared via cache.

  // Build a note lookup from DB entries so we can preserve notes for cache-only sidecars
  const noteMap = new Map<string, string>();
  for (const entry of dbList) {
    if (entry.note) noteMap.set(entry.url, entry.note);
  }

  // Merge: update DB entries with cached status
  const merged = new Map<string, FleetSidecar>();

  for (const entry of dbList) {
    const cached = cachedMap.get(entry.url);
    const isConnected = cached && statusCache.isSidecarConnected(entry.url);

    merged.set(entry.url, {
      ...entry,
      mode: cached?.wsConnected ? 'websocket' : entry.mode,
      status: isConnected ? 'connected' : entry.status,
      lastSeen: cached ? new Date(cached.lastSeen).toISOString() : entry.lastSeen,
      sidecarStatus: cached as any,
    });
  }

  // Add cached sidecars not in DB (registered via WS but never manually added)
  for (const cached of allCached) {
    if (!merged.has(cached.agentUrl)) {
      merged.set(cached.agentUrl, {
        url: cached.agentUrl,
        hostname: cached.hostname,
        mode: cached.wsConnected ? 'websocket' : 'direct',
        lastSeen: new Date(cached.lastSeen).toISOString(),
        status: statusCache.isSidecarConnected(cached.agentUrl) ? 'connected' : 'disconnected',
        containers: Object.values(cached.containers).map(c => c.name).filter(Boolean),
        sidecarStatus: cached as any,
      });
    }
  }

  // Count WS-connected from status cache (reliable across Next.js contexts)
  const wsCount = allCached.filter(s => s.wsConnected && statusCache.isSidecarConnected(s.agentUrl)).length;

  return {
    sidecars: Array.from(merged.values()),
    wsRelayPort: parseInt(process.env.GPU_WS_PORT || '3002', 10),
    connectedViaWs: wsCount,
  };
}

/** Register a new sidecar in the fleet. */
export async function addSidecar(url: string, hostname?: string): Promise<SidecarEntry> {
  const list = await readSidecarList();
  const normalized = url.replace(/\/+$/, '');

  // Don't add duplicates
  const existing = list.find(s => s.url === normalized);
  if (existing) return existing;

  const entry: SidecarEntry = {
    url: normalized,
    hostname: hostname || new URL(normalized).hostname,
    mode: 'direct',
    lastSeen: new Date().toISOString(),
    status: 'disconnected',
    containers: [],
  };

  list.push(entry);
  await writeSidecarList(list);
  logger.info('Sidecar added to fleet', { url: normalized, hostname: entry.hostname });
  return entry;
}

/** Update the note for a sidecar in the fleet registry. */
export async function updateSidecarNote(url: string, note: string): Promise<boolean> {
  const list = await readSidecarList();
  const normalized = url.replace(/\/+$/, '');
  const entry = list.find(s => s.url === normalized);
  if (!entry) return false;
  entry.note = note || undefined; // Remove note if empty
  await writeSidecarList(list);
  logger.info('Sidecar note updated', { url: normalized, note: note || '(cleared)' });
  return true;
}

/** Remove a sidecar from the fleet registry.
 *
 *  Removing from the persisted list alone isn't enough — a still-running
 *  sidecar will reconnect via WebSocket on its next heartbeat (~5s) and the
 *  `register` handler in ws-relay will auto-add it back to the list, making
 *  the delete look like it failed. To make deletes actually stick:
 *
 *    1. Close the active WS connection so the sidecar gets disconnected now.
 *    2. Add the agentUrl to a transient block-list so any immediate reconnect
 *       is refused for ~60 s. That gives the operator a window to stop the
 *       sidecar process or remove the master URL from its config.
 *    3. Drop the status-cache entry so the UI doesn't keep showing a stale
 *       "disconnected" pill for a sidecar the operator just deleted.
 */
export async function removeSidecar(url: string): Promise<boolean> {
  const list = await readSidecarList();
  const normalized = url.replace(/\/+$/, '');
  const filtered = list.filter(s => s.url !== normalized);

  // Even if the URL wasn't in the persisted list, the sidecar may still be
  // in the live WS map / status cache (e.g. it auto-registered without being
  // explicitly added). Run the disconnect path regardless so the entry truly
  // disappears from the UI.
  let listChanged = filtered.length !== list.length;

  try {
    const wsRelay = await import('./ws-relay');
    if (typeof wsRelay.closeSidecarConnection === 'function') {
      const closed = wsRelay.closeSidecarConnection(normalized);
      if (closed) listChanged = true;
    }
    if (typeof wsRelay.blockAgent === 'function') {
      wsRelay.blockAgent(normalized);
    }
  } catch (err) {
    logger.warn('Sidecar WS disconnect step failed (continuing)', {
      url: normalized, error: (err as Error).message,
    });
  }

  try {
    const { removeSidecarFromCache } = await import('./status-cache');
    if (typeof removeSidecarFromCache === 'function') removeSidecarFromCache(normalized);
  } catch { /* status-cache optional */ }

  if (listChanged) {
    await writeSidecarList(filtered);
    logger.info('Sidecar removed from fleet (WS closed + blocked for 60s)', { url: normalized });
    return true;
  }
  return false;
}

// ─── Per-Sidecar Operations ──────────────────────────────────────────────────

/** Test connectivity and get health/status from a sidecar. */
export async function testSidecar(agentUrl: string): Promise<{
  reachable: boolean;
  mode: 'direct' | 'websocket' | null;
  health?: any;
  status?: SidecarStatus;
  error?: string;
}> {
  const normalized = agentUrl.replace(/\/+$/, '');

  // Try direct HTTP health check
  let directOk = false;
  let health: any;
  try {
    const res = await fetch(`${normalized}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      directOk = true;
      health = await res.json();
    }
  } catch {
    // Direct not reachable
  }

  // Try WS if direct failed
  const wsOk = !directOk && wsRelay.hasSidecarConnection(normalized);
  if (wsOk) {
    try {
      health = await wsRelay.sendCommand(normalized, { action: '/health' }, 5_000);
    } catch {
      // WS also failed
    }
  }

  const reachable = directOk || (wsOk && !!health);
  const mode = directOk ? 'direct' : wsOk ? 'websocket' : null;

  if (!reachable) {
    // Update DB entry status
    await updateEntryStatus(normalized, 'disconnected');
    return { reachable: false, mode: null, error: 'Sidecar unreachable via HTTP and WebSocket' };
  }

  // Get full status
  let status: SidecarStatus | undefined;
  try {
    status = await sendToSidecar(normalized, '/status');
  } catch {
    // Status endpoint optional
  }

  // Update DB entry
  await updateEntryStatus(normalized, 'connected', mode!, status);

  return { reachable, mode, health, status };
}

/** Start or stop a container on a sidecar. */
export async function controlContainer(
  agentUrl: string,
  action: 'start' | 'stop',
  role?: string,
): Promise<any> {
  const timeout = action === 'start' ? 15_000 : 30_000;
  const body = role ? { role } : undefined;
  return sendToSidecar(agentUrl, `/${action}`, body, 'POST', timeout);
}

/**
 * Record that this Sound Suite master just pushed config to a sidecar. Stamps
 * `selfLastConfigPushAt` in the status cache so the UI can compare against
 * the sidecar's reported `lastConfigPushAt` and flag overrides from other
 * masters in a multi-master setup.
 */
function markSelfConfigPush(agentUrl: string): void {
  const normalized = agentUrl.replace(/\/+$/, '');
  statusCache.updateSidecarStatus(normalized, { selfLastConfigPushAt: Date.now() });
}

/** Push idle timeout configuration to a sidecar (converts minutes to ms). */
export async function pushIdleTimeouts(agentUrl: string, timeouts: IdleTimeouts): Promise<any> {
  const result = await sendToSidecar(agentUrl, '/config', {
    idleTimeouts: {
      embedding: timeouts.embedding * 60_000,
      completion: timeouts.completion * 60_000,
      ocr: timeouts.ocr * 60_000,
      reranker: timeouts.reranker * 60_000,
    },
  });
  markSelfConfigPush(agentUrl);
  return result;
}

/**
 * Detect the sidecar's reported hostOs from the status cache. Returns
 * 'unknown' when the sidecar has not yet reported a host block.
 *
 * Windows hosts with WSL2 + NVIDIA Container Toolkit behave like Linux for
 * Docker-GPU purposes (`docker run --gpus` works against the WSL2 VM). After
 * the windows-docker-wsl2 rename, every windows-docker-wsl2 sidecar
 * unconditionally gets the linux-style docker registry — the hasNvidiaSmi
 * gate is gone. Legacy values (`win32`/`darwin`) reported by old sidecars
 * are migrated on the fly to their new identifiers.
 */
function detectHostOs(agentUrl: string): 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | 'unknown' {
  const cached = statusCache.getSidecarStatus(agentUrl);
  const os = cached?.host?.os;
  if (os === 'linux') return 'linux';
  if (os === 'mac-docker-ollama') return 'mac-docker-ollama';
  if (os === 'windows-docker-wsl2') return 'windows-docker-wsl2';
  if (os === 'win32') return 'windows-docker-wsl2';
  if (os === 'darwin') return 'mac-docker-ollama';
  return 'unknown';
}

/**
 * Model-aware per-host mode gate. The effective model passed in already
 * folds in the per-host modelOverride, so a Mac host pinned to e.g.
 * minicpm-v stays eligible for ss-ocr even while the global OCR model is
 * PaddleOCR-VL — and vice versa: a Mac host is dropped when its effective
 * model is Docker-only (no Mac serving path; Docker Desktop on Mac has no
 * GPU passthrough).
 */
function modeAllowedOnHost(
  mode: string,
  effectiveModel: string | undefined,
  hostOs: 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | 'unknown',
): boolean {
  if (mode === 'ss-ocr' && hostOs === 'mac-docker-ollama' && !ocrModelCaps(effectiveModel).macCompatible) {
    return false;
  }
  return true;
}

/**
 * Filter enabledModes to what this host can actually serve given the
 * effective (override-aware) model per mode. Logs any drops so an operator
 * can see why a Mac sidecar stopped receiving ss-ocr.
 */
function filterModesForHost(
  agentUrl: string,
  enabledModes: string[],
  effectiveModels: Record<string, string>,
  hostOs: 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | 'unknown',
): string[] {
  const allowed = enabledModes.filter((m) => modeAllowedOnHost(m, effectiveModels[m], hostOs));
  const dropped = enabledModes.filter((m) => !allowed.includes(m));
  if (dropped.length > 0) {
    logger.warn('Dropping model-incompatible modes for host', {
      agent: agentUrl,
      hostOs,
      dropped: dropped.map((m) => `${m}=${effectiveModels[m]}`),
    });
  }
  return allowed;
}

/**
 * Build a legacy `registry: { role: ContainerDef }` payload from a set of
 * enabled modes + per-mode overrides + the host's OS. Mirrors the sidecar's
 * mode-templates.resolveMode() so old sidecars (pre-2.3) that only
 * understand the legacy shape still get a coherent definition.
 *
 * Skips modes that are unavailable on the given OS (e.g. ss-reranker on
 * mac-docker-ollama). Returns short role keys (`embedding`, `completion`, ...)
 * matching the sidecar's internal registry keys.
 */
function buildLegacyRegistry(
  enabledModes: string[],
  effectiveModelFor: (mode: string) => string,
  hostOs: 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | 'unknown',
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  // windows-docker-wsl2 ships the same docker-runtime registry as linux —
  // Docker WSL2 has native NVIDIA passthrough.
  const isLinux = hostOs === 'linux' || hostOs === 'windows-docker-wsl2';
  for (const mode of enabledModes) {
    const role = mode.replace(/^ss-/, '');
    // Task #36: when hostOs is 'unknown' (low confidence / detection not yet
    // settled), skip the registry entry entirely. The next push will retry
    // once detection completes — otherwise we'd misclassify unknown as Mac
    // (host-runtime) and stamp a definitive runtime decision on shaky ground.
    if (hostOs === 'unknown') {
      logUnknownHostOsSkipOnce(role);
      continue;
    }
    const model = effectiveModelFor(mode);
    const containerName = `ss-${role}`;
    // Task #34 (Option A): for host-runtime (Mac) modes, stamp image:'host-ollama'
    // rather than ''. Any downstream code that accidentally tries to pull will
    // short-circuit on the sidecar's pullImage('') guard, and the host-runtime
    // detection (image === 'host-ollama') keeps working at every layer.
    switch (mode) {
      case 'ss-embedding':
        out[role] = isLinux
          ? { image: 'ollama/ollama', model, port: 11434, vram: 1200, type: 'ollama', modes: ['indexing', 'searching'], containerName, priority: 'high' }
          : { image: 'host-ollama', model, port: 11434, vram: 1200, type: 'ollama', modes: ['indexing', 'searching'], containerName, priority: 'high', runtime: 'host' };
        break;
      case 'ss-completion':
        out[role] = isLinux
          ? { image: 'ollama/ollama', model, port: 11435, vram: 10000, type: 'ollama', modes: ['searching'], containerName, priority: 'normal' }
          : { image: 'host-ollama', model, port: 11434, vram: 10000, type: 'ollama', modes: ['searching'], containerName, priority: 'normal', runtime: 'host' };
        break;
      case 'ss-ocr':
        out[role] = isLinux
          ? { image: 'ollama/ollama', model, port: 11436, vram: 8000, type: 'ollama', modes: ['indexing'], containerName, gpuOnly: true, priority: 'critical' }
          : { image: 'host-ollama', model, port: 11434, vram: 8000, type: 'ollama', modes: ['indexing'], containerName, priority: 'critical', runtime: 'host' };
        break;
      case 'ss-reranker':
        if (!isLinux) break; // unavailable on mac-docker-ollama
        out[role] = { image: 'vllm/vllm-openai', model, port: 8099, vram: 7000, type: 'vllm', modes: ['searching'], containerName, priority: 'normal' };
        break;
    }
  }
  return out;
}

/**
 * Build the effective `modelOverrides` map pushed to the sidecar. The
 * master is now authoritative for default models — for every enabled
 * mode without an explicit per-host override row, we fold in the
 * operator-set Config value (set via /admin/embedding, /admin/ocr, etc.).
 *
 * Older sidecars (pre-2.3.x) that don't understand `enabledModes` still
 * receive the right model via the legacy `registry` payload built from
 * the same effective map. Newer sidecars apply `modelOverrides[mode]` on
 * top of their own resolveMode() boot defaults — and since we send the
 * effective value for EVERY enabled mode, the sidecar's hardcoded fallback
 * in mode-templates.ts is only ever the boot-time pre-push state.
 */
function buildEffectiveModelMap(
  enabledModes: string[],
  perHostOverrides: Record<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cfg: any,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const mode of enabledModes) {
    const explicit = perHostOverrides[mode];
    if (explicit && explicit.trim()) {
      out[mode] = explicit.trim();
    } else {
      out[mode] = resolveModelFromConfig(mode as ModeName, cfg);
    }
  }
  return out;
}

/**
 * Per-role vLLM --gpu-memory-utilization map pushed to the sidecar. Only
 * vLLM-served roles have this lever; the sidecar splices it into the role's
 * vllmArgs after resolveMode(). Operator-tuned on /admin/* and stored as
 * global config keys (gpu.memUtil.*).
 */
function buildGpuMemUtils(cfg: Awaited<ReturnType<typeof getConfig>>): Record<string, number> {
  // Reranker: ALWAYS push the effective value (operator-set, else the 0.85
  // default). The reranker is master-authoritative, and always pushing ensures
  // the default actually reaches a sidecar that persisted an older value from a
  // previous build — otherwise a stale config.json (e.g. 0.6) sticks and the
  // shipped default never takes effect. Keep in sync with
  // mode-templates.ts:RERANKER_VLLM_ARGS.
  //
  // RLM: omit-when-unset — its template default is a deliberately-tuned 0.9 and
  // a reranker-only change must NOT silently re-tune rlm down.
  const out: Record<string, number> = {
    reranker: typeof cfg.gpuMemUtilReranker === 'number' ? cfg.gpuMemUtilReranker : 0.85,
  };
  if (typeof cfg.gpuMemUtilRlm === 'number') out.rlm = cfg.gpuMemUtilRlm;
  return out;
}

/**
 * Push the per-host effective registry to a sidecar.
 *
 * Driven by the DB-backed HostRoleAssignment table. The sidecar uses this
 * payload to ADD or UPDATE roles AND (post-2.3) REMOVE any non-utility role
 * not in the enabled list.
 *
 * Defense in depth:
 *   1. If this sidecar has zero assignments yet, seed the OS-appropriate
 *      defaults first so the first push isn't an empty payload.
 *   2. Send BOTH the new {enabledModes, modelOverrides} shape AND a legacy
 *      `registry: {...}` mirror so pre-2.3 sidecars get a usable payload.
 *      Newer sidecars prefer the new shape and ignore `registry`.
 */
export async function pushModelRegistry(agentUrl: string): Promise<any> {
  // Seed on demand for fresh sidecars so the first push isn't empty.
  const hostOs = detectHostOs(agentUrl);
  try {
    const seeded = await seedAssignmentsForHost(agentUrl, hostOs);
    if (seeded > 0) {
      logger.info(`Seeded ${seeded} default assignments for ${agentUrl} (hostOs=${hostOs}) before first config push`);
    }
  } catch (err) {
    logger.warn(`On-demand seed failed for ${agentUrl}: ${(err as Error).message}`);
  }

  const allModes = await getEnabledModesForHost(agentUrl);
  const perHostOverrides = await getModelOverridesForHost(agentUrl);
  const runtimes = await getRuntimesForHost(agentUrl, hostOs);
  const cfg = await getConfig();
  // Master is now authoritative for default models: fold the operator-set
  // value from /admin/* into modelOverrides for every enabled mode that
  // doesn't have an explicit per-host override. Sidecar applies these on
  // top of its own resolveMode() boot defaults.
  const allEffectiveModels = buildEffectiveModelMap(allModes, perHostOverrides, cfg);
  // Model-aware gate: e.g. ss-ocr with a Docker-only effective model
  // (PaddleOCR-VL) is never pushed to Mac hosts.
  const enabledModes = filterModesForHost(agentUrl, allModes, allEffectiveModels, hostOs);
  const effectiveModels = Object.fromEntries(enabledModes.map((m) => [m, allEffectiveModels[m]]));
  const registry = buildLegacyRegistry(enabledModes, (m) => effectiveModels[m], hostOs);
  // Per-host minOnline + idleTimeouts MUST ride along — the sidecar's
  // /acquire gate (`Role "X" is disabled (minOnline=0)`) reads from
  // state.minOnline, which is only updated by /config payloads that include
  // the field. Without this, toggling a role on in the admin UI persists in
  // the master DB but never propagates to the sidecar, so the role refuses
  // to start with "minOnline=0". See: BASWS34 ss-reranker 2026-05-12.
  const dbMin = await getEffectiveMinOnline(agentUrl);
  const dbIdle = await getEffectiveIdleTimeoutsMs(agentUrl);
  logger.info('Pushing per-host mode set to sidecar', {
    agent: agentUrl,
    hostOs,
    enabledModes,
    perHostOverrides: Object.keys(perHostOverrides),
    effectiveModels,
    legacyRoles: Object.keys(registry),
    minOnline: dbMin,
  });
  // Per-host operator override for the sidecar's hostOs (Mac/Win/Linux).
  // Lets the operator pin `state.hostOs` when auto-detection guesses wrong.
  const provisioning = await getProvisioning(agentUrl).catch(() => null);
  const hostOsOverride = provisioning?.hostOsOverride ?? null;

  const result = await sendToSidecar(agentUrl, '/config', {
    enabledModes,
    modelOverrides: effectiveModels,
    runtimes,
    registry,
    minOnline: dbMin,
    idleTimeouts: dbIdle,
    gpuMemUtils: buildGpuMemUtils(cfg),
    rerankEnforceEager: cfg.rerankEnforceEager,
    hostOsOverride,
  });
  markSelfConfigPush(agentUrl);
  return result;
}

/**
 * Push the full per-host config — registry, idle timeouts, minOnline — in
 * one /config call. Falls back to global config keys for roles that have no
 * per-host assignment, preserving back-compat for built-in role names.
 */
export async function pushFullConfig(agentUrl: string, timeouts: IdleTimeouts): Promise<any> {
  // Seed on demand for fresh sidecars so the first push isn't empty.
  const hostOs = detectHostOs(agentUrl);
  try {
    const seeded = await seedAssignmentsForHost(agentUrl, hostOs);
    if (seeded > 0) {
      logger.info(`Seeded ${seeded} default assignments for ${agentUrl} (hostOs=${hostOs}) before first full-config push`);
    }
  } catch (err) {
    logger.warn(`On-demand seed (full-config) failed for ${agentUrl}: ${(err as Error).message}`);
  }

  const allModes = await getEnabledModesForHost(agentUrl);
  const perHostOverrides = await getModelOverridesForHost(agentUrl);
  const runtimes = await getRuntimesForHost(agentUrl, hostOs);
  const cfg = await getConfig();
  const allEffectiveModels = buildEffectiveModelMap(allModes, perHostOverrides, cfg);
  // Model-aware gate — same filter as pushModelRegistry.
  const enabledModes = filterModesForHost(agentUrl, allModes, allEffectiveModels, hostOs);
  const effectiveModels = Object.fromEntries(enabledModes.map((m) => [m, allEffectiveModels[m]]));
  const registry = buildLegacyRegistry(enabledModes, (m) => effectiveModels[m], hostOs);
  const dbIdle = await getEffectiveIdleTimeoutsMs(agentUrl);
  const dbMin = await getEffectiveMinOnline(agentUrl);

  // Global-config fallback layer (legacy keys, keyed by short role name).
  // Per-host DB values win.
  const idleTimeouts: Record<string, number> = {
    embedding: timeouts.embedding * 60_000,
    'code-embedding': (cfg.gpuIdleCodeEmbeddingMin ?? 5) * 60_000,
    completion: timeouts.completion * 60_000,
    ocr: timeouts.ocr * 60_000,
    reranker: timeouts.reranker * 60_000,
    ...dbIdle,
  };
  const minOnline: Record<string, number> = {
    embedding: cfg.gpuMinEmbedding ?? 1,
    'code-embedding': cfg.gpuMinCodeEmbedding ?? 0,
    completion: cfg.gpuMinCompletion ?? 0,
    ocr: cfg.gpuMinOcr ?? 1,
    reranker: cfg.gpuMinReranker ?? 1,
    ...dbMin,
  };

  // Per-host operator override for the sidecar's hostOs detection.
  const provisioning = await getProvisioning(agentUrl).catch(() => null);
  const hostOsOverride = provisioning?.hostOsOverride ?? null;

  const result = await sendToSidecar(agentUrl, '/config', {
    idleTimeouts,
    minOnline,
    enabledModes,
    modelOverrides: effectiveModels,
    runtimes,
    registry,
    gpuMemUtils: buildGpuMemUtils(cfg),
    rerankEnforceEager: cfg.rerankEnforceEager,
    hostOsOverride,
  });
  markSelfConfigPush(agentUrl);
  return result;
}

/**
 * Stop and restart the reranker container on every sidecar assigned the
 * ss-reranker role, applying current config. Used when a container-affecting
 * reranker setting (gpu-memory-utilization, enforce-eager, model) changes —
 * so the new vLLM start args take effect immediately rather than lazily on the
 * next search via drift detection.
 *
 * Per sidecar: push the latest registry (so its state.registry has the new
 * vllmArgs) → /stop → wait → /start. The sidecar's /start runs ensureContainer,
 * which detects the changed Cmd and RECREATES the container with the new args.
 * Sidecars run in parallel; each failure is isolated and logged. Fire-and-forget
 * from callers — a cold reranker start can take 30-60s.
 */
export async function restartRerankerOnAssignedSidecars(): Promise<{ restarted: string[]; failed: string[] }> {
  const restarted: string[] = [];
  const failed: string[] = [];
  let urls: string[];
  try {
    const { listAllAssignments } = await import('@/lib/db/role-registry');
    const rows = await listAllAssignments();
    urls = Array.from(new Set(
      rows
        .filter((r) => r.mode === 'ss-reranker' && r.enabled)
        .map((r) => r.sidecarUrl.replace(/\/+$/, '')),
    ));
  } catch (err) {
    logger.warn('restartReranker: assignment lookup failed', { error: (err as Error).message });
    return { restarted, failed };
  }
  if (urls.length === 0) {
    logger.info('restartReranker: no sidecars assigned ss-reranker — nothing to restart');
    return { restarted, failed };
  }
  logger.info('restartReranker: restarting reranker to apply new settings', { sidecars: urls });
  await Promise.all(urls.map(async (url) => {
    try {
      // Push the updated registry FIRST so /start recreates with the new args.
      await pushModelRegistry(url);
      await sendToSidecar(url, '/stop', { role: 'reranker' }, 'POST', 30_000);
      await new Promise((r) => setTimeout(r, 5_000));
      await sendToSidecar(url, '/start', { role: 'reranker' }, 'POST', 60_000);
      restarted.push(url);
      logger.info(`restartReranker: reranker restarted on ${url}`);
    } catch (err) {
      failed.push(url);
      logger.warn(`restartReranker: failed on ${url}`, { error: (err as Error).message });
    }
  }));
  return { restarted, failed };
}

// ─── Smart Routing ───────────────────────────────────────────────────────────

/** Default container port per role (must match sideCar/server.js registry). */
const ROLE_PORTS: Record<GpuRole, number> = {
  embedding: 11434,
  completion: 11435,
  ocr: 11436,
  reranker: 8099,
};

/**
 * Resolve the best endpoint for a given GPU role.
 *
 * Algorithm:
 * 1. Find sidecars with a running container for this role → pick least loaded
 * 2. If none running, pick any reachable sidecar → send /acquire {role}
 * 3. Return host:port derived from sidecar IP + role port mapping
 */
export async function resolveEndpoint(role: GpuRole, options?: { excludeHosts?: string[] }): Promise<ResolvedEndpoint> {
  const fleet = await getFleetStatus();
  const port = ROLE_PORTS[role];
  // Per-sidecar port lookup: the role catalog (buildRoleCatalog) advertises
  // a different port for host-Ollama mode (11434, native macOS) vs. the
  // Docker container modes (11435/6 on Linux). ROLE_PORTS is the Linux-only
  // default; the actual cached container config carries the right value for
  // the sidecar's actual runtime. Fall back to ROLE_PORTS when the sidecar
  // hasn't reported state yet.
  const portFor = (sidecar: FleetSidecar): number => {
    const cached = statusCache.getSidecarStatus(sidecar.url);
    const cfgPort = cached?.containers?.[role]?.config?.port;
    return typeof cfgPort === 'number' && cfgPort > 0 ? cfgPort : port;
  };
  const exclude = new Set(options?.excludeHosts ?? []);
  const isExcluded = (sidecarUrl: string): boolean => {
    if (exclude.size === 0) return false;
    try {
      const h = new URL(sidecarUrl).hostname;
      return exclude.has(h) || exclude.has(`http://${h}:${port}`) || exclude.has(sidecarUrl);
    } catch { return false; }
  };

  // Try sidecars that are connected/reachable
  let reachable = fleet.sidecars.filter(s => s.status === 'connected' && !isExcluded(s.url));

  // Reranker-specific health filtering: the watchdog tracks deep-health
  // (real /v1/rerank probe) and marks deadlocked or restarting hosts so we
  // never route real rerank traffic to them. See reranker-watchdog.ts.
  // Skip: unhealthy | restarting | chronic-unhealthy
  // Allow but de-prioritize: cooldown
  // Allow (logged): suspect
  if (role === 'reranker' && reachable.length > 0) {
    try {
      const { getRerankerHostHealth } = await import('@/lib/search/reranker-watchdog');
      const health = getRerankerHostHealth();
      const blocked = new Set(['unhealthy', 'restarting', 'chronic-unhealthy']);
      const filtered = reachable.filter(s => {
        const st = health[s.url];
        if (st && blocked.has(st)) {
          logger.info(`Route: skipping ${s.hostname} for reranker — watchdog state=${st}`);
          return false;
        }
        if (st === 'suspect') {
          logger.info(`Route: ${s.hostname} reranker state=suspect (still allowed)`);
        }
        return true;
      });
      // De-prioritize cooldown hosts: move them to the end.
      const healthy = filtered.filter(s => health[s.url] !== 'cooldown');
      const cooldown = filtered.filter(s => health[s.url] === 'cooldown');
      reachable = [...healthy, ...cooldown];
    } catch {
      // Watchdog not yet initialized — proceed without filtering.
    }
  }

  // gpuOnly is enforced at the role level. The sidecar registry is the source
  // of truth (sideCar/src/lib/state.ts); we mirror the well-known set here as
  // a cold-path guard so that on first boot / cache miss / stale cache the
  // master still refuses CPU offload for OCR. If any sidecar additionally
  // advertises gpuOnly for this role at runtime, that also flips the flag.
  const GPU_ONLY_ROLES: ReadonlySet<string> = new Set(['ocr']);
  let roleIsGpuOnly = GPU_ONLY_ROLES.has(role);
  if (!roleIsGpuOnly) {
    for (const sidecar of reachable) {
      const cached = statusCache.getSidecarStatus(sidecar.url);
      const c = cached?.containers?.[role];
      if (c?.config?.gpuOnly === true) {
        roleIsGpuOnly = true;
        break;
      }
    }
  }

  // Phase 1: Find sidecar already running this role's container (from cache — no push)
  // Prefer fully GPU-loaded models over CPU-offloaded ones
  let bestSidecar: FleetSidecar | null = null;
  let bestLoad = Infinity;
  let bestGpuPct = -1;
  let cpuOffloadedFallback: FleetSidecar | null = null;
  let cpuOffloadedLoad = Infinity;
  let cpuOffloadedGpuPct = 0;

  for (const sidecar of reachable) {
    const cached = statusCache.getSidecarStatus(sidecar.url);
    if (!cached) continue;
    const container = cached.containers?.[role];
    if (container?.status !== 'running') continue;

    // Belt-and-suspenders for gpuOnly: the sidecar may have already flagged
    // gpuReady=false for this container (e.g. partial offload it couldn't fix).
    // Skip such sidecars entirely so we never route to them.
    if (roleIsGpuOnly && container.gpuReady === false) continue;

    // Model-aware OS guard: never route OCR to a Mac whose effective model
    // is Docker-only (e.g. PaddleOCR-VL). Config pushes already drop such
    // modes, but a stale assignment/container from before a model switch
    // could still report 'running' — the container config carries the model
    // the sidecar actually serves.
    if (role === 'ocr') {
      const os = cached.host?.os;
      const isMac = os === 'mac-docker-ollama' || os === 'darwin';
      const servedModel = (container as { config?: { model?: string } }).config?.model;
      if (isMac && servedModel && !ocrModelCaps(servedModel).macCompatible) {
        logger.info(`Route: skipping ${sidecar.hostname} for ocr — model "${servedModel}" is Docker-only, host is Mac`);
        continue;
      }
    }

    const load = cached.roles?.[role]?.activeRequests ?? cached.activeRequests ?? 0;

    // Check GPU offload status from loaded models
    const loadedModels = container.loadedModels;
    const gpuPct = loadedModels?.[0]?.gpuPercent ?? (loadedModels?.[0]?.processor === 'GPU' ? 100 : loadedModels?.length ? 0 : -1);

    if (gpuPct >= 99) {
      // Fully GPU-loaded — prefer this, pick by lowest load
      if (load < bestLoad || (load === bestLoad && gpuPct > bestGpuPct)) {
        bestLoad = load;
        bestGpuPct = gpuPct;
        bestSidecar = sidecar;
      }
    } else if (gpuPct >= 0) {
      // CPU-offloaded — track as fallback only (and never accept for gpuOnly roles)
      if (!roleIsGpuOnly && load < cpuOffloadedLoad) {
        cpuOffloadedLoad = load;
        cpuOffloadedGpuPct = gpuPct;
        cpuOffloadedFallback = sidecar;
      }
    } else {
      // No GPU info (gpuPct === -1) — treat same as full GPU (unknown is ok)
      if (load < bestLoad) {
        bestLoad = load;
        bestGpuPct = -1;
        bestSidecar = sidecar;
      }
    }
  }

  // Use CPU-offloaded fallback only if no fully GPU-loaded sidecar available
  // AND the role does not require GPU-only execution.
  if (!bestSidecar && cpuOffloadedFallback && !roleIsGpuOnly) {
    bestSidecar = cpuOffloadedFallback;
    bestLoad = cpuOffloadedLoad;
    bestGpuPct = cpuOffloadedGpuPct;
    logger.warn(`Route: ${role} — no fully GPU-loaded sidecar available, using CPU-offloaded fallback (GPU ${cpuOffloadedGpuPct}%)`, {
      role,
      sidecar: cpuOffloadedFallback.hostname,
      gpuPercent: cpuOffloadedGpuPct,
    });
  }

  // gpuOnly + no fully-GPU candidate AND no fallback we can take. Do not
  // attempt phase 2/3 acquire either — those would just spin up the container
  // somewhere with no guarantee of full GPU. Throw so the caller (worker or
  // OCR engine) can pause and retry once the sidecar watchdog frees VRAM.
  if (!bestSidecar && roleIsGpuOnly) {
    const summary = reachable.map(s => {
      const cached = statusCache.getSidecarStatus(s.url);
      const c = cached?.containers?.[role];
      const status = c?.status ?? 'no-container';
      const gpuReady = c?.gpuReady;
      const lm = c?.loadedModels?.[0];
      const pct = lm?.gpuPercent ?? (lm?.processor === 'GPU' ? 100 : lm ? 0 : -1);
      return `${s.hostname}(status=${status},gpuReady=${gpuReady},gpu%=${pct})`;
    }).join(', ');
    const reason = `no GPU-ready sidecar for ${role}; candidates: [${summary}]`;
    logger.warn(`Route: ${role} — refusing CPU-offload (gpuOnly). ${reason}`);
    const { NoGpuReadyEndpointError } = await import('@/lib/gpu/errors');
    throw new NoGpuReadyEndpointError(role, reason);
  }

  if (bestSidecar) {
    const hostname = new URL(bestSidecar.url).hostname;
    const resolvedPort = portFor(bestSidecar);
    // Send acquire to register the request + reset idle timer
    try {
      await sendToSidecar(bestSidecar.url, '/acquire', { role });
    } catch {
      // Non-critical — container already running
    }
    const gpuInfo = bestGpuPct >= 0 ? `, gpu=${bestGpuPct}%` : '';
    logger.info(`Route resolved: ${role} → ${bestSidecar.hostname} (${hostname}:${resolvedPort}), container=running, load=${bestLoad}${gpuInfo}`, {
      phase: 1,
      role,
      sidecar: bestSidecar.hostname,
      host: `http://${hostname}:${resolvedPort}`,
      containerStatus: 'running',
      activeRequests: bestLoad,
      gpuPercent: bestGpuPct,
    });
    return { host: `http://${hostname}:${resolvedPort}`, sidecarUrl: bestSidecar.url, role };
  }

  // Phase 2: No running container — pick first reachable sidecar and acquire
  const errors: string[] = [];
  for (const sidecar of reachable) {
    try {
      const result = await sendToSidecar(sidecar.url, '/acquire', { role });
      if (!result.error) {
        const hostname = new URL(sidecar.url).hostname;
        const resolvedPort = portFor(sidecar);
        logger.info(`Route resolved: ${role} → ${sidecar.hostname} (${hostname}:${resolvedPort}), container=acquired, action=${result.action}`, {
          phase: 2,
          role,
          sidecar: sidecar.hostname,
          host: `http://${hostname}:${resolvedPort}`,
          action: result.action,
        });
        return { host: `http://${hostname}:${resolvedPort}`, sidecarUrl: sidecar.url, role };
      }
      // Sidecar returned a result with an error field
      const errMsg = `${sidecar.hostname}: ${String(result.error).slice(0, 200)}`;
      errors.push(errMsg);
      logger.warn(`Route phase 2: ${sidecar.hostname} acquire returned error`, { role, error: result.error });
    } catch (err) {
      errors.push(`${sidecar.hostname}: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // Phase 3: Try all sidecars (including disconnected — they might respond to direct HTTP)
  for (const sidecar of fleet.sidecars) {
    if (reachable.includes(sidecar)) continue;
    if (isExcluded(sidecar.url)) continue;
    try {
      const result = await sendToSidecar(sidecar.url, '/acquire', { role });
      if (!result.error) {
        const hostname = new URL(sidecar.url).hostname;
        const resolvedPort = portFor(sidecar);
        logger.info(`Route resolved: ${role} → ${sidecar.hostname} (${hostname}:${resolvedPort}), container=acquired (was disconnected)`, {
          phase: 3,
          role,
          sidecar: sidecar.hostname,
          host: `http://${hostname}:${resolvedPort}`,
          action: result.action,
        });
        return { host: `http://${hostname}:${resolvedPort}`, sidecarUrl: sidecar.url, role };
      }
      const errMsg = `${sidecar.hostname}: ${String(result.error).slice(0, 200)}`;
      errors.push(errMsg);
      logger.warn(`Route phase 3: ${sidecar.hostname} acquire returned error`, { role, error: result.error });
    } catch (err) {
      errors.push(`${sidecar.hostname}: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  const sidecarSummary = fleet.sidecars.map(s => {
    const cached = statusCache.getSidecarStatus(s.url);
    const containerStatus = cached?.containers?.[role]?.status ?? 'unknown';
    return `${s.hostname}(${s.status},${role}=${containerStatus})`;
  }).join(', ');
  const errorDetail = errors.length > 0 ? ` Errors: [${errors.join('; ')}]` : '';
  logger.error(`Route failed: no sidecar for ${role}. Fleet: [${sidecarSummary}]${errorDetail}`);
  throw new Error(`No sidecar available for role "${role}" (${fleet.sidecars.length} registered, ${reachable.length} reachable).${errorDetail}`);
}

/**
 * Release an endpoint after use. Fire-and-forget.
 */
export function releaseEndpoint(role: GpuRole, sidecarUrl: string): void {
  sendToSidecar(sidecarUrl, '/release', { role }).catch((err) => {
    logger.warn(`Failed to release ${role} on ${sidecarUrl}`, { error: (err as Error).message });
  });
}

/** Get GPU info from a sidecar. */
export async function getSidecarGpus(agentUrl: string): Promise<GpuInfo[]> {
  try {
    const result = await sendToSidecar(agentUrl, '/gpu');
    return result.gpus || [];
  } catch {
    return [];
  }
}

/** Switch a sidecar's mode. */
export async function switchSidecarMode(agentUrl: string, mode: 'indexing' | 'searching'): Promise<any> {
  return sendToSidecar(agentUrl, '/mode', { mode }, 'POST', 30_000);
}

/** Trigger provisioning on a sidecar. */
export async function provisionSidecar(agentUrl: string): Promise<any> {
  return sendToSidecar(agentUrl, '/provision', {}, 'POST', 120_000);
}

/** Get all container states from a sidecar. */
export async function getSidecarContainers(agentUrl: string): Promise<any> {
  return sendToSidecar(agentUrl, '/containers');
}

// ─── Fleet Mode Distribution ─────────────────────────────────────────────────

/**
 * Distribute modes across the fleet so both indexing and searching are available.
 *
 * With a single sidecar: stays in whatever mode is configured (default: searching).
 * With 2+ sidecars: assign at least one to indexing so OCR/indexing is always ready.
 * Indexing has higher priority (more VRAM-constrained roles).
 *
 * Assignment strategy (for N sidecars):
 *   - 1 sidecar  → user-configured mode (manual switching)
 *   - 2 sidecars → 1 indexing + 1 searching
 *   - 3 sidecars → 1 indexing + 2 searching
 *   - 4+ sidecars → 1 indexing + rest searching (searching is more latency-sensitive)
 *
 * Only runs if gpu.autoModeDistribute is enabled (default: true when fleet has 2+ sidecars).
 */
async function distributeFleetModes(): Promise<void> {
  const config = await getConfig();
  if (!config.gpuAutoManage) return; // Only distribute if orchestrator is enabled

  const fleet = await getFleetStatus();
  const reachable = fleet.sidecars.filter(s => s.status === 'connected');
  if (reachable.length < 2) return; // Single sidecar — user manages mode manually

  // Get current modes from status cache
  const indexingSidecars: string[] = [];
  const searchingSidecars: string[] = [];
  const unknownSidecars: string[] = [];

  for (const sidecar of reachable) {
    const cached = statusCache.getSidecarStatus(sidecar.url);
    if (!cached) { unknownSidecars.push(sidecar.url); continue; }
    if (cached.mode === 'indexing') indexingSidecars.push(sidecar.url);
    else searchingSidecars.push(sidecar.url);
  }

  // Desired: at least 1 indexing, rest searching
  const hasIndexer = indexingSidecars.length > 0;
  const hasSearcher = searchingSidecars.length > 0;

  if (hasIndexer && hasSearcher) return; // Already balanced

  if (!hasIndexer && searchingSidecars.length >= 2) {
    // Pick the sidecar with the most free VRAM for indexing (OCR needs ~8GB)
    let bestUrl = searchingSidecars[0];
    let bestFreeVram = 0;
    for (const url of searchingSidecars) {
      const cached = statusCache.getSidecarStatus(url);
      const freeVram = cached?.gpus?.[0]?.memoryFree ?? 0;
      if (freeVram > bestFreeVram) {
        bestFreeVram = freeVram;
        bestUrl = url;
      }
    }
    logger.info(`Fleet mode distribution: switching ${bestUrl} to indexing (${indexingSidecars.length} indexing, ${searchingSidecars.length} searching)`);
    try {
      await switchSidecarMode(bestUrl, 'indexing');
    } catch (err) {
      logger.warn(`Fleet mode distribution: failed to switch ${bestUrl} to indexing`, { error: (err as Error).message });
    }
  } else if (!hasSearcher && indexingSidecars.length >= 2) {
    // All in indexing — switch one to searching
    const switchUrl = indexingSidecars[indexingSidecars.length - 1]; // Keep first as indexing
    logger.info(`Fleet mode distribution: switching ${switchUrl} to searching`);
    try {
      await switchSidecarMode(switchUrl, 'searching');
    } catch (err) {
      logger.warn(`Fleet mode distribution: failed to switch ${switchUrl} to searching`, { error: (err as Error).message });
    }
  }

  // Assign unknown sidecars — put them in whichever mode needs more instances
  for (const url of unknownSidecars) {
    const targetMode = indexingSidecars.length === 0 ? 'indexing' : 'searching';
    logger.info(`Fleet mode distribution: assigning new sidecar ${url} to ${targetMode}`);
    try {
      await switchSidecarMode(url, targetMode);
      if (targetMode === 'indexing') indexingSidecars.push(url);
      else searchingSidecars.push(url);
    } catch (err) {
      logger.warn(`Fleet mode distribution: failed to assign ${url}`, { error: (err as Error).message });
    }
  }
}

// ─── Minimum Online Enforcement ──────────────────────────────────────────────

export interface MinOnlineConfig {
  embedding: number;
  completion: number;
  ocr: number;
  reranker: number;
}

let minOnlineInterval: ReturnType<typeof setInterval> | null = null;

/** Start the 30-second enforcement loop for minimum online instances + mode distribution. */
export function startMinOnlineEnforcement(): void {
  if (minOnlineInterval) return;
  logger.info('Starting minimum-online enforcement loop (30s interval)');
  runEnforcementTick().catch(err => logger.warn('Initial enforcement failed', { error: (err as Error).message }));
  minOnlineInterval = setInterval(() => {
    runEnforcementTick().catch(err => logger.warn('Enforcement tick failed', { error: (err as Error).message }));
  }, 30_000);
}

async function runEnforcementTick(): Promise<void> {
  // 1. Distribute modes across fleet (if 2+ sidecars)
  await distributeFleetModes();
  // 2. Enforce minimum online instances per role
  await enforceMinOnline();
}

/** Stop the enforcement loop. */
export function stopMinOnlineEnforcement(): void {
  if (minOnlineInterval) {
    clearInterval(minOnlineInterval);
    minOnlineInterval = null;
    logger.info('Stopped minimum-online enforcement loop');
  }
}

/** Core enforcement: ensure minimum running containers per role across fleet. */
async function enforceMinOnline(): Promise<void> {
  const config = await getConfig();
  const globalMins: Record<string, number> = {
    embedding: config.gpuMinEmbedding ?? 0,
    'code-embedding': config.gpuMinCodeEmbedding ?? 0,
    completion: config.gpuMinCompletion ?? 0,
    ocr: config.gpuMinOcr ?? 0,
    reranker: config.gpuMinReranker ?? 0,
  };

  // VRAM requirements for roles that need GPU
  const ROLE_VRAM_NEEDS: Record<string, number> = {
    completion: 10000,
    reranker: 7000,
    embedding: 1200,
    'code-embedding': 2000,
    ocr: 8000,
  };

  // BUG 2 FIX: iterate per-host assignments (not global × all reachable).
  // Only consider rows the operator has actually enabled. Group by sidecar
  // so we issue at most one /acquire per (host, role) per tick.
  const allAssignments = await listAllAssignments();
  const enabled = allAssignments.filter(a => a.enabled === true);
  if (enabled.length === 0) return;

  const fleet = await getFleetStatus();
  const reachableUrls = new Set(
    fleet.sidecars.filter(s => s.status === 'connected').map(s => s.url),
  );
  if (reachableUrls.size === 0) return;

  for (const assignment of enabled) {
    const role = assignment.mode.replace(/^ss-/, '');
    if (!['embedding', 'code-embedding', 'completion', 'ocr', 'reranker'].includes(role)) continue;

    // Operator opt-out wins: if per-host minOnline=0, the sidecar's HARD
    // disabled-policy will reject /acquire anyway — don't generate noise.
    if (assignment.minOnline <= 0) continue;

    const globalMin = globalMins[role] ?? 0;
    const effectiveMin = Math.max(globalMin, assignment.minOnline);
    if (effectiveMin <= 0) continue;

    const sidecarUrl = assignment.sidecarUrl;
    if (!reachableUrls.has(sidecarUrl)) continue;

    const cached = statusCache.getSidecarStatus(sidecarUrl);
    if (!cached) continue;

    // BUG 1 FIX: host-runtime synthetic 'running' lies — the sidecar reports
    // status:'running' for host-ollama regardless of whether the model is
    // actually keep_alive'd in Ollama. Require vram.perRole[role].loaded===true
    // before treating a host-ollama role as satisfied.
    const container = cached.containers?.[role];
    const containerStatus = container?.status;
    const isHostRuntime = container?.image === 'host-ollama';
    const vramLoaded = cached.vram?.perRole?.[role]?.loaded === true;

    const reallyRunning =
      containerStatus === 'running' && (!isHostRuntime || vramLoaded);

    if (reallyRunning) continue; // satisfied for this (host, role)

    // Skip /acquire for docker-runtime roles when the sidecar can't talk to
    // Docker at all (no /var/run/docker.sock mount). The sidecar's preflight
    // would reject every attempt with "Sidecar lacks /var/run/docker.sock" —
    // firing it every 30s just spams the master log. Detection: sidecar
    // reports host.dockerMode === 'none'. Host-runtime roles aren't affected
    // (they don't need Docker access at all).
    // dockerMode is at the TOP level of /api/status (not nested under `host`).
    // Sidecar reports 'socket' / 'tcp' / 'none' from getDockerMode().
    const dockerMode = (cached as { dockerMode?: string }).dockerMode;
    if (dockerMode === 'none' && !isHostRuntime) {
      logDockerModeNoneSkip(sidecarUrl, role);
      continue;
    }

    // VRAM safety: don't try to acquire if the host clearly can't fit the role.
    const vramNeeded = ROLE_VRAM_NEEDS[role] || 0;
    const freeVram = cached.freeVram ?? Infinity; // no data = assume ok
    if (vramNeeded > 0 && freeVram < vramNeeded * 0.5) {
      logger.info(
        `min-online: skipping ${sidecarUrl} for ${role} — need ${vramNeeded}MB but only ${freeVram}MB free VRAM`,
      );
      continue;
    }

    // Task #31: per-(sidecar, role) back-off. After repeated failures, skip
    // silently (with throttled INFO log) rather than hammering /acquire every
    // 5s tick.
    if (shouldSkipAcquire(sidecarUrl, role)) {
      maybeLogAcquireSkip(sidecarUrl, role);
      continue;
    }

    logger.info(
      `Enforce min-online: deficit role=${role} host=${sidecarUrl} effectiveMin=${effectiveMin} containerStatus=${containerStatus ?? 'none'} hostRuntime=${isHostRuntime} loaded=${vramLoaded}`,
    );

    try {
      const result = await sendToSidecar(sidecarUrl, '/acquire', { role });
      // Treat explicit ok:false as failure for back-off purposes (matches the
      // pattern used elsewhere in this file — see acquireForRole callers).
      if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false) {
        recordAcquireFailure(sidecarUrl, role);
        logger.warn(`min-online: /acquire returned ok:false for ${role} on ${sidecarUrl}`, {
          result,
        });
      } else {
        recordAcquireSuccess(sidecarUrl, role);
        logger.info(`min-online: acquired ${role} on ${sidecarUrl}`);
      }
    } catch (err) {
      recordAcquireFailure(sidecarUrl, role);
      logger.warn(`min-online: failed to acquire ${role} on ${sidecarUrl}`, {
        error: (err as Error).message,
      });
    }
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Update a sidecar entry's status in the DB list. */
async function updateEntryStatus(
  url: string,
  status: 'connected' | 'disconnected',
  mode?: 'direct' | 'websocket',
  sidecarStatus?: SidecarStatus,
): Promise<void> {
  const list = await readSidecarList();
  const entry = list.find(s => s.url === url);
  if (!entry) return;

  entry.status = status;
  entry.lastSeen = new Date().toISOString();
  if (mode) entry.mode = mode;
  if (sidecarStatus?.container) {
    // Update containers list if we have status info
    const containerStatus = sidecarStatus.container.status;
    if (containerStatus && containerStatus !== 'not_found') {
      entry.containers = [sidecarStatus.container.image || 'unknown'];
    }
  }

  await writeSidecarList(list);
}
