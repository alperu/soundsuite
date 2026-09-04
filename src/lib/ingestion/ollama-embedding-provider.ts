/**
 * OllamaEmbeddingProvider uses an Ollama server for embedding generation.
 *
 * Supports CUDA GPU acceleration when Ollama is running on a machine with
 * an NVIDIA GPU. Designed for remote Ollama instances (e.g., Windows machine
 * with GPU) accessed over the network.
 */

import { EmbeddingProvider } from './embedding-provider';
import { createLogger } from '../logger';

const logger = createLogger('OllamaEmbeddingProvider');

/**
 * Known Ollama embedding models and their dimensions.
 */
const OLLAMA_MODEL_DIMENSIONS: Record<string, number> = {
  'all-minilm': 384,
  'all-minilm:latest': 384,
  'all-minilm:l6-v2': 384,
  'nomic-embed-text': 768,
  'nomic-embed-text:latest': 768,
  'mxbai-embed-large': 1024,
  'mxbai-embed-large:latest': 1024,
  'snowflake-arctic-embed': 1024,
  'snowflake-arctic-embed:latest': 1024,
  'snowflake-arctic-embed2': 1024,
  'snowflake-arctic-embed2:latest': 1024,
  'bge-m3': 1024,
  'bge-m3:latest': 1024,
  'qwen3-embedding:0.6b': 1024,
  'qwen3-embedding:4b': 1024,
  'qwen3-embedding:8b': 1024,
  'qwen3-embedding': 1024,
  'qwen3-embedding:latest': 1024,
};

interface OllamaEmbeddingConfig {
  host: string;   // e.g., http://192.168.1.100:11434
  model: string;  // e.g., all-minilm
  useOrchestrator?: boolean; // resolve host per-request via fleet-router
}

export class OllamaEmbeddingProvider extends EmbeddingProvider {
  private host: string;
  private model: string;
  private dimensions: number;
  private useOrchestrator: boolean;
  private ollamaClient: any = null;
  private lastPreflight: { host: string; ok: boolean; at: number; error?: string } | null = null;
  private static PREFLIGHT_OK_TTL_MS = 5_000;
  private static PREFLIGHT_FAIL_TTL_MS = 2_000;
  private static PREFLIGHT_TIMEOUT_MS = 1_500;

  private async preflight(host: string): Promise<{ ok: boolean; error?: string }> {
    const now = Date.now();
    const cached = this.lastPreflight;
    if (cached && cached.host === host) {
      const ttl = cached.ok
        ? OllamaEmbeddingProvider.PREFLIGHT_OK_TTL_MS
        : OllamaEmbeddingProvider.PREFLIGHT_FAIL_TTL_MS;
      if (now - cached.at < ttl) return { ok: cached.ok, error: cached.error };
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OllamaEmbeddingProvider.PREFLIGHT_TIMEOUT_MS);
    try {
      const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) {
        const result = { ok: false, error: `HTTP ${res.status}` };
        this.lastPreflight = { host, at: now, ...result };
        return result;
      }
      const data: any = await res.json().catch(() => ({ models: [] }));
      // /api/tags returns tagged names (e.g. "qwen3-embedding:0.6b" or
      // "model:latest"). Configured model may omit the tag. Match against
      // the base name + accept "name:latest" when caller used a bare name.
      const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
      const wantedBase = this.model.split(':')[0];
      const matches = (s: unknown): boolean => {
        if (typeof s !== 'string') return false;
        if (s === this.model || s === wanted) return true;
        return s.split(':')[0] === wantedBase;
      };
      const has = Array.isArray(data?.models)
        && data.models.some((m: any) => matches(m?.name) || matches(m?.model));
      if (!has) {
        const result = { ok: false, error: `model "${this.model}" not pulled on ${host}` };
        this.lastPreflight = { host, at: now, ...result };
        return result;
      }
      this.lastPreflight = { host, at: now, ok: true };
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).name === 'AbortError'
        ? `preflight timeout after ${OllamaEmbeddingProvider.PREFLIGHT_TIMEOUT_MS}ms`
        : (err as Error).message;
      this.lastPreflight = { host, at: now, ok: false, error: msg };
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  constructor(config: OllamaEmbeddingConfig) {
    super();
    this.host = config.host.replace(/\/+$/, ''); // strip trailing slash
    this.model = config.model;
    this.dimensions = OLLAMA_MODEL_DIMENSIONS[config.model] || 384;
    this.useOrchestrator = config.useOrchestrator ?? false;
  }

  /**
   * Lazily initialize the Ollama client.
   */
  private async getClient(): Promise<any> {
    if (this.ollamaClient) return this.ollamaClient;
    logger.info('Initializing Ollama client', { host: this.host, model: this.model });
    const { Ollama } = await import('ollama');
    this.ollamaClient = new Ollama({ host: this.host });
    return this.ollamaClient;
  }

  /** Per-attempt timeout on the embed call itself — a dead socket previously
   * hung ~72s before undici noticed and there was NO application timeout.
   * Covers cold model loads (30-60s) with margin. */
  private static EMBED_TIMEOUT_MS = 120_000;
  /** Ollama `keep_alive` for the embedding model (see embedOnce). */
  private static EMBED_KEEP_ALIVE = process.env.SS_EMBED_KEEP_ALIVE || '30m';
  private static EMBED_MAX_ATTEMPTS = 3;
  private static EMBED_BASE_DELAY_MS = 3_000;

  /**
   * Embed with per-batch retry + fleet host exclusion (plan:
   * docs/PLAN-pipeline-resume-and-speed.md §3.1). A host that fails an
   * attempt is excluded from the next resolution, so one disconnected GPU
   * costs a retry, not the document. The final attempt drops exclusions —
   * on a single-host fleet the failed host may be the only host, and it may
   * have recovered.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const failedHosts: string[] = [];
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= OllamaEmbeddingProvider.EMBED_MAX_ATTEMPTS; attempt++) {
      const isFinal = attempt === OllamaEmbeddingProvider.EMBED_MAX_ATTEMPTS;
      try {
        return await this.embedOnce(texts, isFinal ? [] : failedHosts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const host = (err as { failedHost?: string }).failedHost;
        if (host && !failedHosts.includes(host)) failedHosts.push(host);
        // Drop the cached preflight verdict so a recovered host is re-probed.
        this.lastPreflight = null;
        if (!isFinal) {
          const delay = OllamaEmbeddingProvider.EMBED_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1_000;
          logger.warn(`Embed attempt ${attempt}/${OllamaEmbeddingProvider.EMBED_MAX_ATTEMPTS} failed — retrying`, {
            model: this.model,
            failedHosts,
            delayMs: Math.round(delay),
            error: lastError.message,
          });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  private async embedOnce(texts: string[], excludeHosts: string[]): Promise<number[][]> {
    // Dynamic fleet routing: resolve host per-request when orchestrator is enabled
    let activeHost = this.host;
    let sidecarUrl: string | undefined;

    if (this.useOrchestrator) {
      try {
        const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
        const ep = await resolveEndpoint('embedding', excludeHosts.length ? { excludeHosts } : undefined);
        activeHost = ep.host;
        sidecarUrl = ep.sidecarUrl;
        logger.info('Embedding route (orchestrator)', { host: activeHost, sidecar: sidecarUrl, model: this.model, excluded: excludeHosts });
      } catch (err) {
        logger.warn('Fleet router embedding resolve failed, using configured host', {
          error: (err as Error).message, host: this.host,
        });
      }
    }

    const pf = await this.preflight(activeHost);
    if (!pf.ok) {
      logger.warn('Ollama preflight failed — skipping embed', {
        host: activeHost,
        model: this.model,
        error: pf.error,
      });
      const err = new Error(`Ollama unavailable (${activeHost}, model=${this.model}): ${pf.error}. Ensure Ollama is running and the model is pulled.`);
      (err as unknown as { failedHost: string }).failedHost = activeHost;
      throw err;
    }

    const embedStart = Date.now();
    logger.info('Ollama embed request', {
      host: activeHost,
      model: this.model,
      batchSize: texts.length,
      totalChars: texts.reduce((s, t) => s + t.length, 0),
      orchestrator: this.useOrchestrator,
    });

    // If orchestrator resolved a different host, create a one-off client
    let client: any;
    if (activeHost !== this.host) {
      const { Ollama } = await import('ollama');
      client = new Ollama({ host: activeHost });
    } else {
      client = await this.getClient();
    }

    try {
      // Promise.race timeout: the underlying request may linger, but the
      // caller moves on to a retry instead of hanging on a dead socket.
      const response = await Promise.race([
        // keep_alive: the embedding model stays resident so a completion
        // model loading on the same host doesn't evict it between batches
        // and every search doesn't pay a cold load (report M-1).
        client.embed({ model: this.model, input: texts, keep_alive: OllamaEmbeddingProvider.EMBED_KEEP_ALIVE }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`embed timeout after ${OllamaEmbeddingProvider.EMBED_TIMEOUT_MS}ms (host may be down or cold-loading)`)),
            OllamaEmbeddingProvider.EMBED_TIMEOUT_MS,
          ).unref?.(),
        ),
      ]);

      if (!response.embeddings || response.embeddings.length !== texts.length) {
        const mismatch = `expected ${texts.length}, got ${response.embeddings?.length ?? 0}`;
        logger.error('Ollama embed count mismatch', null, {
          host: activeHost,
          model: this.model,
          mismatch,
          responseKeys: Object.keys(response),
        });
        throw new Error(`Ollama returned ${response.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`);
      }

      const dims = response.embeddings[0]?.length ?? 0;
      logger.info('Ollama embed success', {
        host: activeHost,
        model: this.model,
        batchSize: texts.length,
        dimensions: dims,
        durationMs: Date.now() - embedStart,
      });

      return response.embeddings;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Ollama embed FAILED', error, {
        host: activeHost,
        model: this.model,
        batchSize: texts.length,
        durationMs: Date.now() - embedStart,
        errorMessage: msg,
        errorStack: stack,
      });
      const wrapped = new Error(`Ollama embedding failed (${activeHost}, model=${this.model}): ${msg}`);
      (wrapped as unknown as { failedHost: string }).failedHost = activeHost;
      throw wrapped;
    } finally {
      if (sidecarUrl) {
        const { releaseEndpoint } = await import('@/lib/gpu/fleet-router');
        releaseEndpoint('embedding', sidecarUrl);
      }
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getAvailableModels(): string[] {
    return [
      'qwen3-embedding:0.6b',
      'qwen3-embedding:4b',
      'nomic-embed-text',
      'snowflake-arctic-embed2',
      'bge-m3',
      'all-minilm',
    ];
  }

  getModelName(): string {
    return `ollama/${this.model}`;
  }

  /**
   * Test connection to the Ollama server.
   * Returns true if the server is reachable and the model is available.
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const pf = await this.preflight(this.host);
      if (!pf.ok) return pf;
      const client = await this.getClient();
      await client.embed({ model: this.model, input: ['ping'] });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
