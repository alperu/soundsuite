import { NextRequest, NextResponse } from 'next/server';
import { getConfig, setConfigValue } from '@/lib/db/config';
import { AI_PROVIDERS, AIProviderKey, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

/**
 * GET /api/admin/ai-keys
 * Returns which providers have keys configured (never returns actual keys).
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'ai-keys');
  if (denied) return denied;

  try {
    const config = await getConfig();
    const result: Record<string, { configured: boolean; name: string }> = {};

    for (const key of AI_PROVIDER_KEYS) {
      const configKey = AI_PROVIDERS[key].configKey;
      const value = (config as any)[configKey] as string | undefined;
      result[key] = {
        configured: !!value && value.length > 0,
        name: AI_PROVIDERS[key].name,
      };
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load AI keys' },
      { status: 500 },
    );
  }
}

/** Config table key for each provider. */
const PROVIDER_CONFIG_KEYS: Record<AIProviderKey, string> = {
  openai: 'embedding.openaiApiKey',
  anthropic: 'embedding.claudeApiKey',
  gemini: 'ai.geminiApiKey',
  groq: 'ai.groqApiKey',
  grok: 'ai.grokApiKey',
  ollama: 'embedding.ollamaHost', // Ollama stores host URL, not API key
};

/**
 * POST /api/admin/ai-keys
 * Save an API key for a provider.
 * Body: { provider: AIProviderKey, apiKey: string }
 */
export async function POST(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'ai-keys');
  if (denied) return denied;

  try {
    const body = await request.json();
    const { provider, apiKey } = body as { provider: string; apiKey: string };

    if (!provider || !AI_PROVIDER_KEYS.includes(provider as AIProviderKey)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    }

    if (apiKey === undefined) {
      return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });
    }

    const dbKey = PROVIDER_CONFIG_KEYS[provider as AIProviderKey];
    await setConfigValue(dbKey, apiKey);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save API key' },
      { status: 500 },
    );
  }
}
