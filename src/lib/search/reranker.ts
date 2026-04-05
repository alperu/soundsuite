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
export async function rerank<T extends RerankableResult>(
  query: string,
  results: T[],
  topN?: number,
): Promise<T[]> {
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

  // Configure and ensure the reranker container is running
  rerankerLifecycle.setEnabled(config.rerankAutoManage);
  rerankerLifecycle.setIdleTimeout(config.rerankIdleTimeoutMin * 60 * 1000);
  await rerankerLifecycle.ensureRunning(config.rerankHost);

  logger.info('Reranker route', {
    host: config.rerankHost,
    model: config.rerankModel,
    useOrchestrator: config.rerankUseOrchestrator,
    autoManage: config.rerankAutoManage,
    query: query.slice(0, 60),
    documentCount: results.length,
  });

  const startMs = Date.now();
  try {
    logger.info('Reranking via vLLM', {
      host: config.rerankHost,
      model: config.rerankModel,
      documents: results.length,
      topN: effectiveTopN,
      queryPreview: query.slice(0, 80),
    });

    let reranked: T[];
    let totalTokens: number;
    let usedModel = config.rerankModel;

    try {
      const primary = await rerankViaVllmWithRetry(query, results, config.rerankModel, config.rerankHost, effectiveTopN);
      reranked = primary.items;
      totalTokens = primary.totalTokens;
    } catch (primaryErr) {
      // If a fallback model is configured, try it before giving up
      if (config.rerankFallbackModel) {
        logger.warn('Primary rerank model failed, trying fallback', {
          primaryModel: config.rerankModel,
          fallbackModel: config.rerankFallbackModel,
          error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        });
        const fallback = await rerankViaVllmWithRetry(query, results, config.rerankFallbackModel, config.rerankHost, effectiveTopN);
        reranked = fallback.items;
        totalTokens = fallback.totalTokens;
        usedModel = config.rerankFallbackModel;
      } else {
        throw primaryErr;
      }
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
    logger.error('vLLM reranking failed, using original order', err instanceof Error ? err : new Error(String(err)), {
      host: config.rerankHost,
      model: config.rerankModel,
      fallbackModel: config.rerankFallbackModel || 'none',
      durationMs: Date.now() - startMs,
      causeCode: cause?.code,
      causeErrno: cause?.errno,
      causeSyscall: cause?.syscall,
    });
    return results;
  } finally {
    rerankerLifecycle.markRequestDone();
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
): Promise<VllmRerankOutput<T>> {
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await rerankViaVllm(query, results, model, host, topN);
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
): Promise<VllmRerankOutput<T>> {
  const url = `${host.replace(/\/+$/, '')}/v1/rerank`;
  const documents = results.map((r) => r.text);

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
    signal: AbortSignal.timeout(30_000),
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
