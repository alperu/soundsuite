import type { WebSocket } from 'ws';

export const CONTAINER_PREFIX = 'ss-';

export type RolePriority = 'critical' | 'high' | 'normal';

export type RoleRuntime = 'docker' | 'host' | 'docker-model-runner';

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
  // Execution runtime. 'docker' (default) = sidecar manages a Docker container
  // for this role on its own host. 'host' = role is served by a native process
  // on the Docker host (currently only native Ollama at hostOllamaHost:port).
  // 'docker-model-runner' = role is served by Docker Model Runner on the host
  // (e.g. vllm-metal on Apple Silicon) via OpenAI-compatible API at
  // dmrHost:dmrPort. Set by applyHostOllamaOverrides() / applyDmrOverrides()
  // from env. 'host' is only meaningful for type==='ollama' roles;
  // 'docker-model-runner' works for any OpenAI-API role (incl. vllm rerank).
  runtime?: RoleRuntime;
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
  /** Per-process attribution from `nvidia-smi --query-compute-apps`. Optional;
   * only populated by the host-companion-script path that has access to
   * compute-app info. */
  processes?: Array<{ pid: number; name: string; usedMemory: number }>;
}

/**
 * Snapshot of host-level stats reported by an external companion script
 * (e.g. PowerShell on Windows, launchd on macOS). The sidecar itself
 * cannot reach the host CPU/RAM or non-passed-through GPUs from inside its
 * container, so the operator runs a small native poller that POSTs here.
 *
 * Field names are stable — Agent A (Mac) and Agent B (Windows) MUST agree
 * on this shape so the master UI can render a single layout. Update via
 * RFC if a new field is needed; don't fork.
 */
export interface HostStats {
  /** epoch ms when the companion script captured the sample */
  at: number;
  /** Source script identifier — e.g. "report-host-stats.ps1@1.0", "macos-launchd@1.0" */
  source: string;
  /** Reporter version string for forward-compat */
  agent?: string;
  /** Host OS as reported by the script (cross-check against state.hostOs) */
  os?: 'darwin' | 'win32' | 'linux' | string;
  cpu?: {
    /** Percent 0-100, instantaneous or short-window average */
    percent?: number;
    /** Logical core count */
    cores?: number;
    model?: string;
  };
  memory?: {
    /** Bytes */
    totalBytes?: number;
    usedBytes?: number;
    freeBytes?: number;
  };
  /** Array of GPUs as reported by the host. Same shape as GpuInfo so the
   *  master UI doesn't care whether the data came from in-container
   *  nvidia-smi or the host companion. */
  gpus?: GpuInfo[];
  /** True if the script found nvidia-smi.exe (Windows) or system-profiler
   *  saw an NVIDIA card. False if confirmed absent. Undefined when unknown. */
  hasNvidia?: boolean;
  /** macOS-specific extras (memory pressure %, Metal GPU name/util). Optional;
   *  Windows reporters leave this unset. */
  mac?: HostMacExtras;

  // ─── Legacy flat fields (Mac helper v1) ────────────────────────────────
  // The original macOS helper POSTs these directly. Newer reporters use
  // the structured cpu/memory/gpus/mac blocks above instead. Both shapes
  // are accepted so the Mac and Windows paths converge on one schema.
  /** Host total RAM in MB. Prefer memory.totalBytes in new reporters. */
  totalMb?: number;
  /** Host free RAM in MB. Prefer memory.freeBytes in new reporters. */
  freeMb?: number;
  /** macOS memory_pressure percentage 0..100. Prefer mac.memoryPressurePct. */
  pressurePct?: number;
  /** Host GPU name. Prefer mac.gpuName / gpus[].name. */
  gpuName?: string;
  /** Host GPU utilization 0..100. Prefer mac.gpuUtilPct. */
  gpuUtilPct?: number;
}

export interface HostOllamaHealth {
  at: number;            // epoch ms of last probe
  ok: boolean;
  /** Classified error: 'dns' (host.docker.internal unresolvable),
   *  'ollama_not_running' (ECONNREFUSED), 'network' (timeout/other),
   *  or undefined when ok. */
  error?: 'dns' | 'ollama_not_running' | 'network' | string;
  latencyMs?: number;
}

/**
 * Macroscopic memory pressure metric reported by the macOS host-stats
 * helper. Distinct from the cpu/memory/gpus structure in HostStats because
 * macOS exposes a single "memory pressure %" via `memory_pressure`, which
 * doesn't fit cleanly into per-stat fields. The Mac helper sets this
 * alongside memory.* so both Windows (no pressure) and Mac (with pressure)
 * paths render coherently.
 */
export interface HostMacExtras {
  /** 0..100 — macOS memory_pressure percentage */
  memoryPressurePct?: number;
  /** "Apple M4 Pro" — convenience name from system_profiler */
  gpuName?: string;
  /** 0..100 — Metal GPU utilization, if powermetrics was usable */
  gpuUtilPct?: number;
}

export interface DmrHealth {
  at: number;
  ok: boolean;
  /** 'dns', 'dmr_not_running' (ECONNREFUSED — Docker Model Runner not enabled
   *  or TCP port not exposed), 'network' (timeout), or undefined when ok. */
  error?: 'dns' | 'dmr_not_running' | 'network' | string;
  latencyMs?: number;
  /** Loaded/known model count from /engines/v1/models, when reachable. */
  modelCount?: number;
}

// ─── Host-Ollama env parsing ─────────────────────────────────────────────
// Sidecar mode where the host runs native Ollama (macOS Metal / Windows CUDA)
// and the sidecar in Docker controls it via host.docker.internal:11434.
// Off by default (SS_HOST_OLLAMA=1 to enable).
const HOST_OLLAMA_ENABLED = process.env.SS_HOST_OLLAMA === '1' || process.env.SS_HOST_OLLAMA === 'true';
const HOST_OLLAMA_HOST = process.env.SS_HOST_OLLAMA_HOST || 'host.docker.internal';
// Native Ollama listens on ONE port by default (11434). All host-runtime
// Ollama roles share this same TCP endpoint — keep_alive: 0 evicts only the
// requested model, so multiple roles co-exist on one Ollama process safely.
// Override only if the operator runs Ollama on a non-default port.
const HOST_OLLAMA_PORT = parseInt(process.env.SS_HOST_OLLAMA_PORT || '11434', 10);
const HOST_OLLAMA_ROLES = (process.env.SS_HOST_OLLAMA_ROLES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const HOST_OLLAMA_BUDGET_MB = parseInt(process.env.SS_HOST_OLLAMA_BUDGET_MB || '0', 10);

// ─── Docker Model Runner env parsing ─────────────────────────────────────
// Sidecar mode where the Docker host runs Docker Model Runner (DMR) — e.g.
// vllm-metal on Apple Silicon. DMR exposes an OpenAI-compatible API on TCP
// port 12434 by default (configurable in Docker Desktop → AI → Enable
// host-side TCP support). Reachable from inside the sidecar container at
// host.docker.internal:12434. Off by default (SS_DMR=1 to enable).
const DMR_ENABLED = process.env.SS_DMR === '1' || process.env.SS_DMR === 'true';
const DMR_HOST = process.env.SS_DMR_HOST || 'host.docker.internal';
const DMR_PORT = parseInt(process.env.SS_DMR_PORT || '12434', 10);
const DMR_ROLES = (process.env.SS_DMR_ROLES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const DMR_BUDGET_MB = parseInt(process.env.SS_DMR_BUDGET_MB || '0', 10);

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

  // Roles the operator explicitly stopped via the admin UI / /api/stop.
  // The heartbeat auto-loader skips these to prevent immediate re-loading
  // after a manual Stop. Cleared on /api/acquire or /api/start for the role.
  userStopped: new Set<string>(),

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

  // Per-process GPU attribution from `nvidia-smi --query-compute-apps`.
  // Mapped to roles via Docker State.Pid in vram-accountant.ts. Lets us
  // attribute the *actual* VRAM each container holds — accurate for vLLM
  // (which doesn't expose a per-model size endpoint like Ollama's /api/ps).
  gpuProcessCache: null as Array<{ pid: number; usedMemoryMb: number; processName: string }> | null,
  gpuProcessCacheTime: 0,

  // ─── Host-side companion stats ────────────────────────────────────────
  // Populated by POST /api/host-stats from a native script running on the
  // Docker host (PowerShell on Windows, launchd helper on macOS). The
  // sidecar cannot reach host hardware directly when GPU passthrough is
  // unavailable — this is the data channel for that case. TTL is enforced
  // by callers (handleStatus, /api/gpu): if hostStats.at is older than
  // HOST_STATS_TTL_MS, treat as stale.
  hostStats: null as HostStats | null,
  HOST_STATS_TTL_MS: 60_000, // 1 minute — companion polls at 10s
  // True once any host-stats post has reported nvidia-smi presence. Lets
  // UI render "Windows NVIDIA host without companion script" hint when
  // we KNOW there's an NVIDIA card but data is stale.
  hasNvidiaSmi: false as boolean,
  // True once the win32-WSL2-passthrough probe has been tried. Single-shot.
  wslGpuProbed: false as boolean,

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

  // ─── Host-Ollama mode ──────────────────────────────────────────────────
  // When true, roles listed in hostOllamaRoles are served by a native Ollama
  // on the Docker host (Mac Metal / Windows CUDA), not by Docker containers.
  hostOllamaEnabled: HOST_OLLAMA_ENABLED,
  hostOllamaHost: HOST_OLLAMA_HOST,
  hostOllamaPort: HOST_OLLAMA_PORT,
  hostOllamaRoles: new Set<string>(HOST_OLLAMA_ROLES),
  // Operator-declared VRAM budget for the host endpoint in MB. 0 = unknown
  // (planner falls back to per-role declared `def.vram`). On a 24 GB M4
  // leaving ~8 GB for the OS, set to 16384.
  hostOllamaBudgetMb: HOST_OLLAMA_BUDGET_MB,
  // Last health probe result, updated by host-ollama-watchdog.
  hostOllamaLastHealth: { at: 0, ok: false } as HostOllamaHealth,
  // Detected OS of the Docker host ('darwin' | 'win32' | 'linux' | 'unknown').
  // Populated by host-os.ts at startup.
  hostOs: 'unknown' as 'darwin' | 'win32' | 'linux' | 'unknown',
  hostOsConfidence: 'low' as 'env' | 'docker-info' | 'low' | 'override',
  hostOsDockerDesktop: false,

  // ─── Docker Model Runner mode ──────────────────────────────────────────
  // When true, roles listed in dmrRoles are served by Docker Model Runner
  // on the Docker host (vllm-metal on Apple Silicon, vllm/CUDA on Linux,
  // llama.cpp everywhere). DMR speaks the OpenAI-compatible API at
  // dmrHost:dmrPort. The sidecar does NOT manage containers for these roles;
  // DMR manages its own model lifecycle. Mutually exclusive per-role with
  // hostOllamaRoles.
  dmrEnabled: DMR_ENABLED,
  dmrHost: DMR_HOST,
  dmrPort: DMR_PORT,
  dmrRoles: new Set<string>(DMR_ROLES),
  dmrBudgetMb: DMR_BUDGET_MB,
  dmrLastHealth: { at: 0, ok: false } as DmrHealth,
};

/**
 * If no fresh host-stats POST has been received within this window, the
 * sidecar considers the helper offline and falls back to docker /info.
 * Mirrored as state.HOST_STATS_TTL_MS for back-compat; exported separately
 * so cross-file consumers can import the constant directly.
 */
export const HOST_STATS_TTL_MS = state.HOST_STATS_TTL_MS;

/**
 * Roles that are explicitly NOT allowed to run on native host Ollama, even
 * if a misconfigured SS_HOST_OLLAMA_ROLES or master push tries to enable
 * them. Reranker (Qwen3-Reranker) requires vLLM's /v1/rerank endpoint with
 * `hf-overrides` for the Qwen3ForSequenceClassification head + yes/no
 * classifier_from_token. Ollama has no native rerank API; the community
 * yes/no-logit workaround is fragile and produces wrong rankings in
 * practice. Keep it on a CUDA host with vLLM.
 *
 * Refs:
 *   - github.com/ollama/ollama/issues/10989 (Ollama lacks first-class rerank)
 *   - github.com/vllm-project/vllm/issues/20532 (vLLM Qwen3-Reranker needs
 *     specific hf-overrides; without them the rerank endpoint errors)
 *   - github.com/vllm-project/vllm/issues/35412 (Qwen3-VL-Reranker scores
 *     wrong under vLLM vs Transformers — even on the supported path)
 */
const HOST_OLLAMA_BLOCKED_ROLES = new Set<string>(['reranker']);

/**
 * Apply host-Ollama runtime overrides to the registry. Sets
 * `def.runtime = 'host'` on every role listed in `state.hostOllamaRoles`,
 * but only when host-Ollama mode is enabled. Safe to call repeatedly —
 * call after every registry merge / master config push.
 *
 * Roles not listed retain their default runtime ('docker'). vllm/utility
 * roles are skipped even if listed — host mode currently only supports the
 * Ollama protocol. Roles in HOST_OLLAMA_BLOCKED_ROLES are refused with a
 * warning log even if the operator tried to enable them.
 */
export function applyHostOllamaOverrides(): void {
  // Lazy logger to avoid a circular import (state ↔ logger).
  let warn: ((msg: string) => void) | null = null;
  const getWarn = () => {
    if (warn) return warn;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createLogger } = require('./logger') as typeof import('./logger');
      const log = createLogger('host-runtime-overrides');
      warn = (m: string) => log.warn(m);
    } catch {
      warn = (m: string) => console.warn(`[host-runtime-overrides] ${m}`);
    }
    return warn;
  };

  for (const role of Object.keys(state.registry)) {
    const def = state.registry[role];
    if (!def) continue;

    const dmrRequested = state.dmrEnabled && state.dmrRoles.has(role);
    const ollamaRequested = state.hostOllamaEnabled && state.hostOllamaRoles.has(role);

    if (dmrRequested && ollamaRequested) {
      // Same role in both sets — DMR wins (more capable; supports vLLM
      // reranker which host-Ollama can't).
      getWarn()(
        `Role "${role}" is in BOTH SS_DMR_ROLES and SS_HOST_OLLAMA_ROLES. ` +
        `Picking docker-model-runner (host-ollama ignored for this role).`,
      );
    }

    // DMR path first — DMR supports vLLM, so the host-ollama blocklist
    // (which only protects against Ollama's missing rerank API) does NOT
    // apply here. EXCEPT: cross-encoder rerankers. vllm-metal (the Apple
    // Silicon plugin behind Docker Model Runner) does NOT support
    // sequence-classification / cross-encoder architectures as of v0.2.x —
    // only causal text-only LMs (Qwen3, Llama, Gemma, Mistral, etc.). See
    // github.com/vllm-project/vllm-metal/blob/main/docs/supported_models.md.
    // Refuse to route reranker here so the master doesn't believe the Mac
    // can serve it and direct rerank traffic to a dead endpoint.
    if (dmrRequested && role === 'reranker') {
      getWarn()(
        `Role "reranker" requested via SS_DMR_ROLES but BLOCKED: vllm-metal does not ` +
        `support cross-encoder / Qwen3ForSequenceClassification models on Apple Silicon ` +
        `(only causal LMs). Reranker stays on docker. Move reranker to a Linux+NVIDIA ` +
        `sidecar, or watch vllm-metal/supported_models.md for cross-encoder support.`,
      );
      def.runtime = 'docker';
      continue;
    }
    if (dmrRequested) {
      def.runtime = 'docker-model-runner';
      // Override port to DMR's TCP port so downstream HTTP helpers
      // (getDockerHost + def.port) reach the right endpoint.
      def.port = state.dmrPort;
      continue;
    }

    const ollamaBlocked = HOST_OLLAMA_BLOCKED_ROLES.has(role);
    const isOllamaType = def.type === 'ollama';

    if (ollamaRequested && ollamaBlocked) {
      // Explicit refusal: surface a loud warning so the operator sees why
      // their config didn't take effect. Reranker stays on vLLM/CUDA — OR
      // can be moved to DMR via SS_DMR_ROLES=reranker instead.
      getWarn()(
        `Role "${role}" is in SS_HOST_OLLAMA_ROLES but is BLOCKED from host-ollama runtime — ` +
        `${role} requires vLLM (Ollama has no working rerank). ` +
        `To run on Mac, use SS_DMR=1 SS_DMR_ROLES=${role} instead. Forcing runtime=docker.`,
      );
      def.runtime = 'docker';
      continue;
    }
    if (ollamaRequested && !isOllamaType) {
      if (def.type === 'vllm') {
        getWarn()(
          `Role "${role}" is type=vllm and cannot run on host Ollama. ` +
          `Use SS_DMR=1 SS_DMR_ROLES=${role} for Docker Model Runner instead. Forcing runtime=docker.`,
        );
      }
      def.runtime = 'docker';
      continue;
    }

    if (ollamaRequested) {
      def.runtime = 'host';
      // CRITICAL: all host-runtime Ollama roles share ONE native Ollama
      // process on the host, listening on a SINGLE port (default 11434).
      // The registry's per-role ports (11435 for completion, 11436 for ocr)
      // were chosen so multiple Docker-managed Ollama containers could
      // coexist — they're meaningless in host mode. Override every host
      // role to the shared port, or downstream HTTP helpers will probe
      // host.docker.internal:11435 / :11436 and get ECONNREFUSED because
      // nothing listens there.
      def.port = HOST_OLLAMA_PORT;
    } else if (def.runtime === 'host' || def.runtime === 'docker-model-runner') {
      // Revert if mode was turned off or role removed from the set.
      def.runtime = 'docker';
    } else if (!def.runtime) {
      def.runtime = 'docker';
    }
  }
}

// Apply once at module load so the initial cloned registry reflects env.
applyHostOllamaOverrides();

/**
 * Does this host's Docker daemon support GPU containers?
 *
 * - macOS Docker Desktop: NO — Linux containers run in a VM with no GPU
 *   passthrough. nvidia/cuda images can be pulled but
 *   `DeviceRequests:[{Capabilities:[['gpu']]}]` always errors with
 *   "failed to discover GPU vendor from CDI: no known GPU vendor found".
 * - Windows Docker Desktop: NO — same constraint (despite the host
 *   potentially having an NVIDIA card, Docker can't pass it through).
 * - Linux native Docker with NVIDIA Container Toolkit: YES.
 *
 * Used by the provisioning code to refuse to pull/create GPU containers on
 * platforms where they cannot work, instead of failing in a retry loop.
 */
export function dockerSupportsGpu(): boolean {
  // Strongest signal: we successfully ran nvidia-smi inside ss-cuda and
  // got back at least one GPU. That proves Docker GPU passthrough is
  // working on this host regardless of how we classified hostOs.
  if (Array.isArray(state.gpuCache) && state.gpuCache.length > 0) return true;
  if (state.hostOs === 'darwin') return false;
  if (state.hostOs === 'win32') {
    // WSL2+NVIDIA passthrough works when nvidia-smi.exe is reachable on the
    // Windows host. The operator opted in by installing the host-helper
    // script that POSTs /api/host-stats with hasNvidia=true. Without that
    // signal we have no evidence GPU passthrough actually works on this
    // box, so refuse — same as darwin.
    return state.hasNvidiaSmi === true;
  }
  if (state.hostOs === 'linux') return true;
  // Unknown host on Docker Desktop is almost certainly Mac/Win — refuse too.
  if (state.hostOs === 'unknown' && state.hostOsDockerDesktop) return false;
  return false;
}

// ─── Multi-master types & helpers ────────────────────────────────────────

export interface PendingCommand {
  id: string;
  action: string;
  startedAt: number;
}

export interface MasterConnection {
  serverUrl: string;
  authToken?: string;
  /**
   * WebSocket port for the master's /sidecar relay. Defaults to 3002 when
   * undefined (Sound Suite's two-port deployment). Per-master so a single
   * sidecar can serve masters on different WS ports — e.g. Fantom MCP
   * accepts WS upgrades on the same port as its HTTP API (3848).
   */
  wsPort?: number;
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
  opts?: { authToken?: string; wsPort?: number },
): MasterConnection {
  let m = state.masters.get(url);
  if (m) {
    if (opts?.authToken) m.authToken = opts.authToken;
    if (opts?.wsPort !== undefined) m.wsPort = opts.wsPort;
    return m;
  }
  m = {
    serverUrl: url,
    authToken: opts?.authToken,
    wsPort: opts?.wsPort,
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
