/**
 * Live OpenRouter contract test for the ss-rlm-sandbox sub-model path.
 *
 * SKIPPED unless `OPENROUTER_TEST_KEY` is set — the repo convention for tests
 * needing a real credential. Never hardcode a key here.
 *
 *   OPENROUTER_TEST_KEY=sk-or-... npx jest virtual-chat-openrouter
 *
 * What it is for: every other test in this area mocks the client, so they prove
 * our routing logic and nothing about whether the request we send is one
 * OpenRouter accepts. This one spends a fraction of a cent to check the parts
 * that only the real API can confirm:
 *
 *   - the request shape is accepted at all
 *   - `usage.cost` comes back, which is what the rlm library's `max_budget`
 *     rail reads (rlm/clients/openai.py:_track_cost). If OpenRouter ever stops
 *     returning it for our `usage: {include: true}` request, that rail silently
 *     becomes a no-op and this is the only place that would notice.
 */

import { chat } from '../openrouter-client';

const KEY = process.env.OPENROUTER_TEST_KEY;
const MODEL = process.env.OPENROUTER_TEST_MODEL || 'deepseek/deepseek-v4-flash';
const d = KEY ? describe : describe.skip;

d('OpenRouter chat() — live', () => {
  jest.setTimeout(120_000);

  it('returns an OpenAI-shaped completion', async () => {
    const out = await chat(KEY!, MODEL, [
      { role: 'user', content: 'Reply with exactly the word: pong' },
    ], { passthrough: { max_tokens: 16, temperature: 0 } });

    const choices = out.choices as Array<{ message?: { content?: string } }>;
    expect(Array.isArray(choices)).toBe(true);
    expect(choices.length).toBeGreaterThan(0);
    expect(String(choices[0].message?.content ?? '')).toMatch(/pong/i);
  });

  it('returns usage.cost — the field max_budget depends on', async () => {
    const out = await chat(KEY!, MODEL, [
      { role: 'user', content: 'Say: ok' },
    ], { passthrough: { max_tokens: 8, temperature: 0 } });

    const usage = out.usage as Record<string, unknown> | undefined;
    expect(usage).toBeDefined();
    expect(typeof usage!.total_tokens).toBe('number');
    // `cost` is only present because chat() sends usage:{include:true}. If this
    // assertion fails, max_budget is inert and DESIGN §5 needs correcting back.
    expect(usage!.cost === undefined ? 'MISSING' : typeof usage!.cost).toBe('number');
  });
});
