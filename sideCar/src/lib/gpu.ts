import { state, type GpuInfo } from './state';
import { dockerRequest, dockerRequestWithBody, pullImage, execInContainer, getContainerState } from './docker';
import { createLogger } from './logger';

const log = createLogger('gpu');

const GPU_IMAGE = 'nvidia/cuda:12.6.3-base-ubuntu24.04';
const GPU_CONTAINER = 'ss-cuda';
const NVIDIA_SMI_CMD = ['nvidia-smi', '--query-gpu=index,name,memory.total,memory.used,memory.free,temperature.gpu', '--format=csv,noheader,nounits'];

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

/** Ensure the persistent ss-cuda container is running. Creates + starts if needed. */
async function ensureCudaContainer(): Promise<boolean> {
  const cs = await getContainerState(GPU_CONTAINER);

  if (cs.status === 'running') return true;

  if (cs.exists && cs.status !== 'running') {
    // Exists but stopped — start it
    const { status } = await dockerRequest('POST', `/containers/${GPU_CONTAINER}/start`);
    if (status === 204 || status === 304) {
      log.info('ss-cuda container restarted');
      return true;
    }
    // Couldn't start — remove and recreate
    log.warn(`ss-cuda start returned ${status}, recreating...`);
    await dockerRequest('DELETE', `/containers/${GPU_CONTAINER}?force=true`);
  }

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
    log.error(`ss-cuda create failed: ${status} ${body.slice(0, 200)}`);
    return false;
  }

  const { status: startStatus } = await dockerRequest('POST', `/containers/${JSON.parse(body).Id}/start`);
  if (startStatus !== 204 && startStatus !== 304) {
    log.error(`ss-cuda start failed: ${startStatus}`);
    return false;
  }

  log.info('ss-cuda container created and started');
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

export async function discoverGpus(): Promise<GpuInfo[]> {
  if (state.gpuCache && Date.now() - state.gpuCacheTime < state.GPU_CACHE_TTL) {
    return state.gpuCache;
  }

  state.GPU_CACHE_TTL = 30_000;

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
    log.error(`GPU discovery failed: ${(err as Error).message}`);
    state.gpuCacheTime = Date.now();
    state.GPU_CACHE_TTL = 60_000;
    return state.gpuCache || [];
  }
}
