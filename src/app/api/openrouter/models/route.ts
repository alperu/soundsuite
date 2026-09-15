/**
 * GET /api/openrouter/models — the live OpenRouter chat-model catalogue.
 *
 * `GET https://openrouter.ai/api/v1/models` needs no API key and returns
 * ~446 chat models (OpenRouter has zero embedding/rerank listings — see
 * `src/lib/openrouter/models.ts`). That payload is too large to put in the
 * Config table or an RSC payload, so it is cached in Redis for ~1h and
 * trimmed to only the fields the admin table renders before it is cached or
 * returned — never the raw upstream objects.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRedis, isRedisAvailable } from '@/lib/redis';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import { createLogger } from '@/lib/logger';

const logger = createLogger('OpenRouterModels');

// v2: payload now carries supportsTools/supportsReasoning — bump so a stale
// v1 cache entry (pre-existing deploys) doesn't serve the old shape.
const CACHE_KEY = 'openrouter:models:v2';
const CACHE_TTL_SEC = 60 * 60; // 1h

export interface OpenRouterCatalogueModel {
  id: string;
  name: string;
  contextLength: number | null;
  pricePromptPerMTokens: number | null;
  priceCompletionPerMTokens: number | null;
  modality: string | null;
  inputModalities: string[];
  /** From upstream `supported_parameters`. A model that cannot call tools
   *  cannot drive the RLM tool-use loop (ss-rlm-sandbox) — see
   *  admin-openrouter.tsx's RLM picker, which filters on this. */
  supportsTools: boolean;
  /** From upstream `supported_parameters` (`reasoning` or `include_reasoning`). */
  supportsReasoning: boolean;
}

interface UpstreamModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { modality?: string; input_modalities?: string[] };
  supported_parameters?: string[];
}

function trim(models: UpstreamModel[]): OpenRouterCatalogueModel[] {
  return models.map((m) => {
    const params = m.supported_parameters ?? [];
    return {
      id: m.id,
      name: m.name || m.id,
      contextLength: typeof m.context_length === 'number' ? m.context_length : null,
      pricePromptPerMTokens: m.pricing?.prompt != null ? parseFloat(m.pricing.prompt) * 1e6 : null,
      priceCompletionPerMTokens: m.pricing?.completion != null ? parseFloat(m.pricing.completion) * 1e6 : null,
      modality: m.architecture?.modality ?? null,
      inputModalities: m.architecture?.input_modalities ?? [],
      supportsTools: params.includes('tools'),
      supportsReasoning: params.includes('reasoning') || params.includes('include_reasoning'),
    };
  });
}

async function fetchCatalogue(): Promise<OpenRouterCatalogueModel[]> {
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models failed: ${res.status}`);
  }
  const json = (await res.json()) as { data?: UpstreamModel[] };
  return trim(json.data ?? []);
}

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/models');
  if (denied) return denied;

  try {
    const useCache = await isRedisAvailable();
    if (useCache) {
      const redis = getRedis();
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        return NextResponse.json({ models: JSON.parse(cached) as OpenRouterCatalogueModel[], cached: true });
      }
    }

    const models = await fetchCatalogue();

    if (useCache) {
      try {
        const redis = getRedis();
        await redis.set(CACHE_KEY, JSON.stringify(models), 'EX', CACHE_TTL_SEC);
      } catch (err) {
        // Cache write is best-effort — a failed SET should not fail the request.
        logger.warn('Failed to cache OpenRouter model catalogue', { error: String(err) });
      }
    }

    return NextResponse.json({ models, cached: false });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to load OpenRouter catalogue';
    logger.error('Catalogue fetch failed', error);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
