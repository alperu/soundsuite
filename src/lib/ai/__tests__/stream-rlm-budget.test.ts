/**
 * Unit tests for the RLM context-budget helpers.
 *
 * These guard the contract that prevents the round-2 HTTP 400 we shipped
 * before clamping was in place — vLLM rejects prompt_tokens + max_tokens
 * > max_model_len, and our previous code unconditionally requested 4096
 * output tokens regardless of input size.
 */

import {
  estimateInputTokens,
  clampOutputTokens,
  trimHistoryToFit,
  RLM_CONTEXT_TOKENS,
  TOKEN_CHAR_RATIO,
  MIN_OUTPUT_TOKENS,
  SAFETY_MARGIN_TOKENS,
  type ChatMessage,
} from '../stream-rlm';

// Produce a string of N chars so we can pin token estimates precisely.
const lorem = (chars: number) => 'a'.repeat(chars);

describe('estimateInputTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(estimateInputTokens([])).toBe(0);
  });

  it('sums char counts across messages and divides by TOKEN_CHAR_RATIO', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: lorem(320) },
      { role: 'user', content: lorem(640) },
    ];
    // 960 chars / 3.2 = 300
    expect(estimateInputTokens(messages)).toBe(300);
  });

  it('includes tool_calls JSON in the input estimate', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: lorem(320) },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'foo', arguments: '{"q":"x"}' } },
        ],
      },
    ];
    const tokens = estimateInputTokens(messages);
    // Just the content (320 chars / 3.2 = 100) plus some tool-call JSON cost.
    expect(tokens).toBeGreaterThan(100);
  });
});

describe('clampOutputTokens', () => {
  it('passes through the requested budget when there is plenty of room', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: lorem(100) }];
    const r = clampOutputTokens(msgs, 4096);
    expect(r.clamped).toBe(false);
    expect(r.maxTokens).toBe(4096);
    expect(r.estimatedInput).toBeLessThan(100);
  });

  it('clamps to the remaining budget when input is large', () => {
    // Want estimated input ≈ 28673 (the value we crashed on in prod).
    // chars = 28673 * 3.2 ≈ 91754
    const msgs: ChatMessage[] = [{ role: 'system', content: lorem(91754) }];
    const r = clampOutputTokens(msgs, 4096);
    // Budget: 32768 - 28673 - 256 (safety) = 3839 → clamp from 4096
    expect(r.clamped).toBe(true);
    expect(r.maxTokens).toBeLessThan(4096);
    expect(r.maxTokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
    // 91754 chars / 3.2 = 28673.125 → Math.ceil → 28674
    expect(r.estimatedInput).toBe(28674);
  });

  it('floors at MIN_OUTPUT_TOKENS even when the budget says less', () => {
    // Force budget < MIN_OUTPUT_TOKENS so the floor kicks in.
    // estimatedInput = 32768 - SAFETY - 1 (1 token less than min would allow)
    const inputTokens = RLM_CONTEXT_TOKENS - SAFETY_MARGIN_TOKENS - MIN_OUTPUT_TOKENS + 1;
    const msgs: ChatMessage[] = [{ role: 'system', content: lorem(inputTokens * TOKEN_CHAR_RATIO) }];
    const r = clampOutputTokens(msgs, 4096);
    expect(r.clamped).toBe(true);
    expect(r.maxTokens).toBe(MIN_OUTPUT_TOKENS);
  });

  it('never returns max_tokens such that input + max_tokens exceeds the ctx (above the floor)', () => {
    for (const chars of [10_000, 50_000, 80_000]) {
      const msgs: ChatMessage[] = [{ role: 'system', content: lorem(chars) }];
      const r = clampOutputTokens(msgs, 4096);
      // Above the floor, we must respect prompt + output ≤ ctx (with margin).
      if (r.maxTokens > MIN_OUTPUT_TOKENS) {
        expect(r.estimatedInput + r.maxTokens + SAFETY_MARGIN_TOKENS).toBeLessThanOrEqual(
          RLM_CONTEXT_TOKENS,
        );
      }
    }
  });
});

describe('trimHistoryToFit', () => {
  it('removes oldest assistant + trailing tool messages until fits', () => {
    // Build: [system, user, assistant1, tool1, tool2, assistant2, tool3]
    // Make each big enough that the whole thing exceeds the budget but
    // dropping (assistant1, tool1, tool2) puts us back under.
    const bigChars = Math.ceil((RLM_CONTEXT_TOKENS * TOKEN_CHAR_RATIO) / 5); // ~21k chars each
    const messages: ChatMessage[] = [
      { role: 'system', content: lorem(200) },
      { role: 'user', content: lorem(200) },
      { role: 'assistant', content: lorem(bigChars) },
      { role: 'tool', content: lorem(bigChars), tool_call_id: 't1', name: 'q' },
      { role: 'tool', content: lorem(bigChars), tool_call_id: 't2', name: 'q' },
      { role: 'assistant', content: lorem(bigChars) },
      { role: 'tool', content: lorem(bigChars), tool_call_id: 't3', name: 'q' },
    ];
    const before = messages.length;
    const removed = trimHistoryToFit(messages);
    expect(removed).toBeGreaterThan(0);
    expect(messages.length).toBe(before - removed);
    // Preserve system + user at the head.
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    // After trimming, the budget invariant must hold.
    expect(estimateInputTokens(messages) + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS).toBeLessThanOrEqual(
      RLM_CONTEXT_TOKENS,
    );
  });

  it('is a no-op when already fits', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: lorem(100) },
      { role: 'user', content: lorem(100) },
    ];
    const removed = trimHistoryToFit(messages);
    expect(removed).toBe(0);
    expect(messages.length).toBe(2);
  });

  it('preserves system + user even when over-budget with no assistant turns to drop', () => {
    // Single huge user turn. No assistant message → nothing to remove safely.
    const messages: ChatMessage[] = [
      { role: 'system', content: lorem(200) },
      { role: 'user', content: lorem(200_000) }, // ~62.5k tokens — far over
    ];
    const removed = trimHistoryToFit(messages);
    expect(removed).toBe(0);
    expect(messages.length).toBe(2);
  });
});
