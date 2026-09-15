/** @jest-environment node */
/**
 * The sandbox path must be budgeted against the HOSTED model's context window,
 * not ss-rlm's 40960 vLLM ceiling.
 *
 * Why this file exists: `RLM_CONTEXT_TOKENS` was read in four places across
 * three exported functions. Parameterising only `clampOutputTokens` would have
 * looked correct — `needsInputTrim` stays false for anything under ~1M, so the
 * trim path never fires in the happy case — right up until input actually
 * exceeded the budget, at which point `trimMessagesToFit` would have shredded a
 * 900k-token prompt down to 40k. So every one of the three is pinned here.
 */

import {
  clampOutputTokens,
  trimHistoryToFit,
  trimMessagesToFit,
  hostedContextBudget,
  estimateInputTokens,
  RLM_CONTEXT_TOKENS,
  HOSTED_CONTEXT_UTILIZATION,
  SAFETY_MARGIN_TOKENS,
  MIN_OUTPUT_TOKENS,
  TOKEN_CHAR_RATIO,
  type ChatMessage,
} from '../stream-rlm';

const DEEPSEEK = 'deepseek/deepseek-v4-flash';
/** 1_048_576 * 0.9 */
const DEEPSEEK_BUDGET = Math.floor(1_048_576 * HOSTED_CONTEXT_UTILIZATION);

function msg(role: ChatMessage['role'], chars: number): ChatMessage {
  return { role, content: 'x'.repeat(chars) };
}

describe('hostedContextBudget', () => {
  it('uses the catalogue window, scaled by the utilization fraction', () => {
    expect(hostedContextBudget(DEEPSEEK)).toBe(DEEPSEEK_BUDGET);
    expect(hostedContextBudget(DEEPSEEK)).toBeGreaterThan(RLM_CONTEXT_TOKENS * 20);
  });

  it('never returns the raw advertised window', () => {
    // The margin constants were tuned at 40960; shipping 1_048_576 raw is a
    // provider-side 400 the moment the char/token estimate drifts.
    expect(hostedContextBudget(DEEPSEEK)).toBeLessThan(1_048_576);
  });

  it('falls back to the self-hosted ceiling for an id not in the catalogue', () => {
    // rlm.sandboxModel is free-form — /api/openrouter/settings does not check
    // it against the catalogue — so this is a reachable path, not a guard.
    expect(hostedContextBudget('vendor/not-a-real-model')).toBe(RLM_CONTEXT_TOKENS);
    expect(hostedContextBudget('')).toBe(RLM_CONTEXT_TOKENS);
  });
});

describe('the three budget functions honour an explicit context window', () => {
  it('clampOutputTokens allows a far larger answer on the hosted budget', () => {
    const messages = [msg('system', 400), msg('user', 200_000)];

    const local = clampOutputTokens(messages, 4096);
    const hosted = clampOutputTokens(messages, 4096, DEEPSEEK_BUDGET);

    // ~62.5k estimated input: over the 40960 ceiling entirely, but trivial for
    // DeepSeek. The local path cannot even fit MIN_OUTPUT_TOKENS.
    expect(local.needsInputTrim).toBe(true);
    expect(hosted.needsInputTrim).toBe(false);
    expect(hosted.maxTokens).toBe(4096);
    expect(hosted.clamped).toBe(false);
  });

  it('trimHistoryToFit does not drop history that fits the hosted window', () => {
    // 200k chars ≈ 62.5k tokens: over the 40960 ceiling (which leaves only
    // 39_936 for input after MIN_OUTPUT + SAFETY), far under DeepSeek's.
    const big = () => msg('assistant', 200_000);
    const local: ChatMessage[] = [msg('system', 100), msg('user', 100), big(), msg('tool', 100), msg('user', 50)];
    const hosted: ChatMessage[] = [msg('system', 100), msg('user', 100), big(), msg('tool', 100), msg('user', 50)];

    expect(trimHistoryToFit(local)).toBeGreaterThan(0);
    expect(trimHistoryToFit(hosted, DEEPSEEK_BUDGET)).toBe(0);
    expect(hosted).toHaveLength(5);
  });

  it('trimMessagesToFit does not truncate a large paste that fits the hosted window', () => {
    // This is the regression that a partial fix would have shipped: a prompt
    // well inside DeepSeek's window, shredded to the vLLM ceiling.
    const chars = 500_000;
    const local: ChatMessage[] = [msg('system', 100), msg('user', chars)];
    const hosted: ChatMessage[] = [msg('system', 100), msg('user', chars)];

    const localResult = trimMessagesToFit(local);
    const hostedResult = trimMessagesToFit(hosted, DEEPSEEK_BUDGET);

    expect(localResult.truncatedChars).toBeGreaterThan(0);
    expect(hostedResult.truncatedChars).toBe(0);
    expect(hosted[1].content).toHaveLength(chars);
  });
});

describe('the default is unchanged — the self-hosted path must not move', () => {
  it.each([
    ['clampOutputTokens', () => clampOutputTokens([msg('user', 200_000)], 4096)],
  ])('%s defaults to RLM_CONTEXT_TOKENS when no budget is passed', (_label, run) => {
    const withDefault = run();
    const explicit = clampOutputTokens([msg('user', 200_000)], 4096, RLM_CONTEXT_TOKENS);
    expect(withDefault).toEqual(explicit);
  });

  it('still refuses to exceed the window it was given', () => {
    // The invariant the module exists to enforce, now at hosted scale.
    const messages = [msg('user', Math.floor(DEEPSEEK_BUDGET * TOKEN_CHAR_RATIO * 0.999))];
    const r = clampOutputTokens(messages, 8192, DEEPSEEK_BUDGET);
    expect(estimateInputTokens(messages) + r.maxTokens + SAFETY_MARGIN_TOKENS)
      .toBeLessThanOrEqual(DEEPSEEK_BUDGET);
  });

  it('trims to the hosted budget, not below it, when input genuinely overflows', () => {
    const over = Math.ceil(DEEPSEEK_BUDGET * TOKEN_CHAR_RATIO * 1.2);
    const messages: ChatMessage[] = [msg('system', 100), msg('user', over)];

    trimMessagesToFit(messages, DEEPSEEK_BUDGET);

    const fitted = estimateInputTokens(messages) + MIN_OUTPUT_TOKENS + SAFETY_MARGIN_TOKENS;
    expect(fitted).toBeLessThanOrEqual(DEEPSEEK_BUDGET);
    // …and it kept far more than the vLLM ceiling would have allowed.
    expect(estimateInputTokens(messages)).toBeGreaterThan(RLM_CONTEXT_TOKENS * 10);
  });
});
