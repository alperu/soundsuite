import type { WebSocket } from 'ws';

export const CONTAINER_PREFIX = 'ss-';

export interface ContainerDef {
  image: string;
  model: string | null;
  port: number;
  vram: number;
  type: 'ollama' | 'vllm' | 'utility';
  modes: ('indexing' | 'searching')[];
  containerName: string;
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
  },
  completion: {
    image: 'ollama/ollama',
    model: 'qwen3.5:9b',
    port: 11435,
    vram: 12000,
    type: 'ollama',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}completion`,
  },
  ocr: {
    image: 'ollama/ollama',
    model: 'richardyoung/olmocr2:7b-q8',
    port: 11436,
    vram: 8000,
    type: 'ollama',
    modes: ['indexing'],
    containerName: `${CONTAINER_PREFIX}ocr`,
  },
  reranker: {
    image: 'vllm/vllm-openai',
    model: 'Qwen/Qwen3-Reranker-8B',
    port: 8099,
    vram: 7000,
    type: 'vllm',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}reranker`,
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

  // WebSocket state
  wsConnection: null as WebSocket | null,
  wsReconnectTimer: null as ReturnType<typeof setTimeout> | null,
  wsReconnectDelay: 1000,
  wsHeartbeatTimer: null as ReturnType<typeof setInterval> | null,
  wsCommandCount: 0,
  serverUrl: null as string | null,
  savedAgentUrl: null as string | null,

  // Connection status for UI display
  connectionStatus: '' as string,
};
