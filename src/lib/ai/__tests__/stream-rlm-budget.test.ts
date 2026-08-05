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
  trimMessagesToFit,
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
    // Size input (relative to the ctx window) so the remaining budget
    // (ctx - input - safety ≈ 3840) is below the requested 4096 but above the
    // MIN floor — forcing a partial clamp. Derived from RLM_CONTEXT_TOKENS so
    // this survives context-window changes.
    const estInput = RLM_CONTEXT_TOKENS - SAFETY_MARGIN_TOKENS - 3840;
    const msgs: ChatMessage[] = [{ role: 'system', content: lorem(Math.round(estInput * TOKEN_CHAR_RATIO)) }];
    const r = clampOutputTokens(msgs, 4096);
    expect(r.clamped).toBe(true);
    expect(r.maxTokens).toBeLessThan(4096);
    expect(r.maxTokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
  });

  it('does NOT inflate max_tokens to the MIN floor when that would overflow ctx', () => {
    // Regression for the HTTP 400: estimatedInput leaves a budget below
    // MIN_OUTPUT_TOKENS. The old code returned MIN_OUTPUT_TOKENS anyway, so
    // input + max_tokens exceeded max_model_len and vLLM 400'd. Now it must flag
    // needsInputTrim and keep the invariant.
    const inputTokens = RLM_CONTEXT_TOKENS - SAFETY_MARGIN_TOKENS - MIN_OUTPUT_TOKENS + 1;
    const msgs: ChatMessage[] = [{ role: 'system', content: lorem(inputTokens * TOKEN_CHAR_RATIO) }];
    const r = clampOutputTokens(msgs, 4096);
    expect(r.clamped).toBe(true);
    expect(r.needsInputTrim).toBe(true);
    expect(r.maxTokens).toBeLessThan(MIN_OUTPUT_TOKENS);
    expect(r.estimatedInput + r.maxTokens + SAFETY_MARGIN_TOKENS).toBeLessThanOrEqual(RLM_CONTEXT_TOKENS);
  });

  it('never inflates max_tokens above the real ceiling, and flags needsInputTrim (the 400 fix)', () => {
    // Sweep input sizes straddling the exact boundary that produced the 400
    // (estimatedInput ≈ 40193 with the real prompt). The old code inflated
    // max_tokens to MIN_OUTPUT_TOKENS (768) here, overflowing the window.
    const trimThreshold = RLM_CONTEXT_TOKENS - SAFETY_MARGIN_TOKENS - MIN_OUTPUT_TOKENS; // 39936
    for (const estInput of [39936, 40193, 40800, RLM_CONTEXT_TOKENS + 500]) {
      const msgs: ChatMessage[] = [{ role: 'system', content: lorem(Math.round(estInput * TOKEN_CHAR_RATIO)) }];
      const r = clampOutputTokens(msgs, 768);
      const ceil = RLM_CONTEXT_TOKENS - r.estimatedInput - SAFETY_MARGIN_TOKENS;
      // Never inflate output above what actually fits (this is the bug fix).
      expect(r.maxTokens).toBeLessThanOrEqual(Math.max(1, ceil));
      // needsInputTrim ⇔ even MIN_OUTPUT_TOKENS doesn't fit → caller must trim input.
      expect(r.needsInputTrim).toBe(r.estimatedInput > trimThreshold);
      // When the input DOES leave room (ceil ≥ MIN_OUTPUT), the full no-400
      // invariant holds from clamping alone.
      if (ceil >= MIN_OUTPUT_TOKENS) {
        expect(r.estimatedInput + r.maxTokens + SAFETY_MARGIN_TOKENS).toBeLessThanOrEqual(RLM_CONTEXT_TOKENS);
      }
    }
  });

  it('fixes the exact 40193-token prompt that 400d (returns a fitting output, not 768)', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: lorem(Math.round(40193 * TOKEN_CHAR_RATIO)) }];
    const r = clampOutputTokens(msgs, 768);
    expect(r.estimatedInput).toBeGreaterThanOrEqual(40193); // ~40193 (rounding)
    expect(r.needsInputTrim).toBe(true);
    // Old code → 768 → 40193+768=40961 > 40960 (the 400). New ≤ 511 → fits.
    expect(r.estimatedInput + r.maxTokens + SAFETY_MARGIN_TOKENS).toBeLessThanOrEqual(RLM_CONTEXT_TOKENS);
  });
});

describe('trimMessagesToFit', () => {
  it('truncates a giant single user turn (no history to drop) until the prompt fits', () => {
    // Reproduces the user-paste case: one enormous round-1 user message, no
    // assistant turns. trimHistoryToFit can do nothing, so the content itself
    // must be shortened (head kept) so the request can never 400.
    const messages: ChatMessage[] = [
      { role: 'system', content: lorem(200) },
      { role: 'user', content: 'KEEP-THIS-HEAD ' + lorem(300_000) }, // ~94k tokens — far over
    ];
    const { removed, truncatedChars } = trimMessagesToFit(messages);
    expect(removed).toBe(0);
    expect(truncatedChars).toBeGreaterThan(0);
    // Head preserved (the user's question sits at the top of the prompt).
    expect(messages[1].content?.startsWith('KEEP-THIS-HEAD')).toBe(true);
    // The budget invariant now holds — the request can be sent without a 400.
    expect(estimateInputTokens(messages) + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS).toBeLessThanOrEqual(
      RLM_CONTEXT_TOKENS,
    );
  });

  it('is a no-op when already fits', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: lorem(100) },
      { role: 'user', content: lorem(100) },
    ];
    const { removed, truncatedChars } = trimMessagesToFit(messages);
    expect(removed).toBe(0);
    expect(truncatedChars).toBe(0);
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
