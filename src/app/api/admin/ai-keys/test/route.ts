import { NextRequest, NextResponse } from 'next/server';
import { testApiKey } from '@/lib/ai/ai-provider';
import { AIProviderKey, AI_PROVIDER_KEYS } from '@/lib/ai/models';

/**
 * POST /api/admin/ai-keys/test
 * Verify an API key by making a lightweight call to the provider.
 * Body: { provider: AIProviderKey, apiKey: string, embeddingModel?: string }
 *
 * When embeddingModel is provided for ollama, tests an actual embedding call
 * to verify the model is pulled and working.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { provider, apiKey, embeddingModel } = body as {
      provider: string;
      apiKey: string;
      embeddingModel?: string;
    };

    if (!provider || !AI_PROVIDER_KEYS.includes(provider as AIProviderKey)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    }

    if (!apiKey && provider !== 'ollama') {
      return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });
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

    const result = await testApiKey(provider as AIProviderKey, apiKey);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { valid: false, error: error instanceof Error ? error.message : 'Test failed' },
      { status: 500 },
    );
  }
}
