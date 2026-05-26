/**
 * POST /api/search/axon-generate
 *
 * Translates a plain-English question into an Axon/Haystack filter expression
 * using the configured Local AI (Ollama by default per /admin/localai).
 *
 * Body:   { english: string } — max 500 chars, non-empty after trim.
 * Returns { ok: true, axon: string }       on success
 *         { ok: false, error: string }     on failure
 *         400                              on bad input
 *
 * The model receives a deterministic system prompt built from
 * `filter-logic-catalogue.ts` so it knows the available fields, operators,
 * and ref syntax. We validate the model's output with `parseBooleanQuery`
 * and retry once with the parser error if the first attempt is invalid.
 */

import { NextRequest, NextResponse } from 'next/server';

import { completeAI, type AIMessage } from '@/lib/ai/ai-provider';
import { getConfig } from '@/lib/db/config';
import { parseBooleanQuery } from '@/lib/search/boolean-query';
import { buildAxonSystemPrompt, sanitizeModelOutput } from './prompt';

export const dynamic = 'force-dynamic';

const MAX_LEN = 500;

export async function POST(req: NextRequest) {
  let body: { english?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const englishRaw = typeof body?.english === 'string' ? body.english : '';
  const english = englishRaw.trim();
  if (!english) {
    return NextResponse.json({ ok: false, error: 'english is required' }, { status: 400 });
  }
  if (english.length > MAX_LEN) {
    return NextResponse.json(
      { ok: false, error: `english is too long (max ${MAX_LEN} chars)` },
      { status: 400 },
    );
  }

  let config;
  try {
    config = await getConfig();
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Failed to read Local AI config: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  // Ollama is the default Local AI provider per /admin/localai. The model
  // is configured via `ai.ollamaCompletionModel`. Anything else means the
  // operator hasn't finished Local AI setup.
  const model = config.ollamaCompletionModel?.trim();
  if (!model) {
    return NextResponse.json(
      {
        ok: false,
        error: 'No Local AI model configured. Set one at /admin/localai.',
      },
      { status: 503 },
    );
  }

  const systemPrompt = buildAxonSystemPrompt(new Date());

  const baseMessages: AIMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: english },
  ];

  // Attempt 1
  let attempt1: string;
  try {
    const r = await completeAI({
      provider: 'ollama',
      model,
      messages: baseMessages,
      temperature: 0,
      maxTokens: 256,
      thinking: false,
    });
    attempt1 = sanitizeModelOutput(r.content);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Local AI request failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const parsed1 = parseBooleanQuery(attempt1);
  if (parsed1.ok) {
    return NextResponse.json({ ok: true, axon: attempt1 });
  }

  // Attempt 2 — surface the parser error and ask for a corrected expression.
  const retryMessages: AIMessage[] = [
    ...baseMessages,
    { role: 'assistant', content: attempt1 },
    {
      role: 'user',
      content:
        `That expression failed to parse: ${parsed1.error} (position ${parsed1.position}). ` +
        `Output ONLY a corrected single-line Axon expression — no explanation, no markdown.`,
    },
  ];

  let attempt2: string;
  try {
    const r = await completeAI({
      provider: 'ollama',
      model,
      messages: retryMessages,
      temperature: 0,
      maxTokens: 256,
      thinking: false,
    });
    attempt2 = sanitizeModelOutput(r.content);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Local AI retry failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const parsed2 = parseBooleanQuery(attempt2);
  if (parsed2.ok) {
    return NextResponse.json({ ok: true, axon: attempt2 });
  }

  return NextResponse.json(
    { ok: false, error: 'Could not generate a valid Axon query.' },
    { status: 200 },
  );
}
