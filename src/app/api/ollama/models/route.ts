import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/db/config';

/**
 * GET /api/ollama/models
 *
 * Fetches available models from the configured Ollama instance.
 * Calls Ollama's /api/tags endpoint and returns the model list.
 *
 * Caching strategy:
 *   - Server-side: results are cached in Redis (if available) for 5 minutes
 *     so repeated page loads don't hammer the Ollama server.
 *   - Client-side: the search interface caches results in a React ref so
 *     switching tabs doesn't re-fetch. For longer persistence across page
 *     navigations, the client stores results in IndexedDB via a small helper.
 *   - Background: The BackgroundScannerDaemon can periodically refresh
 *     the Redis cache so the model list stays current even without user action.
 */

const CACHE_KEY = 'ollama:models';
const CACHE_TTL_SECONDS = 300; // 5 minutes

export async function GET() {
  try {
    const config = await getConfig();
    // Use the dedicated completion host for model listing (the LLM dropdown),
    // falling back to the shared embedding host for backward compatibility.
    let host = config.ollamaCompletionHost || config.ollamaHost || 'http://localhost:11434';

    // When orchestrator is enabled, resolve the actual host from fleet-router.
    // Skip when completion minOnline=0 — listing models shouldn't trigger an
    // /acquire that auto-starts the completion container against operator policy.
    if (config.completionUseOrchestrator && (config.gpuMinCompletion ?? 0) > 0) {
      try {
        const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
        const ep = await resolveEndpoint('completion');
        host = ep.host;
      } catch {
        // Fall back to direct host
      }
    }

    // Try Redis cache first
    let cached: string | null = null;
    let redis: any = null;
    try {
      const { getRedis, isRedisAvailable } = await import('@/lib/redis');
      if (await isRedisAvailable()) {
        redis = getRedis();
        cached = await redis.get(CACHE_KEY);
        if (cached) {
          return NextResponse.json(JSON.parse(cached));
        }
      }
    } catch {
      // Redis not available, proceed without cache
    }

    // Fetch from Ollama
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Ollama returned ${res.status}`, models: [] },
        { status: 502 },
      );
    }

    const data = await res.json();
    // Filter out embedding-only models (they can't be used for chat/completion)
    const allModels = (data.models || []) as any[];
    const models: Array<{ id: string; label: string; size?: number }> = allModels
      .filter((m: any) => {
        const name = (m.name || m.model || '').toLowerCase();
        // Skip models that are clearly embedding-only
        return !name.includes('embedding');
      })
      .map((m: any) => ({
        id: m.name || m.model,
        label: m.name || m.model,
        size: m.size,
      }));

    const defaultModel = config.ollamaCompletionModel || null;

    const result = { models, host, defaultModel, cachedAt: new Date().toISOString() };

    // Store in Redis cache
    if (redis) {
      try {
        await redis.set(CACHE_KEY, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
      } catch {
        // Non-critical
      }
    }

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to connect to Ollama', models: [] },
      { status: 502 },
    );
  }
}
