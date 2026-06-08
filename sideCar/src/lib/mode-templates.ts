/**
 * Mode templates — per-OS resolution of the fixed 4-mode catalog.
 *
 * The master no longer sends full ContainerDef objects. It sends a list of
 * enabled mode names (`ss-embedding`, `ss-completion`, `ss-ocr`,
 * `ss-reranker`) plus `modelOverrides`. The sidecar — which knows its own
 * hostOs — resolves each mode to a ContainerDef via `resolveMode()`.
 *
 * MASTER IS AUTHORITATIVE for the default model. As of 2026-05-12 the
 * master fills in `modelOverrides[mode]` for every enabled mode using the
 * value the operator set in the admin settings pages
 * (/admin/embedding, /admin/localai, /admin/ocr, /admin/reranking). The
 * hardcoded model strings in `resolveMode()` below are BOOT-TIME ONLY —
 * the value the sidecar uses before the first /config push from the
 * master. Once the master pushes, `modelOverrides` wins. Do not rely on
 * these constants for any long-running behavior; they exist so a freshly
 * booted sidecar that has never talked to a master still has a coherent
 * ContainerDef to log/show.
 *
 * Returns `null` when a mode is unavailable on the given OS (e.g.
 * `ss-reranker` on `mac-docker-ollama` — vllm-metal lacks cross-encoder support).
 *
 * Internal registry keys remain the short role name (`embedding`,
 * `completion`, `ocr`, `reranker`) for back-compat with state.idleTimeouts,
 * state.minOnline, state.perRole, containerName, etc. The `ss-` prefix is
 * the wire/API identifier; `modeToRole()` strips it.
 */
import { CONTAINER_PREFIX, dockerSupportsGpu, state, type ContainerDef } from './state';

export type ModeName = 'ss-embedding' | 'ss-completion' | 'ss-ocr' | 'ss-reranker' | 'ss-rlm';
export const ALL_MODES: ModeName[] = ['ss-embedding', 'ss-completion', 'ss-ocr', 'ss-reranker', 'ss-rlm'];
export type HostOs = 'mac-docker-ollama' | 'windows-docker-wsl2' | 'linux' | 'unknown';
export type RuntimeChoice = 'host' | 'docker-ollama' | 'docker-vllm' | 'docker-model-runner';

/**
 * vLLM serve args appended to the rlm container cmd. Must be kept in sync
 * with state.ts:defaultRegistry.rlm.vllmArgs — both code paths construct an
 * rlm ContainerDef and the master `/config` push overwrites the registry
 * entry built by `defaultRegistry`, so this template version is what the
 * running container actually inherits at runtime.
 *
 * --gpu-memory-utilization 0.90 — ss-rlm runs on a DEDICATED 48 GB A6000 here
 * (it already evicts ss-completion; embedding/ocr are Ollama). Lower to ~0.7 if
 * you co-locate ss-rlm with other GPU roles on one card. --max-model-len 40960
 * is the model's native ceiling: mit-oasys/rlm-qwen3-8b-v0.1 has
 * max_position_embeddings=40960 and NO rope_scaling, so vLLM refuses to start
 * above it (going higher needs YaRN — see notes). --kv-cache-dtype fp8 halves
 * per-token KV (one 40960-token seq ≈ 3 GB vs 5.6 GB bf16); the seed cap in
 * deep-search.ts is what actually broke the maxRounds loop. --dtype bfloat16
 * matches the published weights.
 *
 * --enable-auto-tool-choice + --tool-call-parser qwen3_xml opt vLLM into
 * OpenAI tool-calling so master's runRlmWithTools can drive Phase B recursive
 * RAG; without --enable-auto-tool-choice vLLM 400s on tool_choice='auto'.
 * The model emits Qwen3-Coder-style XML:
 *   <tool_call><function=query_case_knowledge><parameter=query>…</parameter></function></tool_call>
 * which is the `qwen3_xml` parser's format (vLLM docs) — NOT pythonic
 * `name("…")` nor Hermes JSON; both miss every call (confirmed in
 * logs/dashboard.log 2026-06-08, where vllm_tool_calls=0 and a regex fallback
 * rescued each round). stream-rlm.ts keeps that fallback as a safety net in
 * case the served vLLM predates qwen3_xml.
 */
const RLM_VLLM_ARGS: string[] = [
  '--gpu-memory-utilization', '0.90',
  '--max-model-len', '40960',
  '--kv-cache-dtype', 'fp8',
  '--dtype', 'bfloat16',
  '--enable-auto-tool-choice',
  '--tool-call-parser', 'qwen3_xml',
];

/** Strip "ss-" prefix → registry/state key. */
export function modeToRole(mode: ModeName): string {
  return mode.replace(/^ss-/, '');
}

/** Add "ss-" prefix → mode name. */
export function roleToMode(role: string): ModeName | null {
  const m = `ss-${role}` as ModeName;
  return ALL_MODES.includes(m) ? m : null;
}

export function isModeName(s: string): s is ModeName {
  return (ALL_MODES as string[]).includes(s);
}

/**
 * Resolve (mode, hostOs) → ContainerDef. Returns null when the combination
 * is unavailable on this OS — caller should log WARN and skip.
 *
 * The `containerName` uses the short role name (no double prefix), so
 * "ss-embedding" → containerName "ss-embedding" (CONTAINER_PREFIX + "embedding").
 */
export function resolveMode(
  mode: ModeName,
  hostOs: HostOs,
  runtime?: RuntimeChoice,
): ContainerDef | null {
  const role = modeToRole(mode);
  // Defensive: CONTAINER_PREFIX is `export const CONTAINER_PREFIX = 'ss-'`
  // in state.ts, but the v2.3.x sidecar bundle has been observed serving
  // `undefined` for this re-export at runtime — producing container names
  // like "undefinedrlm" in admin UI rows. Same class of bug as the
  // `(0 , l.fZ) is not a function` Webpack/Turbopack module-reference issue.
  // Hard-fallback to the literal so this code path is robust to bundling
  // weirdness while the underlying bundle issue is investigated.
  const prefix: string = (typeof CONTAINER_PREFIX === 'string' && CONTAINER_PREFIX.length > 0) ? CONTAINER_PREFIX : 'ss-';
  const containerName = `${prefix}${role}`;

  // When the master explicitly picked a runtime, honor it (subject to compat
  // checks against the host's actual capabilities). Falls through to the
  // legacy OS-derived selection when no runtime is supplied — keeps older
  // masters working during rollout.
  if (runtime) {
    return resolveModeForRuntime(mode, hostOs, runtime, containerName);
  }

  // windows-docker-wsl2: Docker Desktop with WSL2 backend ships native NVIDIA
  // GPU passthrough. Routes every docker-runtime mode to the linux ContainerDef
  // (same Ollama/vLLM images, same ports). mac-docker-ollama keeps the
  // host-runtime variant (host.docker.internal:11434).
  //
  // When hostOs is "unknown" (Docker /info didn't classify the host — most
  // commonly a native Linux server where /info returned a distro name we
  // didn't recognize, or the probe timed out) AND we have positive evidence
  // of GPU passthrough (state.gpuCache populated by discoverGpus → ss-cuda
  // → nvidia-smi), treat the host as linux. This fail-open path keeps the
  // reranker/CUDA resolutions reachable on real Linux+NVIDIA hosts whose
  // /info classifier missed.
  const looksLikeLinuxFromGpu =
    hostOs === 'unknown' &&
    Array.isArray(state.gpuCache) &&
    state.gpuCache.length > 0;
  const isLinux =
    hostOs === 'linux' ||
    hostOs === 'windows-docker-wsl2' ||
    looksLikeLinuxFromGpu;

  switch (mode) {
    case 'ss-embedding':
      return isLinux
        ? {
            image: 'ollama/ollama',
            model: 'qwen3-embedding:0.6b',
            port: 11434,
            vram: 1200,
            type: 'ollama',
            modes: ['indexing', 'searching'],
            containerName,
            priority: 'high',
            runtime: 'docker',
          }
        : {
            image: 'host-ollama',
            model: 'qwen3-embedding:0.6b',
            port: 11434,
            vram: 1200,
            type: 'ollama',
            modes: ['indexing', 'searching'],
            containerName,
            priority: 'high',
            runtime: 'host',
          };

    case 'ss-completion':
      return isLinux
        ? {
            image: 'ollama/ollama',
            model: 'qwen3.5:9b',
            port: 11435,
            vram: 10000,
            type: 'ollama',
            modes: ['searching'],
            containerName,
            priority: 'normal',
            runtime: 'docker',
          }
        : {
            image: 'host-ollama',
            model: 'qwen3.5:9b',
            port: 11434, // shared native Ollama port
            vram: 10000,
            type: 'ollama',
            modes: ['searching'],
            containerName,
            priority: 'normal',
            runtime: 'host',
          };

    case 'ss-ocr':
      return isLinux
        ? {
            image: 'ollama/ollama',
            model: 'minicpm-v:latest',
            port: 11436,
            vram: 5000,
            type: 'ollama',
            modes: ['indexing'],
            containerName,
            gpuOnly: true,
            priority: 'critical',
            runtime: 'docker',
          }
        : {
            image: 'host-ollama',
            model: 'minicpm-v:latest',
            port: 11434, // shared native Ollama port
            vram: 5000,
            type: 'ollama',
            modes: ['indexing'],
            containerName,
            priority: 'critical',
            runtime: 'host',
          };

    case 'ss-reranker':
      // vllm-metal lacks cross-encoder / Qwen3ForSequenceClassification
      // support on Apple Silicon (see vllm-metal#361), so mac-docker-ollama
      // stays excluded. Linux native and windows-docker-wsl2 both run the
      // same vLLM container with GPU passthrough (windows-docker-wsl2 is
      // already covered by isLinux above).
      if (!isLinux) return null;
      return {
        image: 'vllm/vllm-openai',
        model: 'Qwen/Qwen3-Reranker-8B',
        port: 8099,
        vram: 7000,
        type: 'vllm',
        modes: ['searching'],
        containerName,
        priority: 'normal',
        runtime: 'docker',
      };

    case 'ss-rlm':
      // Mac unsupported by default: Docker vLLM has no Metal passthrough on
      // macOS, and DMR's vllm-metal only serves MLX-format weights — no MLX
      // conversion of mit-oasys/rlm-qwen3-8b-v0.1 exists on HuggingFace yet.
      // Use a Linux or Windows+NVIDIA sidecar for RLM.
      if (!isLinux) return null;
      return {
        image: 'vllm/vllm-openai',
        model: 'mit-oasys/rlm-qwen3-8b-v0.1',
        port: 8100,
        vram: 10000,
        type: 'vllm',
        modes: ['searching'],
        containerName,
        priority: 'high',
        runtime: 'docker',
        vllmArgs: RLM_VLLM_ARGS,
      };

    default:
      return null;
  }
}

/**
 * Build a ContainerDef for an explicit (mode, hostOs, runtime) triple.
 *
 * Compat rules:
 *   - `host` is always allowed for the 3 Ollama-backed modes (embedding,
 *     completion, ocr). Returns the host-Ollama ContainerDef regardless of
 *     hostOs. Refuses for ss-reranker (no host-vLLM today).
 *   - `docker-ollama` requires the host's Docker daemon to support GPU
 *     passthrough for GPU-only modes (currently ss-ocr). For other Ollama
 *     modes Docker is allowed CPU-side, but we still refuse on hosts where
 *     `dockerSupportsGpu()` is false to keep behavior simple and consistent.
 *   - `docker-vllm` only makes sense for ss-reranker today and requires GPU.
 *   - `docker-model-runner` is reserved (DMR — Apple Silicon vllm-metal);
 *     refuse here, callers fall through to other runtimes.
 *
 * Returns null when the chosen runtime is not satisfiable on this host —
 * caller should log WARN and skip the mode.
 */
function resolveModeForRuntime(
  mode: ModeName,
  hostOs: HostOs,
  runtime: RuntimeChoice,
  containerName: string,
): ContainerDef | null {
  void hostOs; // host/docker GPU compat is captured by dockerSupportsGpu()

  if (runtime === 'host') {
    switch (mode) {
      case 'ss-embedding':
        return {
          image: 'host-ollama',
          model: 'qwen3-embedding:0.6b',
          port: 11434,
          vram: 1200,
          type: 'ollama',
          modes: ['indexing', 'searching'],
          containerName,
          priority: 'high',
          runtime: 'host',
        };
      case 'ss-completion':
        return {
          image: 'host-ollama',
          model: 'qwen3.5:9b',
          port: 11434,
          vram: 10000,
          type: 'ollama',
          modes: ['searching'],
          containerName,
          priority: 'normal',
          runtime: 'host',
        };
      case 'ss-ocr':
        return {
          image: 'host-ollama',
          model: 'minicpm-v:latest',
          port: 11434,
          vram: 5000,
          type: 'ollama',
          modes: ['indexing'],
          containerName,
          priority: 'critical',
          runtime: 'host',
        };
      case 'ss-reranker':
        // No host-vLLM path today.
        return null;
      case 'ss-rlm':
        // No host-vLLM path today; RLM only runs via docker-vllm or DMR.
        return null;
    }
  }

  if (runtime === 'docker-ollama') {
    // Ollama Docker containers need GPU passthrough on this host to actually
    // serve models at usable speed. The hostOs gate is captured in
    // dockerSupportsGpu() (mac-docker-ollama → false; windows-docker-wsl2 →
    // true unconditionally (Docker WSL2 native passthrough); linux → true).
    if (!dockerSupportsGpu()) return null;
    switch (mode) {
      case 'ss-embedding':
        return {
          image: 'ollama/ollama',
          model: 'qwen3-embedding:0.6b',
          port: 11434,
          vram: 1200,
          type: 'ollama',
          modes: ['indexing', 'searching'],
          containerName,
          priority: 'high',
          runtime: 'docker',
        };
      case 'ss-completion':
        return {
          image: 'ollama/ollama',
          model: 'qwen3.5:9b',
          port: 11435,
          vram: 10000,
          type: 'ollama',
          modes: ['searching'],
          containerName,
          priority: 'normal',
          runtime: 'docker',
        };
      case 'ss-ocr':
        return {
          image: 'ollama/ollama',
          model: 'minicpm-v:latest',
          port: 11436,
          vram: 5000,
          type: 'ollama',
          modes: ['indexing'],
          containerName,
          gpuOnly: true,
          priority: 'critical',
          runtime: 'docker',
        };
      case 'ss-reranker':
        // vLLM, not Ollama, runs the reranker.
        return null;
      case 'ss-rlm':
        // vLLM, not Ollama, runs RLM.
        return null;
    }
  }

  if (runtime === 'docker-vllm') {
    if (!dockerSupportsGpu()) return null;
    if (mode === 'ss-reranker') {
      return {
        image: 'vllm/vllm-openai',
        model: 'Qwen/Qwen3-Reranker-8B',
        port: 8099,
        vram: 7000,
        type: 'vllm',
        modes: ['searching'],
        containerName,
        priority: 'normal',
        runtime: 'docker',
      };
    }
    if (mode === 'ss-rlm') {
      return {
        image: 'vllm/vllm-openai',
        model: 'mit-oasys/rlm-qwen3-8b-v0.1',
        port: 8100,
        vram: 10000,
        type: 'vllm',
        modes: ['searching'],
        containerName,
        priority: 'high',
        runtime: 'docker',
        vllmArgs: RLM_VLLM_ARGS,
      };
    }
    return null;
  }

  // docker-model-runner: Apple Silicon vllm-metal (and Linux DMR) reachable at
  // dmrHost:dmrPort. Resolves a ContainerDef for ss-embedding / ss-completion
  // / ss-ocr / ss-reranker so the master's "Docker Model Runner" column on
  // /admin/roleassign produces a working route for these roles when picked.
  //
  // Refusals (returns null):
  //   ss-rlm — no MLX conversion of mit-oasys/rlm-qwen3-8b-v0.1 is published;
  //            vllm-metal needs MLX weights, not stock HF safetensors. RLM
  //            stays on docker-vllm for Linux/Windows+NVIDIA hosts.
  //   ss-reranker on mac-docker-ollama — vllm-metal lacks cross-encoder head
  //            (vllm-metal#361); the master's mode.availableOn already filters
  //            Mac out, this is just belt-and-suspenders.
  //
  // image is the sentinel 'docker-model-runner' — the sidecar's start handler
  // does NOT docker-run for runtime==='docker-model-runner'; it forwards to
  // DMR's OpenAI-compatible API on dmrHost:dmrPort. The port here is the
  // role's logical port; the master rewrites it to state.dmrPort at routing
  // time (see fleet-router pushModelRegistry).
  if (runtime === 'docker-model-runner') {
    if (mode === 'ss-rlm') return null;
    if (mode === 'ss-reranker' && hostOs === 'mac-docker-ollama') return null;
    switch (mode) {
      case 'ss-embedding':
        return {
          image: 'docker-model-runner',
          model: 'qwen3-embedding:0.6b',
          port: 11434,
          vram: 1200,
          type: 'vllm',
          modes: ['indexing', 'searching'],
          containerName,
          priority: 'high',
          runtime: 'docker-model-runner',
        };
      case 'ss-completion':
        return {
          image: 'docker-model-runner',
          model: 'qwen3.5:9b',
          port: 11435,
          vram: 10000,
          type: 'vllm',
          modes: ['searching'],
          containerName,
          priority: 'normal',
          runtime: 'docker-model-runner',
        };
      case 'ss-ocr':
        return {
          image: 'docker-model-runner',
          model: 'minicpm-v:latest',
          port: 11436,
          vram: 5000,
          type: 'vllm',
          modes: ['indexing'],
          containerName,
          priority: 'critical',
          runtime: 'docker-model-runner',
        };
      case 'ss-reranker':
        return {
          image: 'docker-model-runner',
          model: 'Qwen/Qwen3-Reranker-8B',
          port: 8099,
          vram: 7000,
          type: 'vllm',
          modes: ['searching'],
          containerName,
          priority: 'normal',
          runtime: 'docker-model-runner',
        };
    }
    return null;
  }

  return null;
}
