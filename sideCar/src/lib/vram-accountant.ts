/**
 * VRAM accountant — single source of truth for "what's loaded right now."
 *
 * Combines three signals:
 *  1. nvidia-smi (via state.gpuCache, refreshed every 30s by gpu.discoverGpus)
 *     gives total/free/used at the device level — authoritative for "is the
 *     card full?", but not attributable to specific containers.
 *  2. Ollama /api/ps gives exact size_vram per loaded model — authoritative
 *     for Ollama-runtime roles.
 *  3. Registry def.vram is a static budget. Used as the estimate for vLLM
 *     (no /api/ps equivalent) and as the load-time headroom check.
 *
 * The planner (eviction-planner.ts) consumes this snapshot to decide what to
 * unload before loading a critical role.
 */

import { state, type ContainerDef } from './state';
import { getContainerState } from './docker';
import { ollamaPs } from './ollama-api';
import { discoverGpus } from './gpu';
import { createLogger } from './logger';

const log = createLogger('vram-accountant');

export interface RoleVramSnapshot {
  role: string;
  runtime: 'ollama' | 'vllm' | 'utility';
  containerStatus: string;       // 'running' | 'exited' | 'not_found' | etc.
  loaded: boolean;               // true if the container holds VRAM right now
  actualMb: number;              // measured (Ollama) or estimated (vLLM)
  budgetMb: number;              // def.vram from registry
  priority: 'critical' | 'high' | 'normal';
  gpuOnly: boolean;
  modes: ContainerDef['modes'];
}

export interface VramSnapshot {
  // Device-level totals (sum across all GPUs nvidia-smi reports)
  totalMb: number;
  freeMb: number;
  usedMb: number;
  // Per-role attribution (only roles we know about; "other" tracks the
  // unaccounted-for delta caused by Ollama overhead, system processes, etc.)
  perRole: Record<string, RoleVramSnapshot>;
  unattributedMb: number;        // usedMb - sum(perRole.actualMb), clamped >=0
  ts: number;                    // capture timestamp (Date.now())
}

/**
 * Snapshot the GPU + every registered role. Best-effort: failures degrade to
 * "container not running / 0 VRAM" rather than throwing — the planner needs
 * an answer even when a single endpoint is flaky.
 */
export async function snapshotVram(): Promise<VramSnapshot> {
  // Device totals from nvidia-smi cache. discoverGpus is cached for 30s, so
  // calling it on every snapshot is cheap.
  let totalMb = 0;
  let freeMb = 0;
  try {
    const gpus = await discoverGpus();
    for (const g of gpus) {
      totalMb += g.memoryTotal;
      freeMb += g.memoryFree;
    }
  } catch (err) {
    log.warn(`snapshotVram: nvidia-smi unavailable: ${(err as Error).message}`);
  }
  const usedMb = Math.max(0, totalMb - freeMb);

  const perRole: Record<string, RoleVramSnapshot> = {};
  let attributedMb = 0;

  for (const [role, def] of Object.entries(state.registry)) {
    const cs = await getContainerState(def.containerName).catch(() => null);
    const containerStatus = cs?.status ?? 'unknown';
    const isRunning = containerStatus === 'running';

    let actualMb = 0;
    let loaded = false;

    if (def.type === 'ollama' && isRunning) {
      try {
        const ps = await ollamaPs(def.port);
        for (const m of ps) actualMb += m.sizeVram || 0;
        // Convert bytes → MB. Ollama reports size_vram in bytes.
        actualMb = Math.round(actualMb / (1024 * 1024));
        loaded = actualMb > 0;
      } catch (err) {
        log.info(`snapshotVram: ollamaPs failed for ${role}: ${(err as Error).message}`);
      }
    } else if (def.type === 'vllm' && isRunning) {
      // vLLM doesn't expose per-model VRAM; the container holds whatever it
      // pre-allocated at startup (typically gpu_memory_utilization * total).
      // We use the registry budget as a conservative estimate. This is an
      // over-estimate when --gpu-memory-utilization is low, but for planning
      // purposes (will OCR fit?) the over-estimate is the safe direction.
      actualMb = def.vram;
      loaded = true;
    } else if (def.type === 'utility') {
      // ss-cuda holds negligible VRAM (just nvidia-smi calls)
      actualMb = 0;
      loaded = false;
    }

    perRole[role] = {
      role,
      runtime: def.type,
      containerStatus,
      loaded,
      actualMb,
      budgetMb: def.vram,
      priority: def.priority ?? 'normal',
      gpuOnly: def.gpuOnly === true,
      modes: def.modes,
    };
    attributedMb += actualMb;
  }

  return {
    totalMb,
    freeMb,
    usedMb,
    perRole,
    unattributedMb: Math.max(0, usedMb - attributedMb),
    ts: Date.now(),
  };
}
