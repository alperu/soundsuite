import http from 'http';
import fs from 'fs';
import { state } from './state';
import { createLogger } from './logger';

const log = createLogger('docker');

/** Resolved Docker connection — set once by initDocker() or lazily on first use */
let resolvedConnection: { socketPath?: string; hostname?: string; port?: number } | null = null;
let dockerMode: 'socket' | 'tcp' | 'none' = 'none';

function getDefaultSocketPath(): string {
  if (process.platform === 'win32') return '//./pipe/docker_engine';
  return '/var/run/docker.sock';
}

function tcpOpts(host: string): { hostname: string; port: number } {
  const url = new URL(host.replace(/^tcp:\/\//, 'http://'));
  return { hostname: url.hostname, port: parseInt(url.port, 10) || 2375 };
}

/** Ping Docker daemon with a 5s timeout. Returns true if reachable. */
function pingDocker(opts: { socketPath?: string; hostname?: string; port?: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ ...opts, method: 'GET', path: '/_ping' }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 && body === 'OK'));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5_000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Initialize Docker connection. Tries in order:
 * 1. DOCKER_HOST env var (if set)
 * 2. Unix socket /var/run/docker.sock (works on Linux, macOS, and Docker Desktop WSL2)
 * 3. TCP tcp://host.docker.internal:2375 (Docker Desktop with TCP enabled)
 * 4. TCP tcp://localhost:2375
 *
 * Call at sidecar startup. If not called, first Docker operation will trigger it.
 */
export async function initDocker(): Promise<void> {
  // 1. Explicit DOCKER_HOST
  if (process.env.DOCKER_HOST) {
    const host = process.env.DOCKER_HOST;
    if (host.startsWith('tcp://') || host.startsWith('http://')) {
      const opts = tcpOpts(host);
      const ok = await pingDocker(opts);
      if (ok) {
        resolvedConnection = opts;
        dockerMode = 'tcp';
        log.info(`Docker connected via DOCKER_HOST TCP ${host}`);
        await getDockerHostInfo();
        return;
      }
      log.warn(`DOCKER_HOST=${host} set but not reachable — trying fallbacks`);
    } else {
      // Unix socket path from env
      if (fs.existsSync(host)) {
        const opts = { socketPath: host };
        const ok = await pingDocker(opts);
        if (ok) {
          resolvedConnection = opts;
          dockerMode = 'socket';
          log.info(`Docker connected via DOCKER_HOST socket ${host}`);
          await getDockerHostInfo();
          return;
        }
      }
      log.warn(`DOCKER_HOST=${host} not reachable — trying fallbacks`);
    }
  }

  // 2. Unix socket (default path)
  const socketPath = getDefaultSocketPath();
  if (fs.existsSync(socketPath)) {
    const opts = { socketPath };
    const ok = await pingDocker(opts);
    if (ok) {
      resolvedConnection = opts;
      dockerMode = 'socket';
      log.info(`Docker connected via Unix socket ${socketPath}`);
      await getDockerHostInfo();
      return;
    }
    log.warn(`Docker socket exists at ${socketPath} but not responding`);
  }

  // 3. TCP fallback: host.docker.internal:2375 (Docker Desktop from inside a container)
  for (const host of ['host.docker.internal', 'localhost', '127.0.0.1']) {
    const opts = { hostname: host, port: 2375 };
    const ok = await pingDocker(opts);
    if (ok) {
      resolvedConnection = opts;
      dockerMode = 'tcp';
      log.info(`Docker connected via TCP ${host}:2375`);
      await getDockerHostInfo();
      return;
    }
  }

  // Nothing worked — skip host info fetch
  dockerMode = 'none';
  resolvedConnection = null;
  log.error(
    'Docker not reachable. Tried: ' +
    (process.env.DOCKER_HOST ? `DOCKER_HOST=${process.env.DOCKER_HOST}, ` : '') +
    `socket ${socketPath}, TCP host.docker.internal:2375, TCP localhost:2375. ` +
    'Ensure Docker is running and accessible. ' +
    'For Docker-in-Docker: mount -v /var/run/docker.sock:/var/run/docker.sock or enable TCP in Docker Desktop.'
  );
}

/** Build http.request connection options — uses resolved connection or falls back to DOCKER_HOST/socket */
function dockerConnectionOpts(): { socketPath?: string; hostname?: string; port?: number } {
  if (resolvedConnection) return resolvedConnection;
  // Fallback if initDocker() wasn't called yet — use DOCKER_HOST or default socket
  if (process.env.DOCKER_HOST) {
    const host = process.env.DOCKER_HOST;
    if (host.startsWith('tcp://') || host.startsWith('http://')) return tcpOpts(host);
    return { socketPath: host };
  }
  return { socketPath: getDefaultSocketPath() };
}

/** Get current Docker connection mode for diagnostics */
export function getDockerMode(): string { return dockerMode; }

/**
 * Detect if the sidecar itself is running inside a Docker container.
 * When true, 'localhost' refers to the sidecar container, NOT the Docker host.
 */
let _isInDocker: boolean | null = null;
function isRunningInDocker(): boolean {
  if (_isInDocker !== null) return _isInDocker;
  try {
    // /.dockerenv exists inside Docker containers
    if (fs.existsSync('/.dockerenv')) { _isInDocker = true; return true; }
    // Fallback: check cgroup (Linux)
    if (fs.existsSync('/proc/1/cgroup')) {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (cgroup.includes('docker') || cgroup.includes('containerd')) { _isInDocker = true; return true; }
    }
  } catch { /* ignore */ }
  _isInDocker = false;
  return false;
}

/**
 * Get the hostname where Docker container port mappings are reachable.
 * - Bare-metal sidecar + socket mode: ports are on localhost
 * - Sidecar in Docker + socket mode: ports are on host.docker.internal (not localhost!)
 * - TCP mode: ports are on the Docker host's hostname
 * Used by ollama-api.ts to address Ollama containers by their mapped ports.
 *
 * When `role` is provided and the role's registry entry has `runtime: 'host'`,
 * returns `state.hostOllamaHost` (a native Ollama on the Docker host) instead
 * of the Docker container host. Lets ollama-api.ts transparently route to
 * either a managed container or a native host process.
 */
export function getDockerHost(role?: string): string {
  // Host-Ollama runtime: bypass Docker entirely and address the native process.
  if (role) {
    const def = state.registry[role];
    if (def?.runtime === 'host') return state.hostOllamaHost;
    // Docker Model Runner: address DMR's TCP endpoint on the Docker host.
    if (def?.runtime === 'docker-model-runner') return state.dmrHost;
  }
  // TCP mode: Docker host is explicitly known
  if (resolvedConnection?.hostname) return resolvedConnection.hostname;
  // Socket mode: if sidecar runs in Docker, localhost is the sidecar container itself
  if (isRunningInDocker()) return 'host.docker.internal';
  return 'localhost';
}

/** Cached Docker host hostname (from GET /info → Name field) */
let dockerHostName: string | null = null;

/** Get the Docker host's actual hostname via GET /info. Cached after first call. */
export async function getDockerHostInfo(): Promise<{ name: string | null }> {
  if (dockerHostName) return { name: dockerHostName };
  try {
    const { status, body } = await dockerRequest('GET', '/info');
    if (status === 200) {
      const info = JSON.parse(body);
      if (info.Name) {
        dockerHostName = info.Name;
        log.info(`Docker host hostname: ${dockerHostName}`);
      }
    }
  } catch (err) {
    log.warn(`Failed to get Docker host info: ${(err as Error).message}`);
  }
  return { name: dockerHostName };
}

/** Get cached Docker host hostname (non-async, returns null if not yet fetched). */
export function getDockerHostName(): string | null { return dockerHostName; }

/** Check if Docker is reachable. Returns false if initDocker() failed and no fallback is available. */
export function isDockerAvailable(): boolean {
  // Even if initDocker() set mode='none' (e.g. ping timed out), the default socket
  // fallback in dockerConnectionOpts() may still work. Only return false if we
  // explicitly confirmed no connection AND no socket exists as fallback.
  if (resolvedConnection) return true;
  if (dockerMode !== 'none') return true;
  // Fallback: check if default socket exists (dockerConnectionOpts will use it)
  const socketPath = getDefaultSocketPath();
  if (process.env.DOCKER_HOST) return true; // let it try
  return fs.existsSync(socketPath);
}

/** Check if Docker is reachable. Throws a clear error if not. */
export function assertDockerAvailable(): void {
  if (!isDockerAvailable()) {
    throw new Error(
      'Docker is not reachable. Run initDocker() at startup or ensure Docker is running. ' +
      'For Docker-in-Docker: mount -v /var/run/docker.sock:/var/run/docker.sock'
    );
  }
}

interface DockerResponse {
  status: number;
  body: string;
}

export function dockerRequest(method: string, reqPath: string): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...dockerConnectionOpts(), method, path: reqPath },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

export function dockerRequestWithBody(method: string, reqPath: string, body: unknown): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        ...dockerConnectionOpts(),
        method,
        path: reqPath,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.setTimeout(120_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

export interface ContainerState {
  exists: boolean;
  name: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  image?: string;
  cmd?: string[];
  env?: string[];
  role?: string;
  config?: { image: string; model: string | null; port: number; vram: number; type: string; gpuOnly?: boolean };
  loadedModels?: Array<{ name: string; size: string; sizeBytes?: number; sizeVram?: number; gpuPercent?: number; processor: string; until: string }>;
  modelOnDisk?: boolean;
  // For gpuOnly roles: false when the loaded model is partially on CPU and
  // the sidecar could not remediate. The master uses this to refuse routing.
  gpuReady?: boolean;
  error?: string;
}

export async function getContainerState(containerName?: string): Promise<ContainerState> {
  const name = containerName || state.CONTAINER_NAME;
  try {
    const { status, body } = await dockerRequest('GET', `/containers/${name}/json`);
    if (status === 404) return { exists: false, status: 'not_found', name };
    if (status !== 200) return { exists: false, status: 'error', name };
    const data = JSON.parse(body);
    return {
      exists: true,
      name,
      status: data.State?.Status || 'unknown',
      startedAt: data.State?.StartedAt,
      finishedAt: data.State?.FinishedAt,
      image: data.Config?.Image,
      cmd: data.Config?.Cmd || undefined,
      env: data.Config?.Env || undefined,
    };
  } catch (err) {
    return { exists: false, status: 'error', name, error: (err as Error).message };
  }
}

/** Check if a Docker error is a port conflict (bind: address already in use). */
export function isPortConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /bind:|address already in use|port.*not available/i.test(msg);
}

/** Find which container (if any) is bound to a given host port. Returns container name or null. */
export async function findContainerOnPort(port: number): Promise<string | null> {
  try {
    const { status, body } = await dockerRequest('GET', '/containers/json?all=true');
    if (status !== 200) return null;
    const containers: Array<{
      Names: string[];
      Ports?: Array<{ PublicPort?: number }>;
      HostConfig?: { PortBindings?: Record<string, Array<{ HostPort: string }>> };
    }> = JSON.parse(body);
    const portStr = String(port);
    for (const c of containers) {
      // Check Ports array (running containers)
      if (c.Ports?.some(p => p.PublicPort === port)) {
        return c.Names?.[0]?.replace(/^\//, '') || null;
      }
      // Check HostConfig.PortBindings (all containers including stopped)
      if (c.HostConfig?.PortBindings) {
        for (const bindings of Object.values(c.HostConfig.PortBindings)) {
          if (bindings?.some(b => b.HostPort === portStr)) {
            return c.Names?.[0]?.replace(/^\//, '') || null;
          }
        }
      }
    }
  } catch (err) {
    log.warn(`findContainerOnPort(${port}): ${(err as Error).message}`);
  }
  return null;
}

export async function startContainer(containerName?: string): Promise<string> {
  assertDockerAvailable();
  const name = containerName || state.CONTAINER_NAME;
  log.info(`Starting container ${name}`);
  const { status, body } = await dockerRequest('POST', `/containers/${name}/start`);
  if (status !== 204 && status !== 304) {
    throw new Error(`start ${name} failed (${status}): ${body.slice(0, 200)}`);
  }
  const result = status === 304 ? 'already_running' : 'started';
  log.info(`Container ${name}: ${result}`);
  return result;
}

export async function stopContainer(containerName?: string): Promise<string> {
  const name = containerName || state.CONTAINER_NAME;
  log.info(`Stopping container ${name}`);
  const { status, body } = await dockerRequest('POST', `/containers/${name}/stop`);
  if (status !== 204 && status !== 304) {
    throw new Error(`stop ${name} failed (${status}): ${body.slice(0, 200)}`);
  }
  const result = status === 304 ? 'already_stopped' : 'stopped';
  log.info(`Container ${name}: ${result}`);
  return result;
}

export async function removeContainer(containerName: string): Promise<string> {
  log.info(`Removing container ${containerName}`);
  const { status, body } = await dockerRequest('DELETE', `/containers/${containerName}?force=true`);
  if (status === 204 || status === 404) {
    const result = status === 404 ? 'not_found' : 'removed';
    log.info(`Container ${containerName}: ${result}`);
    return result;
  }
  throw new Error(`remove ${containerName} failed (${status}): ${body.slice(0, 200)}`);
}

export interface ExpectedConfig {
  Image: string;
  Cmd?: string[];
  Env?: string[];
}

export function buildExpectedConfig(role: string): ExpectedConfig {
  const def = state.registry[role];
  if (!def) throw new Error(`Unknown role: ${role}`);

  const config: ExpectedConfig = { Image: def.image };

  if (def.type === 'ollama') {
    config.Env = [`OLLAMA_HOST=0.0.0.0:${def.port}`];
  }

  if (def.type === 'vllm' && def.model) {
    config.Cmd = buildVllmCmd(def.model, def.port);
  }

  return config;
}

/** Build vLLM command args for a model. Shared by buildExpectedConfig and createContainer. */
function buildVllmCmd(model: string, port: number): string[] {
  // vLLM 0.8+: model is a positional arg (--model flag deprecated and removed in future)
  const cmd = [model, '--host', '0.0.0.0', '--port', String(port)];
  if (/qwen3-reranker/i.test(model)) {
    // Qwen3-Reranker-8B weights take ~14 GiB; default max-model-len 40960
    // leaves negative KV cache on 16 GiB cards and OOMs at startup.
    // Reranker scoring fits well under 8K tokens.
    cmd.push('--max-model-len', '8192');
    cmd.push('--gpu-memory-utilization', '0.95');
    // Cross-encoder rerank scores a fresh (query, doc) pair every call —
    // there is no shared prefix worth caching. Disabling prefix caching
    // stops KV blocks from accumulating in VRAM across calls.
    cmd.push('--no-enable-prefix-caching');
    // Skip CUDA graph capture. vLLM captures a new graph per batch shape
    // the first time it sees one and never releases them, so VRAM climbs
    // over the first several calls and plateaus near 99% even when idle.
    // Eager mode trades ~5–15% latency for flat VRAM use.
    cmd.push('--enforce-eager');
    cmd.push('--hf-overrides', JSON.stringify({
      architectures: ['Qwen3ForSequenceClassification'],
      is_original_qwen3_reranker: true,
      classifier_from_token: ['no', 'yes'],
    }));
  }
  return cmd;
}

/** Normalize image name by adding :latest if no tag is present */
function normalizeImageTag(image: string): string {
  const colonIdx = image.lastIndexOf(':');
  if (colonIdx <= 0 || image.substring(colonIdx).includes('/')) {
    return image + ':latest';
  }
  return image;
}

export function detectConfigDrift(
  actual: ContainerState,
  expected: ExpectedConfig,
): { hasDrift: boolean; drifts: string[] } {
  const drifts: string[] = [];

  // Image comparison (normalize :latest)
  if (actual.image) {
    const actualImg = normalizeImageTag(actual.image);
    const expectedImg = normalizeImageTag(expected.Image);
    if (actualImg !== expectedImg) {
      drifts.push(`image: ${actual.image} -> ${expected.Image}`);
    }
  }

  // Cmd comparison (deep equality via JSON.stringify — order matters)
  if (expected.Cmd) {
    if (JSON.stringify(actual.cmd) !== JSON.stringify(expected.Cmd)) {
      drifts.push(`cmd: ${JSON.stringify(actual.cmd)} -> ${JSON.stringify(expected.Cmd)}`);
    }
  }

  // Env comparison (subset check — every expected var must be present)
  if (expected.Env && expected.Env.length > 0) {
    const actualEnv = new Set(actual.env || []);
    const missing = expected.Env.filter(v => !actualEnv.has(v));
    if (missing.length > 0) {
      drifts.push(`env missing: ${missing.join(', ')}`);
    }
  }

  return { hasDrift: drifts.length > 0, drifts };
}

export async function createContainer(role: string): Promise<{ Id?: string; exists?: boolean }> {
  assertDockerAvailable();
  const def = state.registry[role];
  if (!def) throw new Error(`Unknown role: ${role}`);
  if (def.type === 'utility') throw new Error(`Utility container '${role}' is managed externally (see gpu.ts)`);


  const name = def.containerName;
  const hostPort = String(def.port);

  const config: Record<string, unknown> = {
    Image: def.image,
    Hostname: name,
    ExposedPorts: { [`${def.port}/tcp`]: {} },
    HostConfig: {
      // Init: true → docker spawns tini as PID-1 inside the container so
      // SIGTERM is forwarded to the Python worker tree. Without it, vLLM
      // C-extension worker threads can deadlock on a kernel call and PID-1
      // (uvicorn) becomes a zombie that `docker stop` cannot kill. Seen on
      // BASWS34 (2026-05-11) — required manual `docker rm -f` on the host.
      // Only affects newly-created containers; existing ones must be
      // recreated to pick this up.
      Init: true,
      PortBindings: { [`${def.port}/tcp`]: [{ HostPort: hostPort }] },
      RestartPolicy: { Name: 'unless-stopped' },
      DeviceRequests: [{ Driver: '', Count: -1, Capabilities: [['gpu']] }],
    },
  };

  if (def.type === 'ollama') {
    (config as Record<string, unknown>).Env = [`OLLAMA_HOST=0.0.0.0:${def.port}`];
    (config.HostConfig as Record<string, unknown>).Binds = ['ollama-models:/root/.ollama'];
  }

  if (def.type === 'vllm' && def.model) {
    (config as Record<string, unknown>).Cmd = buildVllmCmd(def.model, def.port);
    const hc = config.HostConfig as Record<string, unknown>;
    hc.Binds = (hc.Binds as string[]) || [];
    (hc.Binds as string[]).push('huggingface-cache:/root/.cache/huggingface');
    hc.ShmSize = 4 * 1024 * 1024 * 1024;
  }

  log.info(`Creating container ${name}`, { image: def.image, port: hostPort });
  const { status, body } = await dockerRequestWithBody('POST', `/containers/create?name=${name}`, config);

  if (status === 201) {
    log.info(`Container ${name} created`);
    return JSON.parse(body);
  }
  if (status === 409) {
    log.info(`Container ${name} already exists`);
    return { exists: true };
  }
  throw new Error(`Create container ${name} failed (${status}): ${body.slice(0, 300)}`);
}

/**
 * Parse Docker multiplexed stream format (non-TTY exec output).
 * Each frame: [type(1)][pad(3)][size(4 BE)][payload(size)]
 * type: 1=stdout, 2=stderr
 */
function demuxDockerStream(buf: Buffer): { text: string; rest: Buffer } {
  let offset = 0;
  let text = '';
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) break; // partial frame — leave in rest
    text += buf.subarray(offset + 8, offset + 8 + size).toString('utf8');
    offset += 8 + size;
  }
  return { text, rest: Buffer.from(buf.subarray(offset)) };
}

/** Get the exit code of a completed exec instance via Docker inspect. */
async function getExecExitCode(execId: string): Promise<number> {
  try {
    const { status, body } = await dockerRequest('GET', `/exec/${execId}/json`);
    if (status === 200) {
      const info = JSON.parse(body);
      const exitCode = info.ExitCode ?? -1;
      log.info(`getExecExitCode: execId=${execId.slice(0, 12)} exitCode=${exitCode} running=${info.Running}`);
      return exitCode;
    }
    log.warn(`getExecExitCode: inspect returned ${status} for ${execId.slice(0, 12)}`);
  } catch (err) {
    log.warn(`getExecExitCode: failed for ${execId.slice(0, 12)}: ${(err as Error).message}`);
  }
  return -1;
}

export async function execInContainer(
  containerName: string,
  cmd: string | string[],
  opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; output: string }> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const cmdArr = Array.isArray(cmd) ? cmd : ['sh', '-c', cmd];
  const cmdStr = cmdArr.join(' ');
  log.info(`exec: ${containerName} $ ${cmdStr} (timeout=${timeoutMs / 1000}s)`);

  const { status: createStatus, body: createBody } = await dockerRequestWithBody(
    'POST',
    `/containers/${containerName}/exec`,
    { Cmd: cmdArr, AttachStdout: true, AttachStderr: true },
  );
  if (createStatus !== 201) {
    throw new Error(`exec create failed (${createStatus}): ${createBody.slice(0, 200)}`);
  }
  const { Id: execId } = JSON.parse(createBody);
  log.info(`exec: created execId=${execId.slice(0, 12)} for "${cmdStr}"`);


  // Use a dedicated request with the caller-specified timeout instead of
  // dockerRequestWithBody (which has a hardcoded 120s socket idle timeout).
  // Model pulls can take 10+ minutes for large models like qwen3.5:14b (~9GB).
  const rawOutput = await new Promise<Buffer>((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: false });
    const chunks: Buffer[] = [];
    const req = http.request(
      {
        ...dockerConnectionOpts(),
        method: 'POST',
        path: `/exec/${execId}/start`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`exec timed out after ${timeoutMs / 1000}s`)); });
    req.write(payload);
    req.end();
  });

  const { text: output, rest } = demuxDockerStream(rawOutput);
  log.info(`exec: ${containerName} $ ${cmdStr} — rawBytes=${rawOutput.length} demuxedLen=${output.length} restLen=${rest.length}`);
  if (rest.length > 0) {
    log.warn(`exec: ${rest.length} bytes could not be demuxed (not framed?) — raw hex: ${rest.subarray(0, 32).toString('hex')}`);
  }
  const exitCode = await getExecExitCode(execId);
  log.info(`exec: ${containerName} $ ${cmdStr} → exit=${exitCode} output=${output.slice(0, 200).replace(/\n/g, '\\n')}`);
  return { exitCode, output };
}

/**
 * Wait for Ollama daemon to be ready inside a container by polling `ollama list`.
 * `ollama list` requires the daemon to be listening (unlike `--version` which is standalone).
 * Returns true if ready, throws if timeout exceeded.
 */
export async function waitForOllamaReady(containerName: string, maxWaitMs = 30_000): Promise<void> {
  const start = Date.now();
  const pollInterval = 2_000;
  let attempt = 0;
  log.info(`waitForOllamaReady: polling ${containerName} (max ${maxWaitMs / 1000}s)...`);
  while (Date.now() - start < maxWaitMs) {
    attempt++;
    try {
      const { exitCode, output } = await execInContainer(containerName, ['ollama', 'list'], { timeoutMs: 10_000 });
      if (exitCode === 0) {
        log.info(`waitForOllamaReady: ${containerName} ready after ${attempt} attempts (${Math.round((Date.now() - start) / 1000)}s), output: ${output.slice(0, 200).replace(/\n/g, '\\n')}`);
        return;
      }
      log.info(`waitForOllamaReady: attempt ${attempt} exit=${exitCode} — not ready yet`);
    } catch (err) {
      log.info(`waitForOllamaReady: attempt ${attempt} error: ${(err as Error).message.slice(0, 100)}`);
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(`Ollama in ${containerName} not ready after ${maxWaitMs / 1000}s (${attempt} attempts)`);
}

/**
 * Load an Ollama model into VRAM by running it briefly.
 * `ollama run MODEL /bye` with stdin piped loads the model then exits cleanly.
 * Returns true on success, false on error (best-effort, never throws).
 *
 * Optional onData callback streams command output in real-time (loading progress, etc).
 */
export async function loadOllamaModel(
  containerName: string,
  model: string,
  opts?: { timeoutMs?: number; onData?: (chunk: string) => void },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  try {
    log.info(`loadOllamaModel: loading ${model} in ${containerName}...`);
    const { exitCode, output } = await execInContainerStreaming(
      containerName,
      ['sh', '-c', `printf "\\n" | ollama run ${model} /bye`],
      { timeoutMs, onData: opts?.onData },
    );
    if (exitCode === 0) {
      log.info(`loadOllamaModel: ${model} loaded in ${containerName}`);
      return true;
    }
    log.warn(`loadOllamaModel: exit code ${exitCode} for ${model} in ${containerName}: ${output.slice(0, 200)}`);
    return false;
  } catch (err) {
    log.error(`loadOllamaModel: failed to load ${model} in ${containerName}: ${(err as Error).message}`);
    return false;
  }
}

export async function pullImage(
  image: string,
  opts?: { onProgress?: (progress: number, detail: string) => void },
): Promise<boolean> {
  assertDockerAvailable();

  // Split image:tag — Docker API requires separate fromImage and tag params.
  // Without explicit tag, Docker pulls ALL tags (dozens of versions).
  let imgName = image;
  let imgTag = 'latest';
  const colonIdx = image.lastIndexOf(':');
  if (colonIdx > 0 && !image.substring(colonIdx).includes('/')) {
    imgName = image.substring(0, colonIdx);
    imgTag = image.substring(colonIdx + 1);
  }
  log.info(`Pulling image ${imgName}:${imgTag}...`);

  // Docker image pulls stream progress and can take 10+ minutes for large images.
  // Use a dedicated request with a long timeout instead of dockerRequest().
  return new Promise((resolve, reject) => {
    const reqOpts = {
      ...dockerConnectionOpts(),
      method: 'POST',
      path: `/images/create?fromImage=${encodeURIComponent(imgName)}&tag=${encodeURIComponent(imgTag)}&platform=linux%2Famd64`,
    };
    const req = http.request(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk));
        res.on('end', () => reject(new Error(`Pull ${image} failed (${res.statusCode}): ${body.slice(0, 200)}`)));
        return;
      }
      // Stream progress — Docker sends JSON lines with download status
      let lastLog = 0;
      let lineBuf = '';
      const layers = new Map<string, { current: number; total: number; done: boolean }>();

      res.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            // Track per-layer progress
            if (msg.id) {
              if (msg.status === 'Downloading' && msg.progressDetail?.total) {
                layers.set(msg.id, { current: msg.progressDetail.current || 0, total: msg.progressDetail.total, done: false });
              } else if (msg.status === 'Download complete' || msg.status === 'Pull complete' || msg.status === 'Already exists') {
                const existing = layers.get(msg.id);
                if (existing) existing.done = true;
                else layers.set(msg.id, { current: 1, total: 1, done: true });
              }
            }

            // Compute overall progress
            if (layers.size > 0 && opts?.onProgress) {
              const done = Array.from(layers.values()).filter(l => l.done).length;
              const progress = Math.round((done / layers.size) * 100);
              const detail = `Layer ${done}/${layers.size}${msg.progress ? ' ' + msg.progress : ''}`;
              opts.onProgress(progress, detail);
            }
          } catch { /* ignore parse errors */ }
        }

        // Log progress every 10 seconds
        const now = Date.now();
        if (now - lastLog > 10_000) {
          const done = Array.from(layers.values()).filter(l => l.done).length;
          log.info(`Pulling ${image}: ${done}/${layers.size || '?'} layers`);
          lastLog = now;
        }
      });
      res.on('end', () => {
        opts?.onProgress?.(100, 'Complete');
        log.info(`Image ${image} pulled successfully`);
        resolve(true);
      });
    });
    req.on('error', reject);
    // 30 minute timeout for very large images (vLLM ~5GB+)
    req.setTimeout(1800_000, () => { req.destroy(); reject(new Error(`Pull ${image} timed out after 30 minutes`)); });
    req.end();
  });
}

/**
 * Execute a command inside a container with streaming output.
 * Same as execInContainer but calls onData for each chunk as it arrives.
 */
export async function execInContainerStreaming(
  containerName: string,
  cmd: string | string[],
  opts?: { timeoutMs?: number; onData?: (chunk: string) => void },
): Promise<{ exitCode: number; output: string }> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const cmdArr = Array.isArray(cmd) ? cmd : ['sh', '-c', cmd];
  const cmdStr = cmdArr.join(' ');
  log.info(`execStreaming: ${containerName} $ ${cmdStr} (timeout=${timeoutMs / 1000}s)`);

  const { status: createStatus, body: createBody } = await dockerRequestWithBody(
    'POST',
    `/containers/${containerName}/exec`,
    { Cmd: cmdArr, AttachStdout: true, AttachStderr: true },
  );
  if (createStatus !== 201) {
    throw new Error(`exec create failed (${createStatus}): ${createBody.slice(0, 200)}`);
  }
  const { Id: execId } = JSON.parse(createBody);
  log.info(`execStreaming: created execId=${execId.slice(0, 12)} for "${cmdStr}"`);


  const fullOutput = await new Promise<string>((resolve, reject) => {
    const payload = JSON.stringify({ Detach: false, Tty: false });
    let remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let allText = '';
    const req = http.request(
      {
        ...dockerConnectionOpts(),
        method: 'POST',
        path: `/exec/${execId}/start`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let chunkCount = 0;
        res.on('data', (chunk: Buffer) => {
          chunkCount++;
          const combined = Buffer.concat([remainder, chunk]);
          const { text, rest } = demuxDockerStream(combined);
          remainder = rest;
          allText += text;
          if (text) {
            // Log every 10th chunk or first 3 to avoid flooding
            if (chunkCount <= 3 || chunkCount % 10 === 0) {
              log.info(`execStreaming: chunk#${chunkCount} rawBytes=${chunk.length} demuxed="${text.slice(0, 120).replace(/\n/g, '\\n')}"`);
            }
            opts?.onData?.(text);
          }
        });
        res.on('end', () => {
          // Flush any remaining partial data as raw text
          if (remainder.length > 0) {
            const trailing = remainder.toString('utf8');
            allText += trailing;
            if (trailing) opts?.onData?.(trailing);
          }
          resolve(allText);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`exec timed out after ${timeoutMs / 1000}s`)); });
    req.write(payload);
    req.end();
  });

  const exitCode = await getExecExitCode(execId);
  log.info(`execStreaming: ${containerName} $ ${cmdStr} → exit=${exitCode} outputLen=${fullOutput.length} output=${fullOutput.slice(0, 200).replace(/\n/g, '\\n')}`);
  return { exitCode, output: fullOutput };
}
