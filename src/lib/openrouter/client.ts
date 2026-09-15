/**
 * OpenRouter client — the single place this codebase talks to OpenRouter.
 *
 * Design notes that are load-bearing:
 *
 * - **Provider pinning for embeddings.** Two providers serving the same model
 *   do not guarantee identical vectors. An unpinned embedding call can silently
 *   split one logical vector space in two, which degrades recall with no error
 *   anywhere. `embed()` always pins; `rerank()` and `chat()` do not need to,
 *   being stateless.
 * - **Dimension safety.** `VectorStore.addChunks()` falls back to
 *   `dropTable()` + `createTable()` on a schema mismatch, so writing a
 *   wrong-dimension vector into an existing table can DESTROY it.
 *   `assertDimensionCompatible()` is the pre-flight that must run before any
 *   ingestion using a cloud embedding model.
 * - **Spend guard.** A runaway loop against a metered API bills rather than
 *   merely inflating a counter (cf. the 2026-09-15 min-online lease leak). Every
 *   call goes through a daily cap and a circuit breaker, and `getCredits()`
 *   reads the real remaining balance rather than trusting local accounting.
 * - **Key hygiene.** The key is read from Config and never logged. `redactKey()`
 *   is used in every diagnostic path; `/api/status` on sidecars is
 *   unauthenticated on the LAN, so a leaked key in a log line is a real
 *   exposure.
 */

import { getConfig } from '@/lib/db/config';
import { createLogger } from '@/lib/logger';
import { findChatModel, findEmbeddingModel, findRerankModel } from './models';

const logger = createLogger('OpenRouter');

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Headers OpenRouter uses for attribution; harmless if absent. */
const APP_TITLE = 'Sound Suite';

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 'no-providers' = model exists but nobody serves it (404). Transient —
     *  callers should fall back to local, NOT treat it as a config error.
     *  'unknown-model' = the id is wrong (400). That IS a config error. */
    readonly kind: 'no-providers' | 'unknown-model' | 'auth' | 'rate-limit' | 'server' | 'network',
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/** Never log a key. Shows enough to identify which key, nothing usable. */
export function redactKey(key: string | undefined | null): string {
  if (!key) return '(unset)';
  if (key.length <= 12) return '****';
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

export async function getOpenRouterKey(): Promise<string | undefined> {
  const cfg = await getConfig();
  const key = (cfg as any).openRouterApiKey as string | undefined;
  return key && key.trim() ? key.trim() : undefined;
}

function authHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Title': APP_TITLE,
  };
}

function classify(status: number, body: string): OpenRouterError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 404 || /no endpoints found/i.test(body)) return 'no-providers';
  if (status === 400 && /does not exist/i.test(body)) return 'unknown-model';
  if (status >= 500) return 'server';
  return 'server';
}

// ---------------------------------------------------------------------------
// Spend guard
// ---------------------------------------------------------------------------

interface SpendState {
  /** UTC day key, e.g. '2026-09-15'. Resets the running total. */
  day: string;
  usdByRole: Record<string, number>;
  /** Consecutive upstream failures; opens the circuit at the threshold. */
  consecutiveFailures: number;
  openedAt: number | null;
}

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

const spend: SpendState = { day: utcDay(), usdByRole: {}, consecutiveFailures: 0, openedAt: null };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function rollDayIfNeeded(): void {
  const today = utcDay();
  if (spend.day !== today) {
    spend.day = today;
    spend.usdByRole = {};
    logger.info('OpenRouter daily spend counters reset', { day: today });
  }
}

export function recordSpend(role: string, usd: number): void {
  rollDayIfNeeded();
  spend.usdByRole[role] = (spend.usdByRole[role] || 0) + usd;
}

/**
 * Convert a usage figure into dollars and record it.
 *
 * Every priced call routes through here, because `assertSpendAllowed()` only
 * READS the running total — nothing incremented it, so a daily cap could never
 * be reached and the guard was decorative. Recording centrally (rather than in
 * each caller) is what makes the cap apply to embeddings and chat too, not just
 * the one call site that remembered.
 *
 * Prices come from the curated catalogue: the `/endpoints` API reports
 * `prompt: "0"` for rerank, so deriving cost from it would under-count to zero.
 */
function chargeTokens(role: string, tokens: number | undefined, pricePerMTokens: number | undefined): void {
  if (!tokens || !pricePerMTokens) return;
  recordSpend(role, (tokens / 1_000_000) * pricePerMTokens);
}

export function getSpendToday(role?: string): number {
  rollDayIfNeeded();
  if (role) return spend.usdByRole[role] || 0;
  return Object.values(spend.usdByRole).reduce((a, b) => a + b, 0);
}

export function circuitOpen(): boolean {
  if (spend.openedAt === null) return false;
  if (Date.now() - spend.openedAt > CIRCUIT_COOLDOWN_MS) {
    spend.openedAt = null;
    spend.consecutiveFailures = 0;
    logger.info('OpenRouter circuit breaker closed after cooldown');
    return false;
  }
  return true;
}

function noteSuccess(): void {
  spend.consecutiveFailures = 0;
}

function noteFailure(): void {
  spend.consecutiveFailures++;
  if (spend.consecutiveFailures >= CIRCUIT_THRESHOLD && spend.openedAt === null) {
    spend.openedAt = Date.now();
    logger.warn('OpenRouter circuit breaker OPEN', {
      consecutiveFailures: spend.consecutiveFailures,
      cooldownMs: CIRCUIT_COOLDOWN_MS,
    });
  }
}

/** Test seam. */
export function __resetSpendForTest(): void {
  spend.day = utcDay();
  spend.usdByRole = {};
  spend.consecutiveFailures = 0;
  spend.openedAt = null;
}

/** Throws when the role's daily cap is exceeded or the circuit is open. */
export async function assertSpendAllowed(role: string): Promise<void> {
  if (circuitOpen()) {
    throw new OpenRouterError(
      `OpenRouter circuit breaker is open after ${CIRCUIT_THRESHOLD} consecutive failures — falling back to local`,
      503,
      'server',
    );
  }
  const cfg = await getConfig();
  const caps = ((cfg as any).openRouterDailyCapUsd || {}) as Record<string, number>;
  const cap = caps[role];
  if (typeof cap === 'number' && cap > 0) {
    const used = getSpendToday(role);
    if (used >= cap) {
      throw new OpenRouterError(
        `OpenRouter daily cap reached for role "${role}": $${used.toFixed(4)} of $${cap.toFixed(2)} — reverting to local`,
        429,
        'rate-limit',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const key = await getOpenRouterKey();
  if (!key) throw new OpenRouterError('No OpenRouter API key configured', 401, 'auth');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      noteFailure();
      throw new OpenRouterError(
        `OpenRouter ${path} failed: ${res.status} ${text.slice(0, 200)}`,
        res.status,
        classify(res.status, text),
      );
    }
    noteSuccess();
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof OpenRouterError) throw err;
    noteFailure();
    const msg = err instanceof Error ? err.message : String(err);
    throw new OpenRouterError(`OpenRouter ${path} network error: ${msg}`, 0, 'network');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Availability — no key required
// ---------------------------------------------------------------------------

export interface ModelAvailability {
  id: string;
  available: boolean;
  providers: string[];
  /** USD per million prompt tokens, from the cheapest provider. */
  pricePerMTokens?: number;
  reason?: 'no-providers' | 'unknown-model';
}

/**
 * Ask which providers actually serve a model.
 *
 * This is the correct validation path for embedding and rerank models, which
 * `/api/v1/models` does not enumerate. It needs no API key and costs nothing —
 * strictly better than probing the data endpoint, and it distinguishes
 * "listed but unserved" (transient) from "wrong id" (a config error).
 */
export async function validateModel(id: string, timeoutMs = 10_000): Promise<ModelAvailability> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/models/${id}/endpoints`, { signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      const kind = classify(res.status, text);
      return { id, available: false, providers: [], reason: kind === 'unknown-model' ? 'unknown-model' : 'no-providers' };
    }
    const json = JSON.parse(text) as { data?: { endpoints?: Array<{ provider_name?: string; pricing?: { prompt?: string } }> } };
    const endpoints = json.data?.endpoints ?? [];
    const providers = endpoints.map((e) => e.provider_name).filter((p): p is string => !!p);
    // Pricing here is NOT reliable for every model class. Rerank endpoints
    // report `prompt: "0"` (verified 2026-09-15: Fireworks serving
    // qwen3-reranker-8b) even though the model page advertises $0.20/M, while
    // embedding endpoints do report a real figure (DeepInfra, $0.02/M).
    //
    // A literal 0 is therefore "not reported", not "free". Returning 0 would let
    // a caller conclude the model costs nothing and skip it in a cost estimate,
    // which is precisely the accounting mistake the spend guard exists to avoid.
    // Callers wanting an authoritative price should prefer the curated
    // `pricePerMTokens` in ./models, which is taken from the model page.
    const prices = endpoints
      .map((e) => (e.pricing?.prompt != null ? parseFloat(e.pricing.prompt) * 1e6 : NaN))
      .filter((n) => Number.isFinite(n) && n > 0);
    return {
      id,
      available: providers.length > 0,
      providers,
      pricePerMTokens: prices.length ? Math.min(...prices) : undefined,
      reason: providers.length ? undefined : 'no-providers',
    };
  } catch {
    return { id, available: false, providers: [], reason: 'no-providers' };
  } finally {
    clearTimeout(timer);
  }
}

export interface CreditsInfo {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

/** Real remaining balance — ground truth for the spend guard. */
export async function getCredits(timeoutMs = 10_000): Promise<CreditsInfo> {
  const key = await getOpenRouterKey();
  if (!key) throw new OpenRouterError('No OpenRouter API key configured', 401, 'auth');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/credits`, { headers: authHeaders(key), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new OpenRouterError(`credits failed: ${res.status}`, res.status, classify(res.status, text));
    const j = JSON.parse(text) as { data?: { total_credits?: number; total_usage?: number } };
    const totalCredits = j.data?.total_credits ?? 0;
    const totalUsage = j.data?.total_usage ?? 0;
    return { totalCredits, totalUsage, remaining: totalCredits - totalUsage };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dims: number;
  totalTokens?: number;
}

/**
 * Embed texts. ALWAYS pins the provider — see the module header.
 *
 * `expectedDims`, when given, is enforced: a provider silently returning a
 * different width is exactly the failure that can destroy a LanceDB table.
 */
export async function embed(
  texts: string[],
  model: string,
  opts: { pinProvider?: string; expectedDims?: number; timeoutMs?: number; role?: string } = {},
): Promise<EmbedResult> {
  const role = opts.role ?? 'embedding';
  await assertSpendAllowed(role);

  const body: Record<string, unknown> = { model, input: texts };
  if (opts.pinProvider) {
    body.provider = { order: [opts.pinProvider], allow_fallbacks: false };
  }

  const json = await post<{
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number };
  }>('/embeddings', body, opts.timeoutMs ?? 60_000);

  const sorted = [...json.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d) => d.embedding);
  const dims = vectors[0]?.length ?? 0;

  chargeTokens(role, json.usage?.total_tokens, findEmbeddingModel(model)?.pricePerMTokens);

  if (opts.expectedDims && dims !== opts.expectedDims) {
    throw new OpenRouterError(
      `OpenRouter model ${model} returned ${dims}-dim vectors but ${opts.expectedDims} was expected. ` +
        `Refusing to continue — writing these would corrupt or destroy the target vector table.`,
      500,
      'server',
    );
  }
  return { vectors, model, dims, totalTokens: json.usage?.total_tokens };
}

// ---------------------------------------------------------------------------
// Rerank
// ---------------------------------------------------------------------------

/** Identical in shape to the local vLLM `/v1/rerank` response. */
export interface RerankResponse {
  results: Array<{ index: number; relevance_score: number; document?: { text: string } }>;
  model?: string;
  usage?: { total_tokens: number };
}

export async function rerankDocuments(
  query: string,
  documents: string[],
  model: string,
  opts: { topN?: number; timeoutMs?: number; role?: string } = {},
): Promise<RerankResponse> {
  const role = opts.role ?? 'reranker';
  await assertSpendAllowed(role);
  const body: Record<string, unknown> = { model, query, documents };
  if (opts.topN) body.top_n = opts.topN;
  const out = await post<RerankResponse>('/rerank', body, opts.timeoutMs ?? 60_000);
  chargeTokens(role, out.usage?.total_tokens, findRerankModel(model)?.pricePerMTokens);
  return out;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatResult {
  content: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function chat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  model: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; role?: string } = {},
): Promise<ChatResult> {
  const guardRole = opts.role ?? 'completion';
  await assertSpendAllowed(guardRole);
  const body: Record<string, unknown> = { model, messages };
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;

  const json = await post<{
    choices: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: ChatResult['usage'];
  }>('/chat/completions', body, opts.timeoutMs ?? 120_000);

  // Chat is priced asymmetrically, so in/out tokens are charged separately
  // rather than against a single per-M rate.
  const def = findChatModel(model);
  if (def) {
    const inUsd = ((json.usage?.prompt_tokens ?? 0) / 1_000_000) * def.priceInPerM;
    const outUsd = ((json.usage?.completion_tokens ?? 0) / 1_000_000) * def.priceOutPerM;
    if (inUsd + outUsd > 0) recordSpend(guardRole, inUsd + outUsd);
  }

  return {
    content: json.choices?.[0]?.message?.content ?? '',
    model: json.model ?? model,
    usage: json.usage,
  };
}

// ---------------------------------------------------------------------------
// Dimension safety
// ---------------------------------------------------------------------------

/**
 * Refuse a provider/table dimension mismatch BEFORE anything is written.
 *
 * This exists because `VectorStore.addChunks()` reacts to a schema mismatch by
 * dropping and recreating the table. An operator switching `ss-embedding` from
 * the 1024-dim local 0.6b model to a 2560-dim cloud model would, without this
 * guard, destroy the corpus on the next ingestion.
 */
export function assertDimensionCompatible(
  providerDims: number,
  tableDims: number | null,
  context: { model: string; table: string },
): void {
  if (tableDims === null) return; // empty/new table adopts the provider's width
  if (providerDims !== tableDims) {
    const err: any = new Error(
      `Embedding dimension mismatch: model ${context.model} produces ${providerDims} dims but ` +
        `table "${context.table}" stores ${tableDims}. Refusing to ingest — writing these would ` +
        `trigger the drop-and-recreate path and destroy the table. Re-index into a new space instead.`,
    );
    err.code = 'EMBEDDING_DIMENSION_MISMATCH';
    throw err;
  }
}
