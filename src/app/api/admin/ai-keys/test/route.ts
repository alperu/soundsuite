import { NextRequest, NextResponse } from 'next/server';
import { testApiKey } from '@/lib/ai/ai-provider';
import { AIProviderKey, AI_PROVIDERS, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { getConfig } from '@/lib/db/config';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

/**
 * POST /api/admin/ai-keys/test
 * Verify an API key by making a lightweight call to the provider.
 * Body: { provider: AIProviderKey, apiKey?: string, embeddingModel?: string }
 *
 * `apiKey` is **optional**: omit it to test the key already stored for that
 * provider. That is the normal path now that `GET /api/config` no longer
 * hands credentials to the browser (v6 §4) — the client asks the server to
 * test what it holds, rather than reading the key out and posting it back.
 * A supplied `apiKey` is still honoured, so the AI Keys panel can validate a
 * candidate key before saving it.
 *
 * When embeddingModel is provided for ollama, tests an actual embedding call
 * to verify the model is pulled and working. For ollama, `apiKey` carries the
 * host URL rather than a credential.
 */
export async function POST(request: NextRequest) {
  try {
    const denied = await requireAdminApiAccess(request, 'ai-keys/test');
    if (denied) return denied;

    const body = await request.json();
    const { provider, embeddingModel } = body as {
      provider: string;
      embeddingModel?: string;
    };

    if (!provider || !AI_PROVIDER_KEYS.includes(provider as AIProviderKey)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    }

    // Fall back to the stored credential when the caller sent none.
    let apiKey: string | undefined =
      typeof body.apiKey === 'string' && body.apiKey.length > 0 ? body.apiKey : undefined;
    if (!apiKey) {
      const config = await getConfig();
      const configKey = AI_PROVIDERS[provider as AIProviderKey]?.configKey;
      const stored = configKey ? (config as unknown as Record<string, unknown>)[configKey] : undefined;
      if (typeof stored === 'string' && stored.length > 0) apiKey = stored;
    }

    if (!apiKey && provider !== 'ollama') {
      return NextResponse.json(
        { valid: false, error: 'No API key configured for this provider — set it under AI Keys.' },
        { status: 400 },
      );
    }

    // Ollama embedding test — verify the specific model works
    if (provider === 'ollama' && embeddingModel && apiKey) {
      try {
        const { Ollama } = await import('ollama');
        const client = new Ollama({ host: apiKey });
        const response = await client.embed({
          model: embeddingModel,
          input: ['test embedding'],
        });
        const dims = response.embeddings?.[0]?.length ?? 0;
        return NextResponse.json({
          valid: true,
          dimensions: dims,
          message: `Model "${embeddingModel}" is working (${dims} dimensions)`,
        });
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('not found') || msg.includes('pull')) {
          return NextResponse.json({
            valid: false,
            error: `Model "${embeddingModel}" not found. Run: ollama pull ${embeddingModel}`,
          });
        }
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          return NextResponse.json({
            valid: false,
            error: 'Connection refused — is Ollama running?',
          });
        }
        return NextResponse.json({ valid: false, error: msg.slice(0, 200) });
      }
    }

    const result = await testApiKey(provider as AIProviderKey, apiKey ?? '');
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { valid: false, error: error instanceof Error ? error.message : 'Test failed' },
      { status: 500 },
    );
  }
}
