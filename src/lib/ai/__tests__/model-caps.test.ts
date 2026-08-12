import {
  getModelCaps,
  clampEffort,
  shapeOpenAICompatParams,
  supportsAdaptiveEffort,
  AI_PROVIDERS,
} from '../models';

describe('getModelCaps', () => {
  it('returns reasoning-model caps for GPT-5.6', () => {
    const caps = getModelCaps('openai', 'gpt-5.6-sol');
    expect(caps.tokenParam).toBe('max_completion_tokens');
    expect(caps.temperature).toBe(false);
    expect(caps.effort).toContain('max');
  });

  it('falls back to permissive defaults for unknown models (custom Ollama)', () => {
    const caps = getModelCaps('ollama', 'some-user-pulled-model:7b');
    expect(caps.tokenParam).toBe('max_tokens');
    expect(caps.temperature).toBe(true);
    expect(caps.effort).toBeNull();
  });
});

describe('clampEffort', () => {
  it('keeps a supported value', () => {
    expect(clampEffort('high', ['low', 'medium', 'high'])).toBe('high');
  });

  it('clamps down to the nearest supported level, not the default', () => {
    // GPT-5.5 rejects `max` — the user should get xhigh, not medium.
    expect(clampEffort('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
    // grok-4.5 tops out at high.
    expect(clampEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(clampEffort('xhigh', ['low', 'medium', 'high'])).toBe('high');
  });
});

describe('shapeOpenAICompatParams (regression: the OpenAI 400)', () => {
  // The bug that motivated this module: gpt-5 rejected `max_tokens`
  // ("Use 'max_completion_tokens' instead") and non-default temperature.
  it('sends max_completion_tokens, no temperature, and clamped effort for reasoning models', () => {
    const params = shapeOpenAICompatParams('openai', 'gpt-5.5', {
      maxTokens: 8192,
      temperature: 0.3,
      effort: 'max', // stale persisted value gpt-5.5 rejects
    });
    expect(params).toEqual({
      max_completion_tokens: 8192,
      reasoning_effort: 'xhigh',
    });
    expect(params).not.toHaveProperty('max_tokens');
    expect(params).not.toHaveProperty('temperature');
  });

  it('keeps classic params for non-reasoning models', () => {
    const params = shapeOpenAICompatParams('groq', 'llama-3.3-70b-versatile', {
      maxTokens: 8192,
      temperature: 0.3,
      effort: 'max',
    });
    expect(params).toEqual({ max_tokens: 8192, temperature: 0.3 });
    expect(params).not.toHaveProperty('reasoning_effort');
  });

  it('clamps the budget to the model cap', () => {
    const params = shapeOpenAICompatParams('groq', 'llama-3.3-70b-versatile', {
      maxTokens: 64000,
      temperature: 0.3,
    });
    expect(params.max_tokens).toBe(32768);
  });

  it('sends reasoning_effort for grok-4.5, clamped to its low/medium/high range', () => {
    const params = shapeOpenAICompatParams('grok', 'grok-4.5', {
      maxTokens: 4096,
      temperature: 0.3,
      effort: 'xhigh',
    });
    expect(params.reasoning_effort).toBe('high');
  });

  it('shapes Gemini 3.x requests: budget capped, temperature omitted, effort clamped', () => {
    // Google's 3.x guidance: temperature silently degrades reasoning — must
    // be omitted, not passed through.
    const params = shapeOpenAICompatParams('gemini', 'gemini-3.6-flash', {
      maxTokens: 100000,
      temperature: 0.3,
      effort: 'max',
    });
    expect(params).toEqual({
      max_tokens: 65536,
      reasoning_effort: 'high',
    });
    expect(params).not.toHaveProperty('temperature');
  });

  it('omits effort entirely when the caller passed none', () => {
    const params = shapeOpenAICompatParams('openai', 'gpt-5.6-terra', {
      maxTokens: 4096,
      temperature: 0.3,
    });
    expect(params).not.toHaveProperty('reasoning_effort');
  });
});

describe('catalog consistency', () => {
  it('never routes Anthropic effort through reasoning_effort', () => {
    for (const m of AI_PROVIDERS.anthropic.models) {
      if (m.caps?.effort) expect(m.caps.effortParam).toBe('output_config.effort');
    }
  });

  it('supportsAdaptiveEffort matches the anthropic adaptive catalog entries', () => {
    for (const m of AI_PROVIDERS.anthropic.models) {
      expect(supportsAdaptiveEffort(m.id)).toBe(m.caps?.effortParam === 'output_config.effort');
    }
    // Kept for persisted selections even though it left the catalog:
    expect(supportsAdaptiveEffort('claude-opus-4-7')).toBe(true);
  });
});
