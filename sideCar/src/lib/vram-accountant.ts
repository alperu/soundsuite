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
import { discoverGpus, discoverGpuProcesses, getRoleHostPids } from './gpu';
import { createLogger } from './logger';
import http from 'http';

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
  /** Provenance for totalMb/freeMb. 'nvidia-smi' on Linux+NVIDIA hosts;
   *  'host-declared' when host-Ollama is enabled and the operator set
   *  SS_HOST_OLLAMA_BUDGET_MB; 'unknown' when neither source is available
   *  (the planner falls back to per-role declared `def.vram`). */
  vramSource?: 'nvidia-smi' | 'host-declared' | 'host-helper' | 'unknown';
}

/**
 * Per-model entry for the inferenceMemory block.
 */
export interface InferenceModelEntry {
  name: string;
  role: string | null;     // mapped role if def.model matches; null otherwise
  sizeVramMb: number;
}

/**
 * "Sound Suite inference memory" — accurate, in-container snapshot of what
 * the host's Ollama is holding for Sound Suite right now. Distinct from
 * device-level VRAM (Linux+NVIDIA) and from host-wide RAM pressure (Mac
 * helper). This is the "can I fit one more model?" answer.
 */
export interface InferenceMemorySnapshot {
  usedMb: number;          // sum(size_vram) across loaded models on host Ollama
  budgetMb: number;        // operator-declared SS_HOST_OLLAMA_BUDGET_MB (0 if unset)
  freeMb: number;          // max(0, budgetMb - usedMb); 0 when budgetMb=0
  models: InferenceModelEntry[];
}

/**
 * Snapshot Sound Suite's host-Ollama inference memory. Used by /api/status
 * to surface "what is currently loaded for inference, and how much budget
 * is left." Pure Tier 1 — works without any host-side helper.
 *
 * Returns zeroed snapshot when host-Ollama is disabled or when /api/ps
 * fails (still includes budgetMb so the UI can render "0 / 16384 MB used").
 */
export async function snapshotInferenceMemory(): Promise<InferenceMemorySnapshot> {
  const budgetMb = state.hostOllamaEnabled ? state.hostOllamaBudgetMb : 0;
  const models: InferenceModelEntry[] = [];
  let usedMb = 0;

  if (state.hostOllamaEnabled) {
    // Pick any host-runtime role just for URL resolution — they share one endpoint.
    const sampleHostRole = Object.entries(state.registry).find(([, d]) => d.runtime === 'host');
    if (sampleHostRole) {
      try {
        const ps = await ollamaPs(sampleHostRole[1].port, sampleHostRole[0]);
        for (const m of ps) {
          const sizeMb = Math.round((m.sizeVram || 0) / (1024 * 1024));
          // Try to find a role whose def.model matches this loaded model.
          let mappedRole: string | null = null;
          for (const [role, def] of Object.entries(state.registry)) {
            if (!def.model) continue;
            const base = def.model.split(':')[0];
            if (m.name === def.model || m.name.startsWith(`${base}:`) || m.name.includes(base)) {
              mappedRole = role;
              break;
            }
          }
          models.push({ name: m.name, role: mappedRole, sizeVramMb: sizeMb });
          usedMb += sizeMb;
        }
      } catch (err) {
        log.info(`snapshotInferenceMemory: ollamaPs failed: ${(err as Error).message}`);
      }
    }
  }

  const freeMb = budgetMb > 0 ? Math.max(0, budgetMb - usedMb) : 0;
  return { usedMb, budgetMb, freeMb, models };
}

/**
 * Scrape vLLM's Prometheus `/metrics` endpoint for a measured VRAM total.
 * vLLM doesn't have an `ollama ps`-equivalent, but it does expose:
 *   - vllm:gpu_cache_usage_perc      (0..1, fraction of the KV-cache slab in use)
 *   - vllm:num_gpu_blocks_total      (KV-cache pool block count)
 *
 * We can't reliably compute exact bytes from those alone — vLLM pre-allocates
 * `gpu_memory_utilization × device_total` at startup and uses it for both
 * weights and the KV pool. The HONEST answer for "how much VRAM does this
 * vLLM container hold?" is "the configured slab, period" — that's what
 * nvidia-smi sees per-process. So this function returns null and the caller
 * should prefer the per-process attribution path. Kept for completeness if
 * vLLM ever adds a `vllm:gpu_memory_bytes` metric.
 */
async function scrapeVllmMetrics(port: number): Promise<{ kvUsedPct?: number } | null> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port, path: '/metrics', method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        const m = body.match(/^vllm:gpu_cache_usage_perc(?:\{[^}]*\})?\s+([\d.eE+-]+)/m);
        resolve({ kvUsedPct: m ? parseFloat(m[1]) : undefined });
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2_000, () => { req.destroy(); resolve(null); });
    req.end();
  });
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
  let vramSource: 'nvidia-smi' | 'host-declared' | 'unknown' = 'unknown';
  try {
    const gpus = await discoverGpus();
    for (const g of gpus) {
      totalMb += g.memoryTotal;
      freeMb += g.memoryFree;
    }
    if (gpus.length > 0) vramSource = 'nvidia-smi';
  } catch (err) {
    log.warn(`snapshotVram: nvidia-smi unavailable: ${(err as Error).message}`);
  }

  const perRole: Record<string, RoleVramSnapshot> = {};
  let attributedMb = 0;

  // Cache the host-runtime Ollama /api/ps result. All host-runtime roles
  // share ONE Ollama process — querying once per role triple-counts VRAM
  // and triggers redundant HTTP roundtrips. Fetch the list once, then
  // attribute each loaded model to the role whose `def.model` matches.
  let hostOllamaPs: Awaited<ReturnType<typeof ollamaPs>> | null = null;
  const hasHostRole = Object.values(state.registry).some(d => d.runtime === 'host');
  if (hasHostRole) {
    // Pick any host-runtime role just for URL resolution — they all share
    // the same endpoint (host.docker.internal:HOST_OLLAMA_PORT).
    const sampleHostRole = Object.entries(state.registry).find(([, d]) => d.runtime === 'host');
    if (sampleHostRole) {
      try {
        hostOllamaPs = await ollamaPs(sampleHostRole[1].port, sampleHostRole[0]);
      } catch (err) {
        log.info(`snapshotVram: shared ollamaPs failed: ${(err as Error).message}`);
        hostOllamaPs = [];
      }
    }
  }

  // Per-process GPU attribution. When available (Linux+NVIDIA or
  // Windows-with-helper), this gives us truthful per-container VRAM —
  // matters most for vLLM, which holds a static slab the size of
  // `gpu_memory_utilization × device_total` (often 40+ GB) but has no
  // per-model size endpoint to query.
  //
  // We map each managed Docker container's host PID (from State.Pid) to
  // the rows nvidia-smi returns under `--query-compute-apps`. Sum per role.
  const procs = vramSource === 'nvidia-smi' ? await discoverGpuProcesses() : [];
  const rolePids = procs.length > 0 ? await getRoleHostPids() : {};
  const rolePidToRole: Record<number, string> = {};
  for (const [role, pid] of Object.entries(rolePids)) rolePidToRole[pid] = role;
  // Linux containers may spawn child PIDs that hold the CUDA context. We
  // can detect parent→child via /proc on the host, but that needs host
  // mount. Cheap heuristic: any process whose PID == container's main PID
  // counts directly. Anything else falls into "unattributed" — better
  // than over-reporting a role's footprint.
  const procVramByRole: Record<string, number> = {};
  for (const p of procs) {
    const r = rolePidToRole[p.pid];
    if (r) procVramByRole[r] = (procVramByRole[r] || 0) + p.usedMemoryMb;
  }

  for (const [role, def] of Object.entries(state.registry)) {
    const isHost = def.runtime === 'host';
    const cs = isHost ? null : await getContainerState(def.containerName).catch(() => null);
    const containerStatus = isHost ? 'running' : (cs?.status ?? 'unknown');
    const isRunning = containerStatus === 'running';

    let actualMb = 0;
    let loaded = false;

    if (def.type === 'ollama' && isRunning) {
      if (isHost) {
        // Host-runtime: attribute by model name from the SHARED ollamaPs
        // result. Each loaded model belongs to exactly one role (the one
        // whose def.model matches). Avoids triple-counting when multiple
        // roles share one Ollama endpoint.
        if (hostOllamaPs && def.model) {
          const modelBase = def.model.split(':')[0];
          for (const m of hostOllamaPs) {
            if (m.name === def.model || m.name.startsWith(`${modelBase}:`) || m.name.includes(modelBase)) {
              actualMb += m.sizeVram || 0;
            }
          }
          actualMb = Math.round(actualMb / (1024 * 1024));
          loaded = actualMb > 0;
        }
      } else {
        try {
          const ps = await ollamaPs(def.port, role);
          for (const m of ps) actualMb += m.sizeVram || 0;
          // Convert bytes → MB. Ollama reports size_vram in bytes.
          actualMb = Math.round(actualMb / (1024 * 1024));
          loaded = actualMb > 0;
        } catch (err) {
          log.info(`snapshotVram: ollamaPs failed for ${role}: ${(err as Error).message}`);
        }
      }
    } else if (def.type === 'vllm' && isRunning) {
      // vLLM holds a fixed slab = `gpu_memory_utilization × device_total`
      // at startup and never gives it back to the driver until the
      // container exits. There's no `ollama ps` equivalent for vLLM, so
      // there are three signals in priority order:
      //
      //   1. Per-process VRAM from nvidia-smi --query-compute-apps mapped
      //      via State.Pid → role. Truthful, matches what nvidia-smi sees
      //      at the device level. Works when ss-cuda is up (Linux+NVIDIA
      //      or Windows-with-helper).
      //   2. Optional vLLM /metrics scrape — gives us KV cache utilization
      //      but not the slab size itself. Surfaced as info only.
      //   3. Static def.vram budget as last-resort fallback. Conservative
      //      under-estimate when gpu-memory-utilization >> def.vram (e.g.
      //      0.95 of 48GB ≈ 45GB vs def.vram=7000) — that's why "33 GB
      //      unattributed" appeared in production before this fix.
      // vLLM forks worker processes whose PIDs differ from the container's
      // State.Pid that getRoleHostPids reads. nvidia-smi sees the workers
      // but the parent-PID match misses them — procVramByRole[role] ends
      // up at 0 or much smaller than reality. Trust per-process attribution
      // only when it covers at least half the role's declared budget;
      // otherwise fall through to the 0.95×total estimate. Truthful values
      // beat plausible-but-wrong ones in the admin UI.
      const procAttribMb = procVramByRole[role];
      const procIsCredible = typeof procAttribMb === 'number'
        && procAttribMb > 0
        && (def.vram === 0 || procAttribMb >= def.vram * 0.5);
      if (procIsCredible) {
        actualMb = procAttribMb;
      } else if (totalMb > 0) {
        // No per-process attribution available. Make the static fallback
        // truthful: vLLM is launched with --gpu-memory-utilization 0.95
        // (see docker.ts buildVllmCmd), so it actually holds ~95% of
        // device_total. Use that instead of the much-smaller def.vram
        // budget — without this, the UI under-reports by tens of GB and
        // surfaces a misleading "unattributed" delta.
        const VLLM_DEFAULT_GPU_MEM_UTIL = 0.95;
        actualMb = Math.round(totalMb * VLLM_DEFAULT_GPU_MEM_UTIL);
      } else {
        actualMb = def.vram;
      }
      // Best-effort enrichment from /metrics — doesn't change actualMb,
      // but useful diagnostics if surfaced upward later.
      try {
        await scrapeVllmMetrics(def.port);
      } catch { /* metrics is optional */ }
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

  // Host-Ollama fallback: when nvidia-smi reports nothing AND operator set a
  // declared budget, use that as totalMb. CRITICAL: usedMb must include EVERY
  // loaded model on the host Ollama, even ones whose name doesn't match any
  // role's def.model. Otherwise a manually-pulled model (e.g. operator did
  // `ollama pull minicpm-v` directly, but the OCR role's def.model is
  // `richardyoung/olmocr2:7b-q8`) shows up in `ollama ps` but disappears
  // from our usedMb calc, making the UI read "1.3 GB used" when actually
  // 6.1 GB is loaded. The unattributed delta surfaces separately so the
  // operator can see "model X is loaded but no role claims it."
  let totalLoadedMb = 0;
  if (hostOllamaPs) {
    for (const m of hostOllamaPs) totalLoadedMb += Math.round((m.sizeVram || 0) / (1024 * 1024));
  }
  if (vramSource === 'unknown' && state.hostOllamaEnabled && state.hostOllamaBudgetMb > 0) {
    totalMb = state.hostOllamaBudgetMb;
    freeMb = Math.max(0, totalMb - totalLoadedMb);
    vramSource = 'host-declared';
  }
  const usedMb = vramSource === 'host-declared'
    ? totalLoadedMb
    : Math.max(0, totalMb - freeMb);
  // unattributedMb captures models loaded on the shared Ollama that no role
  // claims by def.model match — surfaces "stuff loaded that we don't own."
  const unattributedMb = vramSource === 'host-declared'
    ? Math.max(0, totalLoadedMb - attributedMb)
    : Math.max(0, usedMb - attributedMb);

  return {
    totalMb,
    freeMb,
    usedMb,
    perRole,
    unattributedMb,
    ts: Date.now(),
    vramSource,
  };
}
