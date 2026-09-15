/**
 * GET/POST /api/openrouter/settings — the OpenRouter section of Config.
 *
 * `POST /api/config` cannot carry these fields: it rejects any
 * `embeddingProvider` outside `['transformers','openai','claude','ollama']`
 * and its `updateConfig()` call never forwards `openRouter*` fields even
 * though `updateConfig` itself supports them. That route is frozen/out of
 * scope here, so this is a dedicated sibling — same write-only key
 * semantics as `/api/admin/ai-keys` and `/api/config`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/db/config';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

function maskKey(value: string | undefined): { configured: boolean; last4?: string } {
  if (typeof value !== 'string' || value.length === 0) return { configured: false };
  return { configured: true, last4: value.slice(-4) };
}

/** Only a non-empty string is a real write; anything else leaves the stored key alone. */
function pickWritableKey(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/settings');
  if (denied) return denied;

  try {
    const config = await getConfig();
    return NextResponse.json({
      apiKey: maskKey(config.openRouterApiKey),
      enabled: config.openRouterEnabled,
      embeddingModel: config.openRouterEmbeddingModel,
      rerankModel: config.openRouterRerankModel,
      chatModel: config.openRouterChatModel,
      dailyCapUsd: config.openRouterDailyCapUsd ?? {},
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to load OpenRouter settings';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/settings');
  if (denied) return denied;

  try {
    const body = await request.json();

    const apiKeyWrite = pickWritableKey(body.apiKey ?? body.openRouterApiKey);

    let dailyCapUsd: Record<string, number> | undefined;
    if (body.dailyCapUsd && typeof body.dailyCapUsd === 'object') {
      dailyCapUsd = {};
      for (const [role, value] of Object.entries(body.dailyCapUsd as Record<string, unknown>)) {
        const n = typeof value === 'number' ? value : parseFloat(String(value));
        if (Number.isFinite(n) && n >= 0) dailyCapUsd[role] = n;
      }
    }

    await updateConfig({
      openRouterApiKey: apiKeyWrite,
      openRouterEnabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      openRouterEmbeddingModel: typeof body.embeddingModel === 'string' ? body.embeddingModel : undefined,
      openRouterRerankModel: typeof body.rerankModel === 'string' ? body.rerankModel : undefined,
      openRouterChatModel: typeof body.chatModel === 'string' ? body.chatModel : undefined,
      openRouterDailyCapUsd: dailyCapUsd,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to save OpenRouter settings';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
