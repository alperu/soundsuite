/**
 * OpenRouter HTTP client — sidecar-local.
 *
 * The sidecar is a SEPARATE package from the master (Sound Suite dashboard),
 * which has its own client at `src/lib/openrouter/client.ts`. This is
 * deliberately NOT a copy of that module wired via a relative `../../..`
 * import — the sidecar ships standalone (it's published to a public mirror,
 * see CLAUDE.md) and can't depend on the master's source tree. It mirrors
 * the master client's two load-bearing safety properties instead:
 *
 * - **Provider pinning for embeddings.** Two providers serving the same
 *   model do not guarantee identical vectors — an unpinned call can silently
 *   split one logical vector space in two. `embed()` always requires a pin;
 *   it is the caller's job (virtual-inference.ts) to refuse the call rather
 *   than pass one through unpinned. `rerank()` is stateless and needs none.
 * - **Dimension safety.** A provider silently returning the wrong width is
 *   exactly the failure that corrupts a vector index. `embed()` enforces
 *   `expectedDims` when given.
 *
 * Key hygiene: the API key is a parameter on every call, read from the
 * per-master config in virtual-inference.ts, and never appears in a thrown
 * error message or a log line here.
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterClientError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'OpenRouterClientError';
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'Sound Suite Sidecar',
  };
}

async function get<T>(apiKey: string, path: string, timeoutMs: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: ctl.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpenRouterClientError(`OpenRouter ${path} network error: ${msg}`, 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new OpenRouterClientError(`OpenRouter ${path} failed (${res.status})`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OpenRouterClientError(`OpenRouter ${path} returned non-JSON`, res.status);
  }
}

async function post<T>(apiKey: string, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpenRouterClientError(`OpenRouter ${path} network error: ${msg}`, 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    // Never include request headers/body in the thrown message — the caller
    // logs this, and the key must never reach a log line.
    throw new OpenRouterClientError(`OpenRouter ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OpenRouterClientError(`OpenRouter ${path} returned non-JSON response`, res.status);
  }
}

export interface EmbedOptions {
  /** REQUIRED in practice — see module header. Enforced by the caller, not here. */
  pinProvider?: string;
  expectedDims?: number;
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dims: number;
  totalTokens?: number;
}

/**
 * GET the key's own metadata: rate limit, spend limit and usage.
 *
 * The master needs this to size its cloud budget BEFORE spending against it —
 * every sidecar shares one OpenRouter key and the limit is per key, not per
 * caller, so guessing means either wasting headroom or collecting 429s. The
 * upstream envelope ({ data: { rate_limit: { requests, interval }, limit,
 * usage, is_free_tier } }) is returned unchanged; the master parses it.
 *
 * Key hygiene is the same as everywhere else here: the key goes out in the
 * Authorization header and never appears in a return value or an error.
 */
export async function keyInfo(apiKey: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return get<Record<string, unknown>>(apiKey, '/key', timeoutMs);
}

export async function embed(apiKey: string, texts: string[], model: string, opts: EmbedOptions = {}): Promise<EmbedResult> {
  const body: Record<string, unknown> = { model, input: texts };
  if (opts.pinProvider) {
    body.provider = { order: [opts.pinProvider], allow_fallbacks: false };
  }
  const json = await post<{
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number };
  }>(apiKey, '/embeddings', body, opts.timeoutMs ?? 60_000);

  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d) => d.embedding);
  const dims = vectors[0]?.length ?? 0;

  if (opts.expectedDims && dims !== opts.expectedDims) {
    throw new OpenRouterClientError(
      `OpenRouter model ${model} returned ${dims}-dim vectors but ${opts.expectedDims} was expected — ` +
      `refusing to return them (a wrong-width vector can corrupt or destroy the target index)`,
      500,
    );
  }
  return { vectors, model, dims, totalTokens: json.usage?.total_tokens };
}

export interface RerankOptions {
  topN?: number;
  timeoutMs?: number;
}

export interface RerankResult {
  results: Array<{ index: number; relevance_score: number }>;
  model?: string;
  totalTokens?: number;
}

export async function rerank(
  apiKey: string,
  query: string,
  documents: string[],
  model: string,
  opts: RerankOptions = {},
): Promise<RerankResult> {
  const body: Record<string, unknown> = { model, query, documents };
  if (opts.topN) body.top_n = opts.topN;
  const json = await post<{
    results: Array<{ index: number; relevance_score: number }>;
    model?: string;
    usage?: { total_tokens?: number };
  }>(apiKey, '/rerank', body, opts.timeoutMs ?? 60_000);
  return { results: json.results, model: json.model, totalTokens: json.usage?.total_tokens };
}
