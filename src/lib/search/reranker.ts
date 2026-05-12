/**
 * Reranker — calls a vLLM /v1/rerank endpoint to re-score search results
 * using a cross-encoder model for higher relevance accuracy.
 */

import { getConfig, AppConfig } from '@/lib/db/config';
import { createLogger } from '@/lib/logger';
import { rerankerLifecycle } from './reranker-lifecycle';

const logger = createLogger('Reranker');

export interface RerankableResult {
  text: string;
  score: number;
  [key: string]: any;
}

interface VllmRerankResult {
  index: number;
  relevance_score: number;
  document?: { text: string };
}

interface VllmRerankResponse {
  id: string;
  model: string;
  usage: { total_tokens: number };
  results: VllmRerankResult[];
}

/** Cached config to avoid DB reads on every search */
let _cachedConfig: AppConfig | null = null;
let _cacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

/** Cached reranker preflight verdict (fast fail when vLLM is down) */
const PREFLIGHT_OK_TTL_MS = 30_000; // longer once warm-up confirms model is loaded
const PREFLIGHT_FAIL_TTL_MS = 2_000;
const PREFLIGHT_TIMEOUT_MS = 1_500;
const WARMUP_TIMEOUT_MS = 10_000; // 5s was flaky on cold-start of 8B rerankers
let _preflightCache: { host: string; ok: boolean; at: number; error?: string } | null = null;

/** Module-level serializer: vLLM batches one rerank at a time per GPU, so
 *  parallel deep-search calls to the same host should queue not stack. */
let _rerankInflight: Promise<unknown> = Promise.resolve();
function serializeRerank<T>(fn: () => Promise<T>): Promise<T> {
  const next = _rerankInflight.then(fn, fn);
  _rerankInflight = next.catch(() => {});
  return next;
}

async function rerankerPreflight(host: string, model?: string): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  const cached = _preflightCache;
  if (cached && cached.host === host) {
    const ttl = cached.ok ? PREFLIGHT_OK_TTL_MS : PREFLIGHT_FAIL_TTL_MS;
    if (now - cached.at < ttl) return { ok: cached.ok, error: cached.error };
  }
  const base = host.replace(/\/+$/, '');
  // Step 1: /health — confirms HTTP server is up
  const healthCtrl = new AbortController();
  const healthTimer = setTimeout(() => healthCtrl.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/health`, { signal: healthCtrl.signal });
    if (!res.ok) {
      const result = { ok: false, error: `HTTP ${res.status}` };
      _preflightCache = { host, at: now, ...result };
      return result;
    }
  } catch (err) {
    const msg = (err as Error).name === 'AbortError'
      ? `preflight /health timeout after ${PREFLIGHT_TIMEOUT_MS}ms`
      : (err as Error).message;
    _preflightCache = { host, at: now, ok: false, error: msg };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(healthTimer);
  }
  // Step 2: 1-doc warm-up — confirms the model is actually loaded.
  // /health goes green the moment the HTTP server binds (well before model load).
  if (!model) {
    _preflightCache = { host, at: now, ok: true };
    return { ok: true };
  }
  const warmCtrl = new AbortController();
  const warmTimer = setTimeout(() => warmCtrl.abort(), WARMUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, query: 'ping', documents: ['ping'], top_n: 1, return_documents: false }),
      signal: warmCtrl.signal,
    });
    if (!res.ok) {
      const result = { ok: false, error: `warm-up HTTP ${res.status}` };
      _preflightCache = { host, at: now, ...result };
      return result;
    }
    _preflightCache = { host, at: now, ok: true };
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError'
      ? `model not ready (warm-up timeout after ${WARMUP_TIMEOUT_MS}ms — likely loading)`
      : (err as Error).message;
    _preflightCache = { host, at: now, ok: false, error: msg };
    return { ok: false, error: msg };
  } finally {
    clearTimeout(warmTimer);
  }
}

async function getRerankConfig(): Promise<AppConfig> {
  const now = Date.now();
  if (_cachedConfig && now - _cacheTime < CACHE_TTL) return _cachedConfig;
  _cachedConfig = await getConfig();
  _cacheTime = now;
  return _cachedConfig;
}

/**
 * Rerank search results using the configured reranking provider.
 * Returns the original results (re-sorted and trimmed) if reranking is enabled,
 * or the original results unchanged if disabled.
 *
 * @param query  The user's original search query
 * @param results  Search results with at least `text` and `score` fields
 * @param topN  Override for how many results to keep (defaults to config value)
 */
export interface RerankWarning {
  source: 'reranker';
  host?: string;
  reason: 'preflight' | 'lifecycle' | 'fetch' | 'score-validation' | 'fallback-model';
  message: string;
}

export async function rerank<T extends RerankableResult>(
  query: string,
  results: T[],
  topN?: number,
  onWarning?: (w: RerankWarning) => void,
): Promise<T[]> {
  const warn = (reason: RerankWarning['reason'], host: string | undefined, message: string) => {
    if (onWarning) onWarning({ source: 'reranker', host, reason, message });
  };
  if (results.length === 0) {
    logger.info('Reranking skipped', { reason: 'empty results' });
    return results;
  }

  const config = await getRerankConfig();

  if (!config.rerankEnabled) {
    logger.info('Reranking skipped', { reason: 'disabled' });
    return results;
  }
  if (config.rerankProvider === 'none') {
    logger.info('Reranking skipped', { reason: 'provider set to none' });
    return results;
  }
  if (!config.rerankHost) {
    logger.info('Reranking skipped', { reason: 'no host configured' });
    return results;
  }

  const effectiveTopN = topN ?? config.rerankTopN ?? 10;
  const timeoutMs = config.rerankTimeoutMs ?? 90_000;
  // Model context budget. Qwen3-Reranker-8B is started with --max-model-len 8192;
  // any single (query, doc) pair over that is rejected with HTTP 400 and aborts
  // the whole batch. Keep in sync with sideCar/src/lib/docker.ts buildVllmCmd.
  const MAX_MODEL_TOKENS = 8192;
  // Tightened from 256 — dense legal prose tokenizes worse than the 3 char/tok
  // estimate (Qwen tokenizer often produces 2.5–2.7 chars/tok). 512 gives a
  // proper buffer against estimate drift.
  const SAFETY_MARGIN_TOKENS = 512;
  // Lowered from 3.0 — more realistic for English legal prose with the Qwen
  // tokenizer (citations, statute numbers, etc. fragment heavily).
  const CHARS_PER_TOKEN = 2.7;
  // Hard cap the query itself — without this, a long-form question (>3000
  // chars) eats the entire token budget and the doc gets clamped to nothing,
  // OR if the estimate undercounts, the pair overflows 8192. 1500 chars ≈
  // 555 tokens, leaving ~7100 tokens for the doc.
  const QUERY_MAX_CHARS = 1500;
  const safeQuery = query && query.length > QUERY_MAX_CHARS
    ? query.slice(0, QUERY_MAX_CHARS - 4) + ' …'
    : (query ?? '');
  const queryTokensEstimate = Math.ceil(safeQuery.length / CHARS_PER_TOKEN);
  const perDocTokenBudget = Math.max(
    256,
    MAX_MODEL_TOKENS - queryTokensEstimate - SAFETY_MARGIN_TOKENS,
  );
  const perDocCharBudget = Math.floor(perDocTokenBudget * CHARS_PER_TOKEN);
  const maxDocChars = Math.min(config.rerankMaxDocChars ?? 18_000, perDocCharBudget);

  // Configure lifecycle (idle timeout config)
  rerankerLifecycle.setEnabled(config.rerankAutoManage);
  rerankerLifecycle.setIdleTimeout(config.rerankIdleTimeoutMin * 60 * 1000);

  // Build candidate host list: configured host first, then other reachable
  // sidecars from fleet-router. Cap at 2 attempts to avoid 90s × N stalls.
  const candidates: string[] = [config.rerankHost];
  try {
    const { getFleetStatus } = await import('@/lib/gpu/fleet-router');
    const fleet = await getFleetStatus();
    const configHostname = (() => { try { return new URL(config.rerankHost).hostname; } catch { return ''; } })();
    for (const s of fleet.sidecars) {
      if (s.status !== 'connected') continue;
      // Only sidecars that actually host a running vLLM reranker. Skip:
      //  - synthetic images ('dmr', 'host-ollama'): the sidecar reports the
      //    role as "running" for routing purposes but doesn't serve /v1/rerank
      //    (e.g. Mac with host-Ollama for embedding doesn't run vLLM).
      //  - status !== 'running': no container, exited, or in progress.
      //  - missing reranker block: older sidecars or non-GPU hosts that don't
      //    track the role at all.
      // Without this guard, a Mac sidecar at host.docker.internal lands in
      // the candidate list and the master burns 5-15 s waiting for preflight
      // to fail before falling through to a real reranker host.
      const rerCS = (s.sidecarStatus as { containers?: Record<string, { status?: string; image?: string }> } | undefined)?.containers?.reranker;
      if (!rerCS) continue;
      if (rerCS.status !== 'running') {
        logger.info(`Rerank candidate skip: ${s.hostname} reranker.status=${rerCS.status}`);
        continue;
      }
      if (rerCS.image === 'dmr' || rerCS.image === 'host-ollama') {
        logger.info(`Rerank candidate skip: ${s.hostname} reranker.image=${rerCS.image} (synthetic — not a real vLLM endpoint)`);
        continue;
      }
      try {
        const h = new URL(s.url).hostname;
        if (h === configHostname) continue;
        candidates.push(`http://${h}:8099`);
      } catch { /* skip */ }
    }
  } catch { /* fleet-router unavailable, single-host only */ }

  // Lifecycle acquire happens ONCE for the primary host below — not per
  // candidate. Previously this ran inside tryHost, so every failed failover
  // sent an extra /acquire to the sidecar while markRequestDone() only sent
  // one /release. Net leak: +1 activeRequests per failed call, which kept
  // idle timers from ever starting and pinned VRAM at 99%.
  let lifecycleAcquired = false;
  try {
    await rerankerLifecycle.ensureRunning(config.rerankHost);
    lifecycleAcquired = true;
  } catch (err) {
    warn('lifecycle', config.rerankHost, (err as Error).message);
    // Fall through — preflight on each candidate will catch unreachable hosts.
  }

  const tryHost = async (host: string): Promise<{ items: T[]; tokens: number; model: string } | { error: RerankWarning }> => {
    const pf = await rerankerPreflight(host, config.rerankModel);
    if (!pf.ok) {
      return { error: { source: 'reranker', host, reason: 'preflight', message: pf.error || 'preflight failed' } };
    }
    try {
      const out = await serializeRerank(() =>
        rerankViaVllmWithRetry(safeQuery, results, config.rerankModel, host, effectiveTopN, timeoutMs, maxDocChars),
      );
      return { items: out.items, tokens: out.totalTokens, model: config.rerankModel };
    } catch (primaryErr) {
      if (config.rerankFallbackModel) {
        try {
          const fb = await serializeRerank(() =>
            rerankViaVllmWithRetry(safeQuery, results, config.rerankFallbackModel, host, effectiveTopN, timeoutMs, maxDocChars),
          );
          return { items: fb.items, tokens: fb.totalTokens, model: config.rerankFallbackModel };
        } catch (fbErr) {
          return { error: { source: 'reranker', host, reason: 'fetch', message: (fbErr as Error).message } };
        }
      }
      return { error: { source: 'reranker', host, reason: 'fetch', message: (primaryErr as Error).message } };
    }
  };

  const startMs = Date.now();
  try {
    const MAX_HOSTS_TO_TRY = 2;
    let reranked: T[] | null = null;
    let totalTokens = 0;
    let usedModel = config.rerankModel;
    let lastWarning: RerankWarning | null = null;

    for (const host of candidates.slice(0, MAX_HOSTS_TO_TRY)) {
      logger.info('Reranker attempt', {
        host,
        model: config.rerankModel,
        candidates: candidates.length,
        documentCount: results.length,
      });
      const result = await tryHost(host);
      if ('items' in result) {
        reranked = result.items;
        totalTokens = result.tokens;
        usedModel = result.model;
        if (lastWarning) {
          // Surface that we recovered on a fallback host
          warn('fetch', host, `recovered after ${candidates.indexOf(host)} prior host failures`);
        }
        break;
      }
      lastWarning = result.error;
      logger.warn('Reranker host failed, trying next', {
        host,
        reason: result.error.reason,
        message: result.error.message,
      });
      warn(result.error.reason, result.error.host, result.error.message);
    }

    if (!reranked) {
      // All hosts failed — return original order (graceful degrade)
      return results.slice(0, effectiveTopN);
    }

    // Score validation: detect degenerate scores from misbehaving models
    if (config.rerankScoreValidation && reranked.length > 1) {
      const validation = validateRerankScores(reranked);
      if (!validation.valid) {
        logger.warn('Rerank score validation failed — returning original order', {
          reason: validation.reason,
          model: usedModel,
          scores: reranked.slice(0, 5).map(r => r.score),
        });
        warn('score-validation', config.rerankHost, `score validation failed: ${validation.reason}`);
        return results.slice(0, effectiveTopN);
      }
    }

    logger.info('Reranking completed', {
      durationMs: Date.now() - startMs,
      resultCount: reranked.length,
      topScore: reranked[0]?.score,
      totalTokens,
      model: usedModel,
    });
    return reranked;
  } catch (err) {
    // Undici packs the real socket errno in err.cause — surface it so
    // future incidents don't hide behind the opaque "TypeError: fetch failed".
    const cause = (err as { cause?: { code?: string; errno?: number; syscall?: string } })?.cause;
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error('vLLM reranking failed, using original order', err instanceof Error ? err : new Error(String(err)), {
      host: config.rerankHost,
      model: config.rerankModel,
      fallbackModel: config.rerankFallbackModel || 'none',
      durationMs: Date.now() - startMs,
      causeCode: cause?.code,
      causeErrno: cause?.errno,
      causeSyscall: cause?.syscall,
    });
    warn('fetch', config.rerankHost, errMessage);
    return results;
  } finally {
    // Pair with the single ensureRunning() above. Only release if the
    // initial acquire actually succeeded — otherwise we'd decrement a
    // counter we never incremented.
    if (lifecycleAcquired) {
      rerankerLifecycle.markRequestDone();
    }
  }
}

interface VllmRerankOutput<T> {
  items: T[];
  totalTokens: number;
}

/**
 * Retry wrapper around `rerankViaVllm` that recovers from transient
 * socket-level failures (stale keep-alive, brief worker restart, RST mid-
 * write). HTTP error statuses from vLLM are passed through unchanged — they
 * indicate real bugs and should not be retried.
 *
 * Context: Node's undici pool reuses TCP sockets, and vLLM's uvicorn server
 * recycles idle connections after 5 s. If a reused socket has been closed
 * peer-side, the next write fails with `TypeError: fetch failed` (wrapping
 * ECONNRESET / EPIPE / UND_ERR_SOCKET). A single immediate retry opens a
 * fresh socket and almost always succeeds.
 */
async function rerankViaVllmWithRetry<T extends RerankableResult>(
  query: string,
  results: T[],
  model: string,
  host: string,
  topN: number,
  timeoutMs: number,
  maxDocChars: number,
): Promise<VllmRerankOutput<T>> {
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await rerankViaVllm(query, results, model, host, topN, timeoutMs, maxDocChars);
    } catch (err) {
      lastErr = err;
      // Classify the error. Socket errors come from undici wrapped as
      // TypeError('fetch failed') with .cause.code set to an errno.
      // HTTP errors thrown by rerankViaVllm itself start with "vLLM rerank "
      // and carry a status code — those are application-level, not retryable.
      const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
      const directCode = (err as { code?: string })?.code;
      const isSocketError =
        (err instanceof TypeError && err.message === 'fetch failed') ||
        causeCode === 'ECONNRESET' ||
        causeCode === 'EPIPE' ||
        causeCode === 'UND_ERR_SOCKET' ||
        causeCode === 'UND_ERR_CLOSED' ||
        directCode === 'ECONNRESET' ||
        directCode === 'EPIPE';

      if (!isSocketError || attempt === MAX_ATTEMPTS) throw err;

      logger.warn('rerank transient socket error, retrying', {
        attempt,
        model,
        host,
        causeCode,
        message: err instanceof Error ? err.message : String(err),
      });
      // Tiny backoff — gives undici's pool a moment to drop the dead socket
      // so attempt 2 opens a fresh one.
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw lastErr;
}

async function rerankViaVllm<T extends RerankableResult>(
  query: string,
  results: T[],
  model: string,
  host: string,
  topN: number,
  timeoutMs: number,
  maxDocChars: number,
): Promise<VllmRerankOutput<T>> {
  const url = `${host.replace(/\/+$/, '')}/v1/rerank`;

  // Trim each document to the model's context budget. vLLM rejects the entire
  // batch with HTTP 400 if any single (query, doc) pair exceeds max_model_len,
  // so one outlier blocks 99 valid docs. Beginning-keep is the standard cross-
  // encoder default; truncated docs still get coherent relevance scores.
  let truncatedCount = 0;
  let longestOriginal = 0;
  const documents = results.map((r) => {
    const text = r.text ?? '';
    if (text.length > longestOriginal) longestOriginal = text.length;
    if (text.length <= maxDocChars) return text;
    truncatedCount++;
    return text.slice(0, maxDocChars - 4) + ' …';
  });
  if (truncatedCount > 0) {
    logger.info('Rerank: truncated long documents to fit context window', {
      truncated: truncatedCount,
      total: documents.length,
      maxChars: maxDocChars,
      longestOriginal,
      model,
    });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      query,
      documents,
      top_n: Math.min(topN, results.length),
      return_documents: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`vLLM rerank ${res.status}: ${text.slice(0, 200)}`);
  }

  const data: VllmRerankResponse = await res.json();

  if (!Array.isArray(data.results)) {
    throw new Error('Unexpected vLLM response — no results array');
  }

  // Map back to original results with updated scores
  // vLLM results are already sorted by relevance (highest first)
  return {
    items: data.results.map((rr) => ({
      ...results[rr.index],
      score: rr.relevance_score,
    })),
    totalTokens: data.usage?.total_tokens ?? 0,
  };
}

/**
 * Validate rerank scores to detect degenerate model outputs.
 * Returns { valid: false, reason } when scores indicate the model
 * is not producing meaningful relevance distinctions.
 */
function validateRerankScores<T extends RerankableResult>(
  results: T[],
): { valid: boolean; reason?: string } {
  const scores = results.map(r => r.score);

  // Check: all scores identical (no discrimination)
  const uniqueScores = new Set(scores.map(s => s.toFixed(6)));
  if (uniqueScores.size === 1) {
    return { valid: false, reason: 'all scores identical' };
  }

  // Check: all scores are zero or near-zero
  const maxScore = Math.max(...scores);
  if (maxScore < 0.001) {
    return { valid: false, reason: `highest score too low (${maxScore.toFixed(6)})` };
  }

  // Check: all scores are NaN or negative
  if (scores.some(s => isNaN(s))) {
    return { valid: false, reason: 'NaN scores detected' };
  }
  if (scores.every(s => s < 0)) {
    return { valid: false, reason: 'all scores negative' };
  }

  // Check: variance is suspiciously low (scores cluster within a tiny range)
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const coeffOfVariation = Math.sqrt(variance) / (Math.abs(mean) || 1);
  if (coeffOfVariation < 0.001 && scores.length >= 3) {
    return { valid: false, reason: `near-zero variance (CV=${coeffOfVariation.toFixed(6)})` };
  }

  return { valid: true };
}

/** Bust the config cache (e.g. after saving settings) */
export function invalidateRerankCache(): void {
  _cachedConfig = null;
  _cacheTime = 0;
}
