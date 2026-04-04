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

const logger = createLogger('FleetRouter');

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

/** Remove a sidecar from the fleet registry. */
export async function removeSidecar(url: string): Promise<boolean> {
  const list = await readSidecarList();
  const normalized = url.replace(/\/+$/, '');
  const filtered = list.filter(s => s.url !== normalized);

  if (filtered.length === list.length) return false;

  await writeSidecarList(filtered);
  logger.info('Sidecar removed from fleet', { url: normalized });
  return true;
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

/** Push idle timeout configuration to a sidecar (converts minutes to ms). */
export async function pushIdleTimeouts(agentUrl: string, timeouts: IdleTimeouts): Promise<any> {
  return sendToSidecar(agentUrl, '/config', {
    idleTimeouts: {
      embedding: timeouts.embedding * 60_000,
      completion: timeouts.completion * 60_000,
      ocr: timeouts.ocr * 60_000,
      reranker: timeouts.reranker * 60_000,
    },
  });
}

/** Build a model registry object from current admin config. */
async function buildModelRegistry(): Promise<Record<string, { model: string }>> {
  const config = await getConfig();
  const registry: Record<string, { model: string }> = {};

  // Embedding model — only if Ollama provider
  if (config.embeddingProvider === 'ollama' && config.ollamaModel) {
    registry.embedding = { model: config.ollamaModel };
  }

  // Completion model
  if (config.ollamaCompletionModel) {
    registry.completion = { model: config.ollamaCompletionModel };
  }

  // OCR model — only if Ollama OCR provider
  if (config.ocrProvider === 'ollama' && config.ocrOllamaModel) {
    registry.ocr = { model: config.ocrOllamaModel };
  }

  // Reranker model
  if (config.rerankModel) {
    registry.reranker = { model: config.rerankModel };
  }

  return registry;
}

/** Push current admin model names to a sidecar's container registry. */
export async function pushModelRegistry(agentUrl: string): Promise<any> {
  const registry = await buildModelRegistry();
  if (Object.keys(registry).length === 0) {
    logger.info('No model overrides to push', { agent: agentUrl });
    return { pushed: false, reason: 'no model overrides configured' };
  }
  logger.info('Pushing model registry to sidecar', { agent: agentUrl, roles: Object.keys(registry) });
  return sendToSidecar(agentUrl, '/config', { registry });
}

/** Push both idle timeouts AND model registry in a single /config call. */
export async function pushFullConfig(agentUrl: string, timeouts: IdleTimeouts): Promise<any> {
  const registry = await buildModelRegistry();
  return sendToSidecar(agentUrl, '/config', {
    idleTimeouts: {
      embedding: timeouts.embedding * 60_000,
      completion: timeouts.completion * 60_000,
      ocr: timeouts.ocr * 60_000,
      reranker: timeouts.reranker * 60_000,
    },
    ...(Object.keys(registry).length > 0 ? { registry } : {}),
  });
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
export async function resolveEndpoint(role: GpuRole): Promise<ResolvedEndpoint> {
  const fleet = await getFleetStatus();
  const port = ROLE_PORTS[role];

  // Try sidecars that are connected/reachable
  const reachable = fleet.sidecars.filter(s => s.status === 'connected');

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
      // CPU-offloaded — track as fallback only
      if (load < cpuOffloadedLoad) {
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
  if (!bestSidecar && cpuOffloadedFallback) {
    bestSidecar = cpuOffloadedFallback;
    bestLoad = cpuOffloadedLoad;
    bestGpuPct = cpuOffloadedGpuPct;
    logger.warn(`Route: ${role} — no fully GPU-loaded sidecar available, using CPU-offloaded fallback (GPU ${cpuOffloadedGpuPct}%)`, {
      role,
      sidecar: cpuOffloadedFallback.hostname,
      gpuPercent: cpuOffloadedGpuPct,
    });
  }

  if (bestSidecar) {
    const hostname = new URL(bestSidecar.url).hostname;
    // Send acquire to register the request + reset idle timer
    try {
      await sendToSidecar(bestSidecar.url, '/acquire', { role });
    } catch {
      // Non-critical — container already running
    }
    const gpuInfo = bestGpuPct >= 0 ? `, gpu=${bestGpuPct}%` : '';
    logger.info(`Route resolved: ${role} → ${bestSidecar.hostname} (${hostname}:${port}), container=running, load=${bestLoad}${gpuInfo}`, {
      phase: 1,
      role,
      sidecar: bestSidecar.hostname,
      host: `http://${hostname}:${port}`,
      containerStatus: 'running',
      activeRequests: bestLoad,
      gpuPercent: bestGpuPct,
    });
    return { host: `http://${hostname}:${port}`, sidecarUrl: bestSidecar.url, role };
  }

  // Phase 2: No running container — pick first reachable sidecar and acquire
  const errors: string[] = [];
  for (const sidecar of reachable) {
    try {
      const result = await sendToSidecar(sidecar.url, '/acquire', { role });
      if (!result.error) {
        const hostname = new URL(sidecar.url).hostname;
        logger.info(`Route resolved: ${role} → ${sidecar.hostname} (${hostname}:${port}), container=acquired, action=${result.action}`, {
          phase: 2,
          role,
          sidecar: sidecar.hostname,
          host: `http://${hostname}:${port}`,
          action: result.action,
        });
        return { host: `http://${hostname}:${port}`, sidecarUrl: sidecar.url, role };
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
    try {
      const result = await sendToSidecar(sidecar.url, '/acquire', { role });
      if (!result.error) {
        const hostname = new URL(sidecar.url).hostname;
        logger.info(`Route resolved: ${role} → ${sidecar.hostname} (${hostname}:${port}), container=acquired (was disconnected)`, {
          phase: 3,
          role,
          sidecar: sidecar.hostname,
          host: `http://${hostname}:${port}`,
          action: result.action,
        });
        return { host: `http://${hostname}:${port}`, sidecarUrl: sidecar.url, role };
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
  const mins: MinOnlineConfig = {
    embedding: config.gpuMinEmbedding,
    completion: config.gpuMinCompletion,
    ocr: config.gpuMinOcr,
    reranker: config.gpuMinReranker,
  };

  // Skip if all zeros
  if (Object.values(mins).every(v => v === 0)) return;

  const fleet = await getFleetStatus();
  const reachable = fleet.sidecars.filter(s => s.status === 'connected');
  if (reachable.length === 0) return;

  for (const role of ['embedding', 'completion', 'ocr', 'reranker'] as const) {
    const minRequired = mins[role];
    if (minRequired <= 0) continue;

    // Count from status cache — no outbound push needed
    let runningCount = 0;
    const idleSidecars: string[] = [];

    // VRAM requirements for roles that need GPU
    const ROLE_VRAM_NEEDS: Record<string, number> = {
      completion: 10000,
      reranker: 7000,
      embedding: 1200,
      ocr: 8000,
    };

    for (const sidecar of reachable) {
      const cached = statusCache.getSidecarStatus(sidecar.url);
      if (!cached) continue;
      const containerStatus = cached.containers?.[role]?.status;
      if (containerStatus === 'running') {
        runningCount++;
      } else if (containerStatus === 'exited' || cached.containers?.[role]?.exists) {
        // Only consider this sidecar if it has enough free VRAM for the role
        const vramNeeded = ROLE_VRAM_NEEDS[role] || 0;
        const freeVram = cached.freeVram ?? Infinity; // no data = assume ok
        if (freeVram >= vramNeeded * 0.5) {
          idleSidecars.push(sidecar.url);
        } else {
          logger.info(`min-online: skipping ${sidecar.url} for ${role} — need ${vramNeeded}MB but only ${freeVram}MB free VRAM`);
        }
      }
    }

    if (runningCount >= minRequired) continue;

    const deficit = minRequired - runningCount;
    const toAcquire = idleSidecars.slice(0, deficit);

    if (toAcquire.length < deficit) {
      logger.warn(`min-online: need ${deficit} more ${role} container(s) but only ${toAcquire.length} sidecar(s) with sufficient VRAM`);
    }

    for (const url of toAcquire) {
      try {
        await sendToSidecar(url, '/acquire', { role });
        logger.info(`min-online: acquired ${role} on ${url}`);
      } catch (err) {
        logger.warn(`min-online: failed to acquire ${role} on ${url}`, { error: (err as Error).message });
      }
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
