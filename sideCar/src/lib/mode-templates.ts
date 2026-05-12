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
 * `ss-reranker` on `darwin` — vllm-metal lacks cross-encoder support).
 *
 * Internal registry keys remain the short role name (`embedding`,
 * `completion`, `ocr`, `reranker`) for back-compat with state.idleTimeouts,
 * state.minOnline, state.perRole, containerName, etc. The `ss-` prefix is
 * the wire/API identifier; `modeToRole()` strips it.
 */
import { CONTAINER_PREFIX, type ContainerDef } from './state';

export type ModeName = 'ss-embedding' | 'ss-completion' | 'ss-ocr' | 'ss-reranker';
export const ALL_MODES: ModeName[] = ['ss-embedding', 'ss-completion', 'ss-ocr', 'ss-reranker'];
export type HostOs = 'darwin' | 'win32' | 'linux' | 'unknown';

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
export function resolveMode(mode: ModeName, hostOs: HostOs): ContainerDef | null {
  const role = modeToRole(mode);
  const containerName = `${CONTAINER_PREFIX}${role}`;

  // win32 currently behaves like darwin for defaults (host-Ollama).
  // WSL2+NVIDIA could later resolve to the linux entry; out of scope here.
  const isLinux = hostOs === 'linux';

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
            image: '',
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
            image: '',
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
            image: '',
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
      // support on Apple Silicon. See vllm-metal#361. Windows defaults to
      // the same Mac path (host-Ollama) unless WSL2+NVIDIA is detected —
      // also unavailable in that default.
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
