/**
 * Ollama HTTP API client — replaces docker exec for all Ollama operations.
 * Uses the REST API exposed on each container's mapped port.
 */

import http from 'http';
import { createLogger } from './logger';
import { getDockerHost } from './docker';

const log = createLogger('ollama-api');

interface OllamaRequestOpts {
  method: string;
  port: number;
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** When set, getDockerHost() consults the role's registry entry — a role
   *  with runtime:'host' routes to state.hostOllamaHost instead of the Docker
   *  container hostname. Omit (or leave undefined) for plain dockerized
   *  Ollama. */
  role?: string;
}

function ollamaRequestOnce(opts: OllamaRequestOpts): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        hostname: getDockerHost(opts.role),
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 30_000, () => {
      req.destroy();
      reject(new Error(`Ollama request timed out after ${(opts.timeoutMs ?? 30_000) / 1000}s`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Retry wrapper: retries on connection errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT) with backoff. */
async function ollamaRequest(opts: OllamaRequestOpts, retries = 3): Promise<{ status: number; body: string }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await ollamaRequestOnce(opts);
    } catch (err) {
      lastErr = err as Error;
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
      if (!retriable || attempt === retries) break;
      const delay = (attempt + 1) * 2_000;
      log.info(`ollamaRequest: ${opts.method} ${opts.path} port ${opts.port} failed (${code}), retry ${attempt + 1}/${retries} in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr!;
}

/** List models on disk. GET /api/tags → string[] of model names. */
export async function ollamaList(port: number, role?: string): Promise<string[]> {
  const { status, body } = await ollamaRequest({ method: 'GET', port, path: '/api/tags', role });
  if (status !== 200) throw new Error(`ollamaList failed (${status}): ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  return (data.models || []).map((m: { name: string }) => m.name);
}

/**
 * Authoritative check that a specific model exists on disk.
 * POST /api/show {name} → 200 if present, 404 if missing. Use this when /api/tags
 * gives a false negative (Ollama can return an empty list right after container
 * start while it scans the manifest store, causing spurious re-pulls).
 */
export async function ollamaShow(port: number, name: string, role?: string): Promise<boolean> {
  const { status } = await ollamaRequest({
    method: 'POST',
    port,
    path: '/api/show',
    body: { name },
    role,
  });
  return status === 200;
}

export interface LoadedModel {
  name: string;
  size: number;
  sizeVram: number;
  processor: string;
  until: string;
}

/** List models currently loaded in VRAM. GET /api/ps → LoadedModel[]. */
export async function ollamaPs(port: number, role?: string): Promise<LoadedModel[]> {
  const { status, body } = await ollamaRequest({ method: 'GET', port, path: '/api/ps', role });
  if (status !== 200) throw new Error(`ollamaPs failed (${status}): ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  return (data.models || []).map((m: Record<string, unknown>) => ({
    name: m.name as string,
    size: m.size as number,
    sizeVram: m.size_vram as number,
    processor: (() => {
      const sv = m.size_vram as number;
      const s = m.size as number;
      if (!s || s === 0) return 'CPU';
      if (sv >= s) return 'GPU';
      if (sv > 0) return 'GPU/CPU';
      return 'CPU';
    })(),
    until: m.expires_at as string,
  }));
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  error?: string;
}

/**
 * Pull a model. POST /api/pull — streams NDJSON progress.
 * Calls onProgress(pct, detail) for each status line.
 */
export async function ollamaPull(
  port: number,
  model: string,
  opts?: { onProgress?: (pct: number, detail: string) => void; timeoutMs?: number; role?: string },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 1_800_000; // 30 min default for large models
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ name: model, stream: true });
    const req = http.request(
      {
        hostname: getDockerHost(opts?.role),
        port,
        method: 'POST',
        path: '/api/pull',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (c: Buffer) => (body += c));
          res.on('end', () => reject(new Error(`ollamaPull failed (${res.statusCode}): ${body.slice(0, 200)}`)));
          return;
        }

        let lineBuf = '';
        let lastPct = -1;
        let lastStatus = '';
        let lineCount = 0;
        let sawSuccess = false;
        let pullError = '';
        res.on('data', (chunk: Buffer) => {
          lineBuf += chunk.toString();
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg: PullProgress = JSON.parse(line);
              lineCount++;

              // Check for error in the NDJSON stream
              if (msg.error) {
                pullError = msg.error;
                log.error(`ollamaPull: ${model} error in stream: ${msg.error}`);
              }

              let pct = 0;
              let detail = msg.status || '';
              if (msg.total && msg.total > 0 && msg.completed != null) {
                pct = Math.round((msg.completed / msg.total) * 100);
                const completedMB = Math.round(msg.completed / 1e6);
                const totalMB = Math.round(msg.total / 1e6);
                detail = `${msg.status} ${completedMB}MB/${totalMB}MB`;
              }
              // Report progress on pct change OR status phase change
              if (pct !== lastPct || msg.status !== lastStatus) {
                lastPct = pct;
                lastStatus = msg.status || '';
                opts?.onProgress?.(pct, detail);
              }
              // Log periodically (every 20 lines or on phase changes)
              if (lineCount <= 3 || lineCount % 20 === 0 || msg.status !== lastStatus || msg.status === 'success') {
                log.info(`ollamaPull: ${model} line#${lineCount} pct=${pct} status="${(msg.status || '').slice(0, 80)}"`);
              }
              if (msg.status === 'success') {
                sawSuccess = true;
                log.info(`ollamaPull: ${model} completed successfully`);
              }
            } catch { /* skip malformed lines */ }
          }
        });

        res.on('end', () => {
          // Process any remaining buffered data
          if (lineBuf.trim()) {
            try {
              const msg: PullProgress = JSON.parse(lineBuf);
              if (msg.error) pullError = msg.error;
              if (msg.status === 'success') {
                sawSuccess = true;
                opts?.onProgress?.(100, 'success');
              }
            } catch { /* ignore */ }
          }
          log.info(`ollamaPull: ${model} stream ended — ${lineCount} lines, success=${sawSuccess}, error="${pullError}"`);
          if (pullError) {
            reject(new Error(`ollamaPull ${model} failed: ${pullError}`));
          } else if (!sawSuccess) {
            reject(new Error(`ollamaPull ${model} stream ended without success status (${lineCount} lines received)`));
          } else {
            resolve();
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`ollamaPull timed out after ${timeoutMs / 1000}s`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Send a single HTTP POST and return {status, body}.
 * Retries on connection errors (ECONNREFUSED, etc.) with backoff.
 * Used internally by ollamaLoad to try multiple endpoints.
 */
async function ollamaPost(
  port: number,
  path: string,
  body: unknown,
  timeoutMs: number,
  onData?: (chunk: string) => void,
  retries = 3,
  role?: string,
): Promise<{ status: number; body: string }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
          {
            hostname: getDockerHost(role),
            port,
            method: 'POST',
            path,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          },
          (res) => {
            let data = '';
            res.on('data', (c: Buffer) => {
              data += c;
              onData?.(data.slice(-100));
            });
            res.on('end', () => resolve({ status: res.statusCode!, body: data }));
          },
        );
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          reject(new Error(`ollamaPost ${path} timed out after ${timeoutMs / 1000}s`));
        });
        req.write(payload);
        req.end();
      });
    } catch (err) {
      lastErr = err as Error;
      const code = (err as NodeJS.ErrnoException).code;
      const retriable = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
      if (!retriable || attempt === retries) break;
      const delay = (attempt + 1) * 2_000;
      log.info(`ollamaPost: ${path} port ${port} failed (${code}), retry ${attempt + 1}/${retries} in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr!;
}

/**
 * Load a model into VRAM. Tries /api/generate first (works for chat/completion models),
 * falls back to /api/embed (works for embedding models like qwen3-embedding).
 */
export async function ollamaLoad(
  port: number,
  model: string,
  opts?: { onProgress?: (detail: string) => void; timeoutMs?: number; forceFullGpu?: boolean; role?: string },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const role = opts?.role;
  // num_gpu: 999 asks Ollama to put all layers on GPU; if VRAM is tight Ollama
  // will reject the load instead of silently splitting layers to CPU.
  const gpuOptions = opts?.forceFullGpu ? { num_gpu: 999 } : undefined;
  try {
    log.info(`ollamaLoad: loading ${model} on port ${port}${opts?.forceFullGpu ? ' (forceFullGpu)' : ''}...`);

    // Try endpoints in order until one succeeds at loading the model into VRAM.
    // Different model types (chat, embedding, vision) support different endpoints.
    const endpoints: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: '/api/generate', body: { model, prompt: '', keep_alive: '24h', stream: false, ...(gpuOptions ? { options: gpuOptions } : {}) } },
      { path: '/api/embed', body: { model, input: 'warmup', keep_alive: '24h', ...(gpuOptions ? { options: gpuOptions } : {}) } },
      { path: '/api/embeddings', body: { model, prompt: 'warmup', keep_alive: '24h', ...(gpuOptions ? { options: gpuOptions } : {}) } },
      { path: '/api/chat', body: { model, messages: [], keep_alive: '24h', stream: false, ...(gpuOptions ? { options: gpuOptions } : {}) } },
    ];

    const results: string[] = [];
    let loaded = false;
    for (const ep of endpoints) {
      try {
        const result = await ollamaPost(port, ep.path, ep.body, timeoutMs, opts?.onProgress, 3, role);
        results.push(`${ep.path}=${result.status}`);
        if (result.status === 200) {
          log.info(`ollamaLoad: ${model} loaded via ${ep.path} on port ${port}`);
          loaded = true;
          break;
        }
        log.info(`ollamaLoad: ${ep.path} returned ${result.status} for ${model}: ${result.body.slice(0, 150)}`);
      } catch (err) {
        results.push(`${ep.path}=ERR:${(err as Error).message.slice(0, 50)}`);
        log.info(`ollamaLoad: ${ep.path} error for ${model}: ${(err as Error).message.slice(0, 100)}`);
      }
    }

    if (!loaded) {
      log.warn(`ollamaLoad: all endpoints failed for ${model} on port ${port}: ${results.join(', ')}`);
      return false;
    }

    if (opts?.forceFullGpu) {
      // Verify the load actually landed fully on GPU. Ollama can still split
      // layers under memory pressure even when num_gpu is requested high.
      try {
        const ps = await ollamaPs(port, role);
        const me = ps.find((m) => m.name === model || m.name.startsWith(`${model}:`));
        if (!me) {
          log.warn(`ollamaLoad: forceFullGpu — ${model} not in /api/ps after load on port ${port}`);
          await ollamaUnload(port, model, role).catch(() => undefined);
          return false;
        }
        if (!me.size || me.size === 0) {
          log.warn(`ollamaLoad: forceFullGpu — ${model} reports size=0 on port ${port}, cannot verify GPU residency`);
          return true;
        }
        const gpuPct = Math.round((me.sizeVram / me.size) * 100);
        if (gpuPct < 99) {
          log.warn(`ollamaLoad: forceFullGpu — ${model} loaded only ${gpuPct}% on GPU (processor=${me.processor}); unloading`);
          await ollamaUnload(port, model, role).catch(() => undefined);
          return false;
        }
        log.info(`ollamaLoad: forceFullGpu — ${model} verified at ${gpuPct}% GPU on port ${port}`);
      } catch (err) {
        log.warn(`ollamaLoad: forceFullGpu — verification failed for ${model} on port ${port}: ${(err as Error).message}`);
        // Conservative: leave model loaded; the watchdog will catch it next tick.
      }
    }

    return true;
  } catch (err) {
    log.error(`ollamaLoad: failed to load ${model} on port ${port}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Evict a model from VRAM. POST /api/generate with keep_alive: 0 — Ollama
 * unloads immediately. Best-effort: returns false on error but does not throw.
 */
export async function ollamaUnload(port: number, model: string, role?: string): Promise<boolean> {
  try {
    const result = await ollamaPost(
      port,
      '/api/generate',
      { model, prompt: '', keep_alive: 0, stream: false },
      15_000,
      undefined,
      3,
      role,
    );
    if (result.status === 200) {
      log.info(`ollamaUnload: ${model} unloaded on port ${port}`);
      return true;
    }
    // 404 = model not found / not pulled — treat as success (already unloaded,
    // goal of stop is satisfied: no VRAM held by this model). Otherwise stop
    // becomes non-idempotent when registry's model name doesn't match what's
    // actually installed on the host.
    if (result.status === 404) {
      log.info(`ollamaUnload: ${model} not present on port ${port} (404) — treating as already unloaded`);
      return true;
    }
    log.warn(`ollamaUnload: ${model} on port ${port} returned ${result.status}: ${result.body.slice(0, 150)}`);
    return false;
  } catch (err) {
    log.warn(`ollamaUnload: ${model} on port ${port} error: ${(err as Error).message}`);
    return false;
  }
}

/** Check if Ollama API is reachable. GET /api/tags with 5s timeout → boolean. */
export async function ollamaIsReady(port: number, role?: string): Promise<{ ready: boolean; error?: string }> {
  try {
    // Use ollamaRequestOnce directly — no retries for a readiness probe
    const { status } = await ollamaRequestOnce({ method: 'GET', port, path: '/api/tags', timeoutMs: 5_000, role });
    return { ready: status === 200 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ready: false, error: code || (err as Error).message };
  }
}

/** Poll ollamaIsReady every 2s until ready or maxMs elapsed. Throws on timeout. */
export async function waitForOllama(port: number, maxMs = 30_000, role?: string): Promise<void> {
  const host = getDockerHost(role);
  const start = Date.now();
  const pollInterval = 2_000;
  let attempt = 0;
  let lastError = '';
  log.info(`waitForOllama: polling ${host}:${port} (max ${maxMs / 1000}s)...`);
  while (Date.now() - start < maxMs) {
    attempt++;
    const { ready, error } = await ollamaIsReady(port, role);
    if (ready) {
      log.info(`waitForOllama: ${host}:${port} ready after ${attempt} attempts (${Math.round((Date.now() - start) / 1000)}s)`);
      return;
    }
    lastError = error || 'unknown';
    // Log every attempt with the specific error
    log.info(`waitForOllama: attempt ${attempt} ${host}:${port} — ${lastError}`);
    await new Promise((r) => setTimeout(r, pollInterval));
  }
  throw new Error(`Ollama on ${host}:${port} not ready after ${maxMs / 1000}s (${attempt} attempts, last error: ${lastError})`);
}
