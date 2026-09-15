import type { WebSocket } from 'ws';
import { createLogger } from './logger';
import { processGlobal } from './process-global';

const stateLog = createLogger('state');

export const CONTAINER_PREFIX = 'ss-';

// Pinned vLLM image for all vLLM-served roles (ss-rlm, ss-reranker). Pinned to
// v0.21.0 — the version ALREADY running on the GPU host (confirmed via the RLM
// endpoint's /version, 2026-06-08). The container recreate therefore finds the
// image layers already cached (no multi-GB re-pull) while still applying the
// new vllmArgs. 0.21.0 supports --tool-call-parser qwen3_xml (per its own docs)
// + fp8 KV + Qwen3. Pinning beats floating `:latest`, which could silently jump
// versions and drop/alter the parser. Bump deliberately after testing a newer
// release (e.g. v0.22.1) — that bump WILL trigger a full image pull.
export const VLLM_IMAGE = 'vllm/vllm-openai:v0.21.0';

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
  // Extra args appended to the vLLM `vllm serve <model>` command (after
  // --host / --port). Use for --gpu-memory-utilization, --max-model-len,
  // --quantization, --dtype, --trust-remote-code, etc. Without explicit caps
  // vLLM defaults to gpu_memory_utilization=0.9 and grabs the whole GPU,
  // evicting other roles. Only honored by type==='vllm' roles.
  vllmArgs?: string[];
  // Opt OUT of GPU passthrough for a docker-runtime role that is not itself
  // a GPU inference server (currently only ss-rlm-sandbox). Every other
  // docker-runtime role implicitly requires GPU today — this flag exists so
  // that stays true by DEFAULT (undefined behaves exactly like `true`):
  // `ensureContainerForRole`'s Mac/Windows-no-GPU refusal
  // (containers.ts) and `createContainer`'s unconditional
  // HostConfig.DeviceRequests (docker.ts) both check `requiresGpu !== false`
  // before applying their GPU-only behavior, so setting this to `false` is
  // additive — it does not change any existing role's behavior.
  requiresGpu?: boolean;
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
  // Code-aware embedding (ss-code-embedding). Ollama pulls the GGUF directly
  // from HF via the hf.co/{repo}:{quant} reference (the bare name 404s on
  // pull — it's not a registry model). Boot-time fallback; the master pushes
  // the operator's choice (embedding.codeOllamaModel) via modelOverrides.
  // Registry key is the role name (modeToRole('ss-code-embedding')).
  'code-embedding': {
    image: 'ollama/ollama',
    model: 'hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0',
    port: 11437,
    vram: 2000,
    type: 'ollama',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}code-embedding`,
    priority: 'normal',
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
    image: VLLM_IMAGE,
    model: 'Qwen/Qwen3-Reranker-8B',
    port: 8099,
    vram: 7000,
    type: 'vllm',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}reranker`,
    priority: 'normal',
    // Operator-tunable via /admin/reranking, pushed in the /config payload
    // (gpuMemUtils + rerankEnforceEager). Kept in sync with
    // mode-templates.ts:RERANKER_VLLM_ARGS. 0.85 ≈ 41 GB on a 48 GB card,
    // leaving ~7 GB headroom while maximizing KV cache for batch concurrency.
    // --enforce-eager on by default (flat VRAM, fast cold-start); operator can
    // disable for CUDA graphs + torch.compile throughput.
    // --max-num-batched-tokens 32768: the vLLM default (~2048) caps the
    // scheduler at one ~8K-token (query,doc) rerank pair per step → Running:1
    // and a huge waiting queue even with the KV cache near-empty. 32768 lets it
    // pack several pairs per forward pass (vLLM rebalances KV cache down to fit,
    // still ~11x concurrency on 48 GB). Drop to 16384 if the engine OOMs at boot.
    vllmArgs: ['--gpu-memory-utilization', '0.85', '--enforce-eager', '--max-num-batched-tokens', '32768'],
  },
  rlm: {
    image: VLLM_IMAGE,
    model: 'mit-oasys/rlm-qwen3-8b-v0.1',
    port: 8100,
    // Operator-assigned 34 GB on a 48 GB A6000. BF16 weights (~16 GB) +
    // KV cache (~16 GB at 32K context, ~512 concurrent tokens) + overhead.
    // No AWQ build of mit-oasys/rlm-qwen3-8b-v0.1 is published — running BF16.
    vram: 34000,
    type: 'vllm',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}rlm`,
    // Evicts ss-completion (normal) on a constrained GPU; both roles answer the
    // user's question and are mutually exclusive on a 24 GB card by design.
    priority: 'high',
    // ss-rlm runs on a DEDICATED 48 GB A6000 (it already evicts ss-completion;
    // embedding/ocr are Ollama). --gpu-memory-utilization 0.90 lets vLLM take
    // ~43 GB; lower to ~0.7 if you co-locate ss-rlm with other GPU roles.
    // --max-model-len 40960 is the model's native ceiling
    // (max_position_embeddings=40960, no rope_scaling) — vLLM refuses to start
    // above it without YaRN. --kv-cache-dtype fp8 halves per-token KV (one
    // 40960-token seq ≈ 3 GB). The deep-search.ts seed cap is what actually
    // fixed the maxRounds loop.
    //
    // Tool-calling: master's runRlmWithTools (src/lib/ai/stream-rlm.ts) drives
    // Phase B recursive RAG via OpenAI tool_choice='auto' (vLLM 400s without
    // --enable-auto-tool-choice). The model emits Qwen3-Coder-style XML
    // (<tool_call><function=…><parameter=…>…) → the `qwen3_xml` parser. Neither
    // 'pythonic' nor 'hermes' matches it; stream-rlm.ts keeps a regex fallback.
    vllmArgs: [
      '--gpu-memory-utilization', '0.90',
      '--max-model-len', '40960',
      '--kv-cache-dtype', 'fp8',
      '--dtype', 'bfloat16',
      '--enable-auto-tool-choice',
      '--tool-call-parser', 'qwen3_xml',
    ],
  },
  // ss-rlm-sandbox — the RLM *pattern* (hold context as a REPL variable;
  // chunk/grep/recursively sub-query it) driven against a hosted OpenRouter
  // chat model, instead of self-hosting the mit-oasys/rlm-qwen3-8b-v0.1
  // fine-tune. The master routes here when no sidecar has ss-rlm running
  // (see resolveRlmEndpoint() fallback in the master's stream-rlm.ts) and
  // the operator has opted in via virtualInference.mode.rlm !== 'local-only'.
  //
  // model: null — deliberately. The "model" here is an OpenRouter chat-model
  // id (default deepseek/deepseek-v4-flash), which is config, not a weight
  // this container loads; the master pushes it via modelOverrides like any
  // other mode.
  //
  // type: 'vllm' rather than 'utility' — DELIBERATE deviation from the
  // original design note, which suggested 'utility' (the type the 'cuda'
  // role above uses). 'utility' roles are explicitly skipped by
  // ensureContainerForRole() and provisionContainers() (see containers.ts) —
  // the sidecar never docker-pulls or docker-creates them; 'cuda' works that
  // way because gpu.ts manages it out-of-band. ss-rlm-sandbox has no such
  // out-of-band manager and needs the sidecar to actually run its container,
  // so it must go through the normal docker/'vllm'-typed lifecycle
  // (ensureContainerForRole, idle timers, eviction) like ss-rlm and
  // ss-reranker — 'vllm' is the closest existing type for an HTTP-served
  // non-Ollama role; it is not literally vLLM. If a future refactor adds a
  // dedicated ContainerDef type for generic HTTP utility servers, migrate
  // this role to it instead of re-litigating 'utility' vs 'vllm' here.
  //
  // Security (non-negotiable, from the design note): this container gets NO
  // Docker socket mount, NO OpenRouter API key, and needs NO outbound
  // internet — its sub-model calls route back through THIS sidecar's own
  // virtual-inference (the same path other roles use to reach OpenRouter),
  // not a direct connection. Whoever builds the image/compose config for
  // `image` below must not add a socket mount, an env-injected API key, or
  // an egress-open network policy — that would defeat the whole point of
  // sandboxing an LLM-driven Python REPL. The host-side proxy that lets the
  // sandbox call back into the sidecar (and the Fantom HTTP tool exposure)
  // is NOT built yet — see docs referenced in the design note, steps 3-4.
  //
  // image: not yet published — this name is a placeholder for the operator
  // task of building/publishing the sandbox image (python:3.11-slim + the
  // rlm library, no Docker socket, no API key baked in, network-restricted).
  // Building/pushing that image is explicitly out of scope here.
  'rlm-sandbox': {
    image: 'soundsuite/rlm-sandbox:latest',
    model: null,
    port: 8101,
    vram: 0,
    type: 'vllm',
    modes: ['searching'],
    containerName: `${CONTAINER_PREFIX}rlm-sandbox`,
    priority: 'normal',
    // No GPU needed — see `requiresGpu`'s doc comment above. Without this,
    // ensureContainerForRole()/provisionContainers() would refuse to create
    // this container at all on Mac/Windows-without-WSL2-passthrough hosts
    // (the blanket "Docker has no GPU support on this host" guard that
    // exists to stop multi-GB vLLM/Ollama image pulls from retry-looping on
    // GPU-less Docker), contradicting the "runs on every host Docker
    // supports" point of this mode.
    requiresGpu: false,
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
  os?: 'mac-docker-ollama' | 'windows-docker-wsl2' | 'linux' | string;
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

export const state = processGlobal('state', () => ({
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
    rlm: 10 * 60 * 1000,
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
    rlm: 0,
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
  // True once the windows-docker-wsl2 passthrough probe has been tried. Single-shot.
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
  // Detected OS of the Docker host ('mac-docker-ollama' | 'windows-docker-wsl2' | 'linux' | 'unknown').
  // Populated by host-os.ts at startup.
  hostOs: 'unknown' as 'mac-docker-ollama' | 'windows-docker-wsl2' | 'linux' | 'unknown',
  // Precedence order (highest first):
  //   'master-override' — pushed via /config from master (UI: /admin/host-provisioning)
  //   'override'        — operator picked via local /setup wizard
  //   'env'             — HOST_OS env at container launch
  //   'docker-info'     — auto-detected from Docker /info
  //   'low'             — no signal yet
  hostOsConfidence: 'low' as 'env' | 'docker-info' | 'low' | 'override' | 'master-override',
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
}));

/**
 * Defensive accessor for Set-typed runtime fields on `state`.
 *
 * Background: `state.modelLoading` and `state.userStopped` are initialized as
 * `new Set<string>()` in this module, but any code path that accidentally
 * round-trips them through JSON (e.g. Object.assign from a parsed config) can
 * turn them into plain objects, which have no `.add` / `.delete` / `.has`.
 * That manifested as "Cannot read properties of undefined (reading 'delete')"
 * bubbling out of `/acquire` and other Set-touching handlers.
 *
 * Call this everywhere instead of touching the field directly: it lazily
 * re-initializes the field to a fresh Set if it isn't one, and returns the
 * (now guaranteed) Set so the caller can `.add` / `.delete` / `.has` freely.
 */
export function ensureSet(field: 'userStopped' | 'modelLoading' | 'dmrRoles'): Set<string> {
  const current = (state as Record<string, unknown>)[field];
  if (!(current instanceof Set)) {
    const seeded = new Set<string>();
    // Best-effort migration: if the stale value was an array or array-like,
    // preserve its members so we don't silently drop state on the first call.
    if (Array.isArray(current)) {
      for (const v of current) if (typeof v === 'string') seeded.add(v);
    } else if (current && typeof current === 'object') {
      for (const v of Object.values(current as Record<string, unknown>)) {
        if (typeof v === 'string') seeded.add(v);
      }
    }
    (state as Record<string, unknown>)[field] = seeded;
    return seeded;
  }
  return current;
}

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
      // Stable synthetic image marker — keeps def.image truthy and prevents
      // any code path that tries to `docker pull` it from doing real work
      // (pullImage() fast-fails on 'dmr').
      def.image = 'dmr';
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
      // Stable synthetic image marker. pullImage('host-ollama') fast-fails,
      // and master's `isHostRuntime = container?.image === 'host-ollama'`
      // check stays truthy independent of the synthesizer in containers.ts.
      def.image = 'host-ollama';
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
      // BUT: on mac-docker-ollama, the mode catalog is the authoritative
      // source of runtime='host' (no SS_HOST_OLLAMA env required), so reverting
      // here would break the watchdog and routing for Mac sidecars whose
      // master pushes a raw registry (legacy path) instead of enabledModes.
      // Without this guard, lastHealth stays {at:0, ok:false} because
      // pickHostRuntimeRole() finds nothing after every config push.
      if (state.hostOs !== 'mac-docker-ollama') {
        def.runtime = 'docker';
      }
    } else if (!def.runtime) {
      // Default runtime depends on host class: Mac native Ollama lives on the
      // host; everywhere else, Docker is the default.
      def.runtime = state.hostOs === 'mac-docker-ollama' && def.type === 'ollama' ? 'host' : 'docker';
      if (def.runtime === 'host') {
        // Same port normalization as the explicit host-Ollama path: all host
        // Ollama roles share the single native port (11434).
        def.port = HOST_OLLAMA_PORT;
        def.image = 'host-ollama';
      }
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
  if (state.hostOs === 'mac-docker-ollama') return false;
  if (state.hostOs === 'windows-docker-wsl2') {
    // Docker Desktop with the WSL2 backend has native NVIDIA GPU passthrough
    // — no host-helper script required. Unconditionally yes.
    return true;
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
  /**
   * Bumped by every `connectMaster` attempt and by `disconnectMaster`. The
   * socket callbacks capture the value they were created under and bail when it
   * no longer matches, so a close or error belonging to a connection we have
   * already replaced or torn down cannot mutate this slot or schedule a
   * reconnect. Comparing `m.ws !== ws` is not enough on its own:
   * `disconnectMaster` nulls `m.ws` before the close event lands, and the close
   * handler's `m.ws === null` case deliberately falls through to
   * `scheduleReconnect` (that is the failed-handshake path), so a manual
   * disconnect re-armed the reconnect it had just cancelled.
   */
  wsEpoch: number;
  /**
   * Set when a slot is taken out of service for good (operator removal, or a
   * duplicate of a master we are already connected to). A retired connection
   * never reconnects, whatever fires late.
   */
  retired?: boolean;
  /**
   * Consecutive failed connect/heartbeat cycles. Once past
   * UNREACHABLE_AFTER_FAILURES the slot reports `unreachable` instead of
   * logging an error every cycle — *unreported is not down*, so it keeps
   * retrying on the capped backoff. A master that is merely rebooting must not
   * be abandoned.
   */
  unreachable?: boolean;
  /** The `ws://host:port/sidecar` this slot last dialled. Two slots that dial
   *  the identical URL are the same master process by construction — that is
   *  a string comparison, not an inference about the network. */
  wsUrl?: string;
  /** Last value seen in `X-Sound-Suite-Master-Url` for this master, so the
   *  "self-identified as" line is logged once per value rather than on every
   *  heartbeat, poll and result reply. */
  absorbedHeaderUrl?: string;
  /**
   * The canonical URL this master announced about ITSELF in a `master-identity`
   * frame. This is the only authoritative identity the sidecar ever gets: two
   * slots that announce the same canonical URL are the same master process, no
   * matter which address each of them dialled.
   *
   * Comparing dial endpoints cannot see that case. A multi-homed master answers on
   * a LAN address and on a VPN/Tailscale address; `discoverMasters()` and
   * `POST /api/masters` both key slots by exact URL string, so one master becomes
   * two slots whose `wsUrl`s differ by HOSTNAME. Both then register with the same
   * agentUrl, and the master supersedes per agentUrl — the ping-pong again, at a
   * site no string comparison can catch.
   */
  announcedCanonicalUrl?: string;
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
    wsEpoch: 0,
  };
  state.masters.set(url, m);
  syncLegacyServerUrl();
  return m;
}

export function removeMaster(url: string): MasterConnection | undefined {
  const m = state.masters.get(url);
  if (m) {
    // A master count that changes without the connection having been torn down
    // means something dropped the only reference to a live socket and its
    // timers. The whole of task 42 was invisible because this was never said
    // out loud. Callers should go through `retireMaster` (ws-client.ts).
    if (m.ws || m.heartbeatTimer || m.pollTimer || m.wsReconnectTimer) {
      stateLog.warn(
        `Master slot ${url} removed while still live ` +
        `(ws=${m.ws ? 'open' : 'null'}, heartbeat=${!!m.heartbeatTimer}, ` +
        `poll=${!!m.pollTimer}, reconnect=${!!m.wsReconnectTimer}) — ` +
        `its connection is now orphaned`,
      );
    }
    state.masters.delete(url);
  }
  syncLegacyServerUrl();
  return m;
}

/**
 * Outcome of a rekey. `undefined` used to mean both "no such master" and,
 * implicitly, nothing else — a collision was silently applied. Callers need to
 * tell the two failure modes apart, so the result is discriminated.
 */
export type RekeyResult =
  | { ok: true; master: MasterConnection }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'conflict'; occupant: MasterConnection };

/**
 * Move a master slot to a new key.
 *
 * A destination that is already occupied is a CONFLICT, not a silent overwrite.
 * The old code did `delete(oldUrl)` then `set(newUrl, m)`, which dropped the
 * `MasterConnection` already at `newUrl` on the floor: the map shrank by one
 * while that object kept a live `ws`, a live `heartbeatTimer` and a live
 * reconnect chain referenced by nothing. Replacing an entry in a map of live
 * connections is never just a `set`.
 *
 * The refusal path must not mutate anything — no `delete`, no `m.serverUrl`
 * write, no `syncLegacyServerUrl()`. A half-applied rekey is worse than the
 * overwrite it replaces. `api/masters/[serverUrl]` already answers 409 for this
 * collision on the operator-driven rename path; this makes every other caller
 * agree with it.
 */
export function rekeyMaster(oldUrl: string, newUrl: string): RekeyResult {
  const m = state.masters.get(oldUrl);
  if (!m) return { ok: false, reason: 'not-found' };
  if (oldUrl === newUrl) return { ok: true, master: m };
  const occupant = state.masters.get(newUrl);
  if (occupant && occupant !== m) return { ok: false, reason: 'conflict', occupant };
  state.masters.delete(oldUrl);
  m.serverUrl = newUrl;
  state.masters.set(newUrl, m);
  syncLegacyServerUrl();
  return { ok: true, master: m };
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
