/**
 * Sidecar Status Cache — Server-Side Cache of Sidecar State
 *
 * Instead of pushing `/status` to sidecars, the server caches status
 * reported by sidecars via heartbeat (WS or HTTP).
 *
 * Admin UI reads from this cache — zero outbound connections needed.
 */

import { createLogger } from '@/lib/logger';

const logger = createLogger('StatusCache');

export interface CachedSidecarStatus {
  agentUrl: string;
  hostname: string;
  version?: string;
  mode: string;
  uptime: number;
  containers: Record<string, {
    status: string;
    name: string;
    image?: string;
    port?: number;
    vram?: number;
    type?: string;
    model?: string | null;
    exists?: boolean;
    loadedModels?: Array<{ name: string; size: string; sizeBytes?: number; sizeVram?: number; gpuPercent?: number; processor: string; until: string }>;
    // From sideCar/src/lib/state.ts ContainerDef.gpuOnly — true means routing
    // must reject CPU-offloaded fallbacks for this role.
    config?: { image?: string; model?: string | null; port?: number; vram?: number; type?: string; gpuOnly?: boolean };
    // Set by the sidecar watchdog: false when a gpuOnly role has a partially
    // CPU-offloaded model and remediation has not (yet) restored full GPU.
    gpuReady?: boolean;
  }>;
  // Sidecar's authoritative VRAM accounting — total/free/used + per-role
  // estimated VRAM usage. Drives the master UI's contention banner and the
  // operator-facing "what's loaded" panel. See sideCar/src/lib/vram-accountant.ts
  vram?: {
    totalMb: number;
    freeMb: number;
    usedMb: number;
    unattributedMb: number;
    perRole: Record<string, {
      role: string;
      runtime: 'ollama' | 'vllm' | 'utility';
      containerStatus: string;
      loaded: boolean;
      actualMb: number;
      budgetMb: number;
      priority: 'critical' | 'high' | 'normal';
      gpuOnly: boolean;
      modes: string[];
    }>;
    ts: number;
  };
  activeRequests: number;
  idleTimeouts: Record<string, number>;
  roles: Record<string, {
    activeRequests: number;
    idleTimerActive: boolean;
    lastAcquire?: string | null;
    lastRelease?: string | null;
  }>;
  peakDemand: Record<string, number>;
  gpus: Array<{
    index: number;
    name: string;
    memoryTotal: number;
    memoryUsed: number;
    memoryFree: number;
    temperature: number;
  }>;
  wsConnected: boolean;
  /**
   * Multi-master awareness: list of masters the sidecar is currently
   * registered with. Populated by the multi-master sidecar; absent on
   * older sidecars (treat as exclusive to this Sound Suite master).
   */
  masters?: Array<{
    serverUrl: string;
    connectionMode: 'websocket' | 'http' | 'disconnected';
    lastHeartbeatAt?: number;
    lastSeenServerVersion?: string;
  }>;
  /**
   * Sidecar's own timestamp of the latest config push it accepted from ANY
   * master. Used together with `selfLastConfigPushAt` (below) to detect when
   * another master has overridden Sound Suite's pushed policies.
   */
  lastConfigPushAt?: number;
  /**
   * Wall-clock timestamp (ms) of the last successful config push from THIS
   * Sound Suite master. Updated by fleet-router on each pushFullConfig /
   * pushIdleTimeouts / pushModelRegistry success. Compared against
   * `lastConfigPushAt` to flag policy collisions when masters.length > 1.
   */
  selfLastConfigPushAt?: number;
  freeVram?: number;   // total free GPU memory in MB
  totalVram?: number;  // total GPU memory in MB
  tasks?: Array<{
    id: string;
    type: string;
    label: string;
    role?: string;
    status: 'running' | 'completed' | 'failed';
    progress?: number;
    detail?: string;
    startedAt: number;
    completedAt?: number;
    error?: string;
  }>;
  lastSeen: number; // timestamp
}

// Use globalThis to survive Next.js module isolation between worker-init and API routes.
// Without this, the WS relay (in worker-init context) writes to one Map instance
// while API routes read from a different (empty) Map instance.
const CACHE_KEY = '__soundsuite_sidecar_status_cache__';

function getCache(): Map<string, CachedSidecarStatus> {
  const g = globalThis as any;
  if (!g[CACHE_KEY]) {
    g[CACHE_KEY] = new Map<string, CachedSidecarStatus>();
  }
  return g[CACHE_KEY];
}

// Proxy for backward compat — all reads/writes go through getCache()
const cache = new Proxy({} as Map<string, CachedSidecarStatus>, {
  get(_target, prop: string | symbol) {
    const realMap = getCache();
    const value = (realMap as any)[prop];
    return typeof value === 'function' ? value.bind(realMap) : value;
  },
});

// Stale threshold: consider a sidecar disconnected if no heartbeat for 30s
const STALE_THRESHOLD_MS = 30_000;

/**
 * Update cached status from a sidecar heartbeat.
 * Called from heartbeat endpoint and WS relay heartbeat handler.
 */
export function updateSidecarStatus(agentUrl: string, status: Partial<CachedSidecarStatus>): void {
  const normalized = agentUrl.replace(/\/+$/, '');
  const existing = cache.get(normalized);

  cache.set(normalized, {
    agentUrl: normalized,
    hostname: status.hostname || existing?.hostname || 'unknown',
    version: status.version || existing?.version,
    mode: status.mode || existing?.mode || 'searching',
    uptime: status.uptime ?? existing?.uptime ?? 0,
    containers: status.containers || existing?.containers || {},
    activeRequests: status.activeRequests ?? existing?.activeRequests ?? 0,
    idleTimeouts: status.idleTimeouts || existing?.idleTimeouts || {},
    roles: status.roles || existing?.roles || {},
    peakDemand: status.peakDemand || existing?.peakDemand || {},
    gpus: status.gpus || existing?.gpus || [],
    freeVram: status.freeVram ?? existing?.freeVram,
    totalVram: status.totalVram ?? existing?.totalVram,
    wsConnected: status.wsConnected ?? existing?.wsConnected ?? false,
    masters: status.masters ?? existing?.masters,
    lastConfigPushAt: status.lastConfigPushAt ?? existing?.lastConfigPushAt,
    selfLastConfigPushAt: status.selfLastConfigPushAt ?? existing?.selfLastConfigPushAt,
    tasks: status.tasks || existing?.tasks || [],
    vram: status.vram ?? existing?.vram,
    lastSeen: Date.now(),
  });
}

/**
 * Get cached status for a specific sidecar.
 */
export function getSidecarStatus(agentUrl: string): CachedSidecarStatus | null {
  const normalized = agentUrl.replace(/\/+$/, '');
  return cache.get(normalized) || null;
}

/**
 * Get all cached sidecar statuses.
 */
export function getAllSidecarStatuses(): CachedSidecarStatus[] {
  return Array.from(cache.values());
}

/**
 * Check if a sidecar is considered "connected" (recent heartbeat).
 */
export function isSidecarConnected(agentUrl: string): boolean {
  const normalized = agentUrl.replace(/\/+$/, '');
  const entry = cache.get(normalized);
  if (!entry) return false;
  return (Date.now() - entry.lastSeen) < STALE_THRESHOLD_MS;
}

/**
 * Get aggregated peak demand across all connected sidecars.
 */
export function getAggregatedPeakDemand(): Record<string, number> {
  const demand: Record<string, number> = { embedding: 0, completion: 0, ocr: 0, reranker: 0 };
  for (const status of cache.values()) {
    if ((Date.now() - status.lastSeen) > STALE_THRESHOLD_MS) continue;
    for (const [role, peak] of Object.entries(status.peakDemand)) {
      demand[role] = (demand[role] || 0) + (peak || 0);
    }
  }
  return demand;
}

/**
 * Find sidecars with a specific container role in a given state.
 */
export function findSidecarsWithRole(
  role: string,
  containerStatus?: string
): CachedSidecarStatus[] {
  const results: CachedSidecarStatus[] = [];
  for (const status of cache.values()) {
    if ((Date.now() - status.lastSeen) > STALE_THRESHOLD_MS) continue;
    const container = status.containers[role];
    if (!container) continue;
    if (containerStatus && container.status !== containerStatus) continue;
    results.push(status);
  }
  return results;
}

/**
 * Remove a sidecar from the cache.
 */
export function removeSidecarFromCache(agentUrl: string): void {
  const normalized = agentUrl.replace(/\/+$/, '');
  cache.delete(normalized);
}

/**
 * Mark a sidecar as disconnected (e.g., WS closed).
 */
export function markSidecarDisconnected(agentUrl: string): void {
  const normalized = agentUrl.replace(/\/+$/, '');
  const entry = cache.get(normalized);
  if (entry) {
    entry.wsConnected = false;
  }
}
