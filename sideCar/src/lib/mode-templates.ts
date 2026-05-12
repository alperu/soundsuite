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

export type ModeName = 'ss-embedding' | 'ss-completion' | 'ss-ocr' | 'ss-reranker';
export const ALL_MODES: ModeName[] = ['ss-embedding', 'ss-completion', 'ss-ocr', 'ss-reranker'];
export type HostOs = 'mac-docker-ollama' | 'windows-docker-wsl2' | 'linux' | 'unknown';
export type RuntimeChoice = 'host' | 'docker-ollama' | 'docker-vllm' | 'docker-model-runner';

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
  const containerName = `${CONTAINER_PREFIX}${role}`;

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
    }
  }

  if (runtime === 'docker-vllm') {
    if (!dockerSupportsGpu()) return null;
    if (mode !== 'ss-reranker') return null;
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

  // docker-model-runner: reserved for forward-compat; not exposed in the
  // operator UI yet. Refuse here so callers fall through.
  return null;
}
