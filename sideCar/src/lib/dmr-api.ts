/**
 * Docker Model Runner (DMR) HTTP client.
 *
 * DMR runs on the Docker host (vllm-metal on Apple Silicon, vllm/CUDA on
 * Linux, llama.cpp everywhere) and exposes an OpenAI-compatible API on a
 * single TCP port (default 12434). From inside a container, reachable at
 * host.docker.internal:12434. We never proxy DMR through ollama-api.ts —
 * the endpoints differ (DMR uses /engines/v1/* with no Ollama-style
 * /api/tags, /api/pull, /api/ps).
 *
 * Surface we use:
 *   GET  /engines/v1/models           → readiness + loaded-model count
 *   POST /engines/v1/chat/completions → master can hit this directly
 *   POST /engines/vllm/v1/rerank      → reranker (vLLM only) — master too
 *
 * No unload API exists today. DMR's scheduler decides when to evict a
 * vllm-metal worker; we have no docker-stop equivalent. Idle timers for
 * DMR roles log a "no unload API" note and leave the model resident.
 */

import http from 'http';
import { state } from './state';
import { createLogger } from './logger';

const log = createLogger('dmr-api');

interface DmrRequestOpts {
  method: string;
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

function dmrRequestOnce(opts: DmrRequestOpts): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        hostname: state.dmrHost,
        port: state.dmrPort,
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
    req.setTimeout(opts.timeoutMs ?? 5_000, () => {
      req.destroy();
      reject(new Error(`DMR request timed out after ${(opts.timeoutMs ?? 5_000) / 1000}s`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Readiness probe. GET /engines/v1/models → 200 → ready. Returns model
 *  count so we can surface "DMR up but no models pulled" in status. */
export async function dmrIsReady(): Promise<{ ready: boolean; error?: string; modelCount?: number }> {
  try {
    const { status, body } = await dmrRequestOnce({
      method: 'GET',
      path: '/engines/v1/models',
      timeoutMs: 5_000,
    });
    if (status !== 200) {
      return { ready: false, error: `status=${status}` };
    }
    let count: number | undefined;
    try {
      const json = JSON.parse(body) as { data?: unknown[] };
      if (Array.isArray(json.data)) count = json.data.length;
    } catch {
      /* non-fatal — still ready */
    }
    return { ready: true, modelCount: count };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ready: false, error: code || (err as Error).message };
  }
}

/** List model IDs known to DMR. GET /engines/v1/models. */
export async function dmrListModels(): Promise<string[]> {
  const { status, body } = await dmrRequestOnce({
    method: 'GET',
    path: '/engines/v1/models',
    timeoutMs: 5_000,
  });
  if (status !== 200) {
    log.warn(`dmrListModels failed: status=${status}`);
    return [];
  }
  try {
    const json = JSON.parse(body) as { data?: Array<{ id?: string }> };
    return (json.data || []).map((m) => m.id || '').filter(Boolean);
  } catch (err) {
    log.warn(`dmrListModels parse error: ${(err as Error).message}`);
    return [];
  }
}

/** Build the master-facing base URL for DMR. Master config's rerankHost
 *  / completionHost / embeddingHost should point here (master never goes
 *  through the sidecar for actual inference — it talks to DMR directly).
 *  Auto-select engine path; DMR picks vllm-metal on Mac. */
export function dmrBaseUrl(): string {
  return `http://${state.dmrHost}:${state.dmrPort}/engines/v1`;
}
