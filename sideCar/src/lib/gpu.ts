import { state, dockerSupportsGpu, type GpuInfo } from './state';
import { dockerRequest, dockerRequestWithBody, pullImage, execInContainer, getContainerState } from './docker';
import { createLogger } from './logger';

const log = createLogger('gpu');

// Use CUDA 12.4 base — matches driver 550+ (most current fleet machines)
// Only used for nvidia-smi queries, not for running CUDA workloads
const GPU_IMAGE = 'nvidia/cuda:12.4.1-base-ubuntu22.04';
const GPU_CONTAINER = 'ss-cuda';
const NVIDIA_SMI_CMD = ['nvidia-smi', '--query-gpu=index,name,memory.total,memory.used,memory.free,temperature.gpu', '--format=csv,noheader,nounits'];
// Per-process attribution. `nvidia-smi --query-compute-apps` reports every
// process that has an open CUDA context on the GPU, with its host PID and
// actual VRAM usage. Combined with `docker inspect`'s State.Pid we can map
// each PID to a managed container — gives us truthful per-role VRAM
// regardless of whether the container is Ollama, vLLM, or anything else.
const NVIDIA_SMI_PROCS_CMD = ['nvidia-smi', '--query-compute-apps=pid,used_memory,process_name', '--format=csv,noheader,nounits'];

let imageReady = false;

/** Ensure the CUDA image exists locally. Pulls once if missing. */
async function ensureImage(): Promise<boolean> {
  if (imageReady) return true;
  const { status } = await dockerRequest('GET', `/images/${encodeURIComponent(GPU_IMAGE)}/json`);
  if (status === 200) {
    imageReady = true;
    return true;
  }
  log.info(`GPU image not found locally, pulling ${GPU_IMAGE}...`);
  try {
    await pullImage(GPU_IMAGE);
    imageReady = true;
    return true;
  } catch (err) {
    log.error(`Failed to pull GPU image: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Decide whether the ss-cuda nvidia-smi probe container is meaningful on
 * this host. Returns false when:
 *   - The host is macOS or Windows (no NVIDIA runtime in Docker Desktop —
 *     creating the container always fails with "could not select device
 *     driver", and we'd needlessly pull the ~200 MB nvidia/cuda image).
 *   - Host-Ollama mode is on (Ollama runs natively on the host and reports
 *     `size_vram` directly via /api/ps; the planner uses
 *     SS_HOST_OLLAMA_BUDGET_MB for device totals instead of nvidia-smi).
 *
 * Cheap: reads cached state set at boot by host-os.ts.
 */
function shouldSkipCudaProbe(): { skip: boolean; reason?: string } {
  if (state.hostOllamaEnabled) {
    return { skip: true, reason: 'host-ollama mode (Ollama runs natively, no nvidia-smi needed)' };
  }
  if (state.hostOs === 'darwin') {
    return { skip: true, reason: 'host is macOS (no NVIDIA runtime in Docker Desktop)' };
  }
  if (state.hostOs === 'win32') {
    // Windows Docker Desktop can technically pass NVIDIA GPUs through to
    // Linux containers when the operator has installed the NVIDIA CUDA on
    // WSL2 drivers AND configured Docker Desktop's WSL2 backend with the
    // NVIDIA runtime. Most installs skip that, so the container-side probe
    // fails with "failed to discover GPU vendor from CDI: no known GPU
    // vendor found". For Windows we prefer the host-side companion script
    // path — it works regardless of WSL passthrough — and skip the probe.
    // If `state.hasNvidiaSmi` is true (set when the companion script has
    // confirmed nvidia-smi.exe), `gpuCache` is already populated by
    // /api/host-stats and downstream code uses it transparently.
    return { skip: true, reason: 'host is Windows (use companion script via /api/host-stats)' };
  }
  return { skip: false };
}

/** Ensure the persistent ss-cuda container is running. Creates + starts if needed. */
async function ensureCudaContainer(): Promise<boolean> {
  const guard = shouldSkipCudaProbe();
  if (guard.skip) {
    // Latch into the cudaUnavailable state so callers (discoverGpus) bail
    // out cleanly without pulling the nvidia/cuda image or attempting any
    // Docker writes.
    if (!state.cudaUnavailable) {
      log.info(`ss-cuda probe skipped: ${guard.reason}`);
      state.cudaUnavailable = true;
    }
    return false;
  }
  const cs = await getContainerState(GPU_CONTAINER);

  if (cs.status === 'running') return true;

  if (cs.exists && cs.status !== 'running') {
    // Exists but stopped — try to start it
    const { status, body: startBody } = await dockerRequest('POST', `/containers/${GPU_CONTAINER}/start`);
    if (status === 204 || status === 304) {
      log.info('ss-cuda container restarted');
      return true;
    }
    // Log the actual Docker error so we can diagnose
    log.warn(`ss-cuda start failed (${status}): ${startBody?.slice(0, 300) || 'no body'}`);

    // If start failed, DON'T immediately delete+recreate — that causes a create/delete loop.
    // Only recreate if the container is in a truly broken state (not just a GPU access issue).
    if (status === 500 && startBody?.includes('could not select device driver')) {
      // NVIDIA runtime not available — don't loop, just report
      log.error('ss-cuda: NVIDIA runtime not available on this host. Skipping GPU container.');
      state.cudaUnavailable = true;
      return false;
    }

    // For other errors, try recreate once
    if (!state.cudaRetried) {
      state.cudaRetried = true;
      log.info('ss-cuda: removing and recreating (one attempt)...');
      await dockerRequest('DELETE', `/containers/${GPU_CONTAINER}?force=true`);
    } else {
      // Already retried — don't loop
      log.warn('ss-cuda: already retried recreate, backing off');
      return false;
    }
  }

  // Skip if we know CUDA isn't available on this host
  if (state.cudaUnavailable) return false;

  // Create fresh
  if (!await ensureImage()) return false;

  const { status, body } = await dockerRequestWithBody('POST', `/containers/create?name=${GPU_CONTAINER}`, {
    Image: GPU_IMAGE,
    Cmd: ['sleep', 'infinity'],
    HostConfig: {
      DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }],
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });

  if (status === 409) {
    // Race: created between our check and now — just start it
    await dockerRequest('POST', `/containers/${GPU_CONTAINER}/start`);
    log.info('ss-cuda container already existed, started');
    return true;
  }

  if (status !== 201) {
    log.error(`ss-cuda create failed: ${status} ${body?.slice(0, 300) || 'no body'}`);
    return false;
  }

  const containerId = JSON.parse(body).Id;
  const { status: startStatus, body: startErrBody } = await dockerRequest('POST', `/containers/${containerId}/start`);
  if (startStatus !== 204 && startStatus !== 304) {
    log.error(`ss-cuda start failed after create: ${startStatus} ${startErrBody?.slice(0, 300) || ''}`);
    return false;
  }

  log.info('ss-cuda container created and started');
  state.cudaRetried = false; // reset retry flag on success
  return true;
}

function parseNvidiaSmiOutput(raw: string): GpuInfo[] {
  return raw.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(',').map((s) => s.trim());
    return {
      index: parseInt(parts[0], 10),
      name: parts[1],
      memoryTotal: parseInt(parts[2], 10),
      memoryUsed: parseInt(parts[3], 10),
      memoryFree: parseInt(parts[4], 10),
      temperature: parseInt(parts[5], 10),
    };
  });
}

/** One GPU compute-app row from nvidia-smi. */
export interface GpuProcess {
  pid: number;
  usedMemoryMb: number;
  processName: string;   // e.g. "python", "ollama runner"
}

function parseNvidiaSmiProcsOutput(raw: string): GpuProcess[] {
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map((line) => {
    // nvidia-smi sometimes emits "[Not Supported]" rows on consumer GPUs
    // without process accounting enabled — skip those defensively.
    if (/not\s*supported/i.test(line)) return null;
    const parts = line.split(',').map((s) => s.trim());
    const pid = parseInt(parts[0], 10);
    const usedMb = parseInt(parts[1], 10);
    if (!pid || !Number.isFinite(pid) || !Number.isFinite(usedMb)) return null;
    return { pid, usedMemoryMb: usedMb, processName: parts[2] || 'unknown' };
  }).filter((x): x is GpuProcess => x !== null);
}

/**
 * Discover per-process GPU memory attribution.
 * Returns a flat list of {pid, usedMemoryMb, processName} entries. Each
 * process holding a CUDA context on the GPU shows up here.
 *
 * Cached for the same TTL as `discoverGpus` and reuses the same ss-cuda
 * container — no extra Docker calls in the steady state.
 *
 * On Mac / Windows without WSL2 passthrough, or when ss-cuda isn't
 * available, returns an empty array (silent).
 */
export async function discoverGpuProcesses(): Promise<GpuProcess[]> {
  if (state.gpuProcessCache && Date.now() - state.gpuProcessCacheTime < state.GPU_CACHE_TTL) {
    return state.gpuProcessCache;
  }
  // Reuse the host-helper path: if a Mac/Windows helper script POSTed
  // gpus[] with embedded processes[], surface those rows.
  const hs = state.hostStats;
  if (hs && Date.now() - hs.at <= state.HOST_STATS_TTL_MS && Array.isArray(hs.gpus)) {
    const flat: GpuProcess[] = [];
    for (const g of hs.gpus) {
      if (Array.isArray(g.processes)) {
        for (const p of g.processes) {
          flat.push({
            pid: p.pid,
            usedMemoryMb: Math.round((p.usedMemory || 0) / (1024 * 1024)),
            processName: p.name || 'unknown',
          });
        }
      }
    }
    if (flat.length > 0) {
      state.gpuProcessCache = flat;
      state.gpuProcessCacheTime = Date.now();
      return flat;
    }
  }
  // No GPU here at all? Return empty silently.
  if (!dockerSupportsGpu() || state.cudaUnavailable) {
    state.gpuProcessCache = [];
    state.gpuProcessCacheTime = Date.now();
    return [];
  }
  try {
    if (!await ensureCudaContainer()) {
      state.gpuProcessCache = [];
      state.gpuProcessCacheTime = Date.now();
      return [];
    }
    const { exitCode, output } = await execInContainer(GPU_CONTAINER, NVIDIA_SMI_PROCS_CMD, { timeoutMs: 5_000 });
    if (exitCode !== 0) {
      log.debug(`nvidia-smi compute-apps exit ${exitCode}: ${output.slice(0, 150)}`);
      state.gpuProcessCache = [];
      state.gpuProcessCacheTime = Date.now();
      return [];
    }
    const procs = parseNvidiaSmiProcsOutput(output);
    state.gpuProcessCache = procs;
    state.gpuProcessCacheTime = Date.now();
    return procs;
  } catch (err) {
    log.debug(`discoverGpuProcesses failed: ${(err as Error).message}`);
    state.gpuProcessCache = [];
    state.gpuProcessCacheTime = Date.now();
    return [];
  }
}

/**
 * Map each managed container's `State.Pid` (host PID) so we can attribute
 * GPU processes to roles. Returns role → host PID.
 * Container PIDs are stable for the container's lifetime — cached briefly
 * to avoid hammering the Docker API.
 */
let containerPidCache: { at: number; pids: Record<string, number> } = { at: 0, pids: {} };
const CONTAINER_PID_TTL = 15_000;

export async function getRoleHostPids(): Promise<Record<string, number>> {
  if (Date.now() - containerPidCache.at < CONTAINER_PID_TTL) return containerPidCache.pids;
  const pids: Record<string, number> = {};
  for (const [role, def] of Object.entries(state.registry)) {
    if (def.runtime === 'host' || def.runtime === 'docker-model-runner') continue;
    try {
      const { status, body } = await dockerRequest('GET', `/containers/${def.containerName}/json`);
      if (status !== 200) continue;
      const inspect = JSON.parse(body);
      const pid = inspect?.State?.Pid;
      if (typeof pid === 'number' && pid > 0) pids[role] = pid;
    } catch {
      // Container may not exist on this sidecar — skip silently.
    }
  }
  containerPidCache = { at: Date.now(), pids };
  return pids;
}

export async function discoverGpus(): Promise<GpuInfo[]> {
  if (state.gpuCache && Date.now() - state.gpuCacheTime < state.GPU_CACHE_TTL) {
    return state.gpuCache;
  }

  state.GPU_CACHE_TTL = 30_000;

  // Host-side companion script path (Mac and Windows). When the helper has
  // posted recent stats with gpus[], surface them directly — no Docker
  // round-trip, no nvidia-smi exec inside a container. The cache TTL is
  // longer (60s) to match the helper's polling rate without thrashing.
  const hs = state.hostStats;
  if (hs && Array.isArray(hs.gpus) && hs.gpus.length > 0
      && Date.now() - hs.at <= state.HOST_STATS_TTL_MS) {
    state.gpuCache = hs.gpus;
    state.gpuCacheTime = Date.now();
    return hs.gpus;
  }

  // Short-circuit on hosts where Docker can't surface a GPU AT ALL:
  // - macOS / Windows Docker Desktop (no GPU passthrough)
  // - Hosts that already failed CUDA probe once (cudaUnavailable latched)
  // Returning the cached empty array here keeps the entire chain silent.
  // Without this, every snapshotVram() / autoProvision() / heartbeat call
  // calls ensureCudaContainer() → throws → logs ERROR. On a Mac that fires
  // 5+ times per second.
  if (!dockerSupportsGpu() || state.cudaUnavailable) {
    state.gpuCache = state.gpuCache ?? [];
    state.gpuCacheTime = Date.now();
    state.GPU_CACHE_TTL = 60_000;
    return state.gpuCache;
  }

  try {
    if (!await ensureCudaContainer()) {
      throw new Error('ss-cuda container not available');
    }

    const { exitCode, output } = await execInContainer(GPU_CONTAINER, NVIDIA_SMI_CMD, { timeoutMs: 10_000 });
    if (exitCode !== 0) {
      throw new Error(`nvidia-smi exit ${exitCode}: ${output.slice(0, 200)}`);
    }

    const gpus = parseNvidiaSmiOutput(output);
    state.gpuCache = gpus;
    state.gpuCacheTime = Date.now();
    log.info(`Discovered ${gpus.length} GPU(s)`);
    return gpus;
  } catch (err) {
    // Demote to debug-level log if we already know this host won't recover
    // (cudaUnavailable latched by ensureCudaContainer on first failure).
    // The first failure is still surfaced at WARN level by ensureCudaContainer
    // itself; this catch handles the throw from `!await ensureCudaContainer()`.
    if (state.cudaUnavailable) {
      log.debug(`GPU discovery skipped: ${(err as Error).message}`);
    } else {
      log.error(`GPU discovery failed: ${(err as Error).message}`);
    }
    state.gpuCacheTime = Date.now();
    state.GPU_CACHE_TTL = 60_000;
    return state.gpuCache || [];
  }
}
