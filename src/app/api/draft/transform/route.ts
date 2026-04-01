import { NextRequest, NextResponse } from 'next/server';
import { streamAI } from '@/lib/ai/ai-provider';
import { AIProviderKey, AI_PROVIDER_KEYS } from '@/lib/ai/models';
import { getTransformPrompt, TransformAction, ToneOption } from '@/lib/ai/draft-prompts';

const VALID_ACTIONS: TransformAction[] = ['adjust_tone', 'fix_grammar', 'extend', 'simplify', 'legalize'];
const VALID_TONES: ToneOption[] = ['formal', 'persuasive', 'neutral', 'aggressive', 'sympathetic'];

/**
 * POST /api/draft/transform
 * AI text transformation — streams NDJSON with progress, tokens, and final result.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, selectedText, documentContext, tone, provider, model } = body as {
      action: string;
      selectedText: string;
      documentContext?: string;
      tone?: string;
      provider: string;
      model: string;
    };

    if (!action || !VALID_ACTIONS.includes(action as TransformAction)) {
      return NextResponse.json(
        { error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}` },
        { status: 400 },
      );
    }

    if (!selectedText?.trim()) {
      return NextResponse.json({ error: 'selectedText is required' }, { status: 400 });
    }

    if (!provider || !AI_PROVIDER_KEYS.includes(provider as AIProviderKey)) {
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
    }

    if (action === 'adjust_tone' && tone && !VALID_TONES.includes(tone as ToneOption)) {
      return NextResponse.json(
        { error: `Invalid tone. Must be one of: ${VALID_TONES.join(', ')}` },
        { status: 400 },
      );
    }

    const systemPrompt = getTransformPrompt(action as TransformAction, {
      tone: (tone as ToneOption) || undefined,
    });

    let userMessage = selectedText.trim();
    if (documentContext?.trim()) {
      userMessage = `Context from the surrounding document:\n\n${documentContext.trim()}\n\n---\n\nText to transform:\n\n${userMessage}`;
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: Record<string, any>) => {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        };

        try {
          send({ type: 'progress', message: `Transforming text (${action})...` });

          let fullContent = '';

          for await (const event of streamAI({
            provider: provider as AIProviderKey,
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            maxTokens: 4096,
            temperature: 0.3,
          })) {
            if (event.type === 'token') {
              fullContent += event.text;
              send({ type: 'token', text: event.text });
            } else if (event.type === 'done') {
              send({
                type: 'result',
                data: {
                  text: event.content,
                  model: event.model,
                  provider: event.provider,
                  usage: event.usage,
                },
              });
            }
          }
        } catch (error) {
          send({ type: 'error', error: error instanceof Error ? error.message : 'Transform failed' });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      },
    });
  } catch (error) {
    console.error('Draft transform error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Transform failed' },
      { status: 500 },
    );
  }
}
