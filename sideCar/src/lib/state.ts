import type { WebSocket } from 'ws';

export const CONTAINER_PREFIX = 'ss-';

export type RolePriority = 'critical' | 'high' | 'normal';

export interface ContainerDef {
  image: string;
  model: string | null;
  port: number;
  vram: number;
  type: 'ollama' | 'vllm' | 'utility';
  modes: ('indexing' | 'searching')[];
  containerName: string;
  // When true, the role MUST be fully resident in GPU VRAM. The sidecar will
  // evict competing models before loading, force num_gpu at warmup, and mark
  // gpuReady=false (and refuse routing) on partial offload.
  gpuOnly?: boolean;
  // Eviction order. The planner sorts evictees ascending by priority — 'normal'
  // gets evicted before 'high'; 'critical' is never evicted. Defaults to
  // 'normal' when omitted to preserve back-compat.
  priority?: RolePriority;
}

export interface PerRoleState {
  activeRequests: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastAcquire: string | null;
  lastRelease: string | null;
}

export const defaultRegistry: Record<string, ContainerDef> = {
  embedding: {
    image: 'ollama/ollama',
    model: 'qwen3-embedding:0.6b',
    port: 11434,
    vram: 1200,
    type: 'ollama',
    modes: ['indexing', 'searching'],
    containerName: `${CONTAINER_PREFIX}embedding`,
    priority: 'high', // used in both modes; small footprint; cheap to keep loaded
  },
  completion: {
    image: 'ollama/ollama',
    model: 'qwen3.5:9b',
    port: 11435,
    vram: 10000, // 9B with 30% CPU offload needs ~10GB GPU
    type: 'ollama',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}completion`,
    priority: 'normal',
  },
  ocr: {
    image: 'ollama/ollama',
    model: 'richardyoung/olmocr2:7b-q8',
    port: 11436,
    vram: 8000,
    type: 'ollama',
    modes: ['indexing'],
    containerName: `${CONTAINER_PREFIX}ocr`,
    gpuOnly: true,
    priority: 'critical',
  },
  reranker: {
    image: 'vllm/vllm-openai',
    model: 'Qwen/Qwen3-Reranker-8B',
    port: 8099,
    vram: 7000,
    type: 'vllm',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}reranker`,
    priority: 'normal',
  },
  cuda: {
    image: 'nvidia/cuda:12.4.1-base-ubuntu22.04',
    model: null,
    port: 0,
    vram: 0,
    type: 'utility',
    modes: ['indexing', 'searching'],
    containerName: `${CONTAINER_PREFIX}cuda`,
  },
};

function initPerRole(): Record<string, PerRoleState> {
  const result: Record<string, PerRoleState> = {};
  for (const role of Object.keys(defaultRegistry)) {
    result[role] = { activeRequests: 0, idleTimer: null, lastAcquire: null, lastRelease: null };
  }
  return result;
}

export interface PeakDemandTracker {
  samples: Array<{ ts: number; count: number }>;
  peak: number;
  windowMs: number;
}

function initPeakDemand(): Record<string, PeakDemandTracker> {
  const result: Record<string, PeakDemandTracker> = {};
  const windowMs = 5 * 60 * 1000;
  for (const role of Object.keys(defaultRegistry)) {
    result[role] = { samples: [], peak: 0, windowMs };
  }
  return result;
}

export interface GpuInfo {
  index: number;
  name: string;
  memoryTotal: number;
  memoryUsed: number;
  memoryFree: number;
  temperature: number;
}

export const state = {
  // Container registry (mutable clone of defaults)
  registry: JSON.parse(JSON.stringify(defaultRegistry)) as Record<string, ContainerDef>,

  // Current mode
  currentMode: 'searching' as 'indexing' | 'searching',

  // Per-role idle timeouts in ms
  idleTimeouts: {
    embedding: 0,
    completion: 10 * 60 * 1000,
    ocr: 5 * 60 * 1000,
    reranker: 5 * 60 * 1000,
    cuda: 0,
  } as Record<string, number>,

  // Per-role minimum online instance count (pushed by master from /config).
  // 0 means "never auto-start"; switchMode and other automatic starters skip
  // these roles. Default 1 so legacy sidecars without master config still work.
  minOnline: {
    embedding: 1,
    completion: 1,
    ocr: 1,
    reranker: 1,
  } as Record<string, number>,

  // Timestamp (epoch ms) of the last /config POST from master. Surfaced in
  // /api/status so the operator can see how recently the sidecar was synced.
  lastConfigPushAt: null as number | null,

  // Per-role tracking
  perRole: initPerRole(),

  // Per-role peak demand tracking (5-min sliding window)
  peakDemand: initPeakDemand(),

  // Legacy single-container compat
  CONTAINER_NAME: process.env.CONTAINER_NAME || 'vllm-reranker',
  IDLE_TIMEOUT_MS: parseInt(process.env.IDLE_TIMEOUT_MS || String(5 * 60 * 1000), 10),
  activeRequests: 0,
  idleTimer: null as ReturnType<typeof setTimeout> | null,
  lastAcquire: null as string | null,
  lastRelease: null as string | null,
  startedAt: Date.now(),

  // Tracks roles currently being loaded into VRAM (prevents duplicate concurrent loads)
  modelLoading: new Set<string>(),

  // Cooldown: last model load/pull attempt timestamp per role (prevents heartbeat spam)
  lastModelAttempt: {} as Record<string, number>,

  // Consecutive pull failure count per role — stops retrying after 3 failures
  pullFailCount: {} as Record<string, number>,

  // GPU cache
  gpuCache: null as GpuInfo[] | null,
  gpuCacheTime: 0,
  GPU_CACHE_TTL: 30_000,
  cudaUnavailable: false,  // set true if NVIDIA runtime not found — stops retry loop
  cudaRetried: false,      // tracks single retry attempt for ss-cuda

  // ─── Multi-master connections ──────────────────────────────────────────
  // Keyed by serverUrl. Each entry owns its own WS, timers, pending-cmd map.
  // Note: `serverUrl` below is a LEGACY single-URL field kept for back-compat
  // surfaces (self-update, status payload, env-bootstrap). It tracks the
  // "first" master URL — see legacyServerUrl(). New code MUST iterate
  // state.masters.
  masters: new Map<string, MasterConnection>(),

  // Aggregate counter across all masters (UI displays it as "ws commands seen")
  wsCommandCount: 0,

  // Legacy single-URL fields — DO NOT remove. self-update.ts, instrumentation.ts,
  // /api/status, /api/update all read these. Helpers below keep them in sync.
  serverUrl: null as string | null,
  savedAgentUrl: null as string | null,

  // Connection status for UI display (aggregate string from all masters)
  connectionStatus: '' as string,
};

// ─── Multi-master types & helpers ────────────────────────────────────────

export interface PendingCommand {
  id: string;
  action: string;
  startedAt: number;
}

export interface MasterConnection {
  serverUrl: string;
  authToken?: string;
  ws: WebSocket | null;
  connectionMode: 'websocket' | 'http' | 'disconnected';
  wsReconnectDelay: number;
  wsReconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  httpHeartbeatFailCount: number;
  wsHeartbeatFailCount: number;
  lastSeenServerVersion?: string;
  lastHeartbeatAt?: number;
  pendingCommands: Map<string, PendingCommand>;
  connectionStatus: string;
}

export function getMaster(url: string): MasterConnection | undefined {
  return state.masters.get(url);
}

export function ensureMaster(
  url: string,
  opts?: { authToken?: string },
): MasterConnection {
  let m = state.masters.get(url);
  if (m) {
    if (opts?.authToken) m.authToken = opts.authToken;
    return m;
  }
  m = {
    serverUrl: url,
    authToken: opts?.authToken,
    ws: null,
    connectionMode: 'disconnected',
    wsReconnectDelay: 1000,
    wsReconnectTimer: null,
    heartbeatTimer: null,
    pollTimer: null,
    httpHeartbeatFailCount: 0,
    wsHeartbeatFailCount: 0,
    pendingCommands: new Map(),
    connectionStatus: '',
  };
  state.masters.set(url, m);
  syncLegacyServerUrl();
  return m;
}

export function removeMaster(url: string): MasterConnection | undefined {
  const m = state.masters.get(url);
  if (m) state.masters.delete(url);
  syncLegacyServerUrl();
  return m;
}

export function rekeyMaster(oldUrl: string, newUrl: string): MasterConnection | undefined {
  const m = state.masters.get(oldUrl);
  if (!m) return undefined;
  if (oldUrl === newUrl) return m;
  state.masters.delete(oldUrl);
  m.serverUrl = newUrl;
  state.masters.set(newUrl, m);
  syncLegacyServerUrl();
  return m;
}

/** Returns the first master URL (insertion order) or null. Used for legacy
 * surfaces that still expect a single URL (self-update, env bootstrap echo). */
export function legacyServerUrl(): string | null {
  const first = state.masters.keys().next();
  return first.done ? null : first.value;
}

/** Keep the legacy state.serverUrl field aligned with the first master. */
export function syncLegacyServerUrl(): void {
  state.serverUrl = legacyServerUrl();
}
