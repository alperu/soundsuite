/** @jest-environment node */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn() }));
jest.mock('../../tools/ai-helper', () => ({
  DEFAULT_MODELS: {
    ollama: 'qwen2.5:14b',
    groq: 'llama-3.3-70b-versatile',
    openai: 'gpt-5.6-terra',
    anthropic: 'claude-sonnet-5',
    gemini: 'gemini-3.5-flash',
    grok: 'grok-4.5',
  },
  getAvailableProvider: jest.fn(),
}));

import {
  classifyTier,
  estimateCostClass,
  estimateSeconds,
  resolveTierSettings,
  wouldPromoteToJob,
} from '../routing';
import type { PresetV2, ResearchTier, TierSettings } from '../../research-types';

const DEFAULTS: Record<ResearchTier, TierSettings> = {
  fast: { provider: 'ollama', model: 'qwen2.5:14b' },
  deep: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true },
  'deep-report': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true, multiPass: true },
  'deep-rlm': { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', thinking: true, useRlm: true, rlmMaxRounds: 4 },
};

describe('classifyTier', () => {
  it('honours an explicit non-auto mode', () => {
    expect(classifyTier('anything', 'deep-rlm')).toEqual({ tier: 'deep-rlm', reason: 'explicit', confidence: 1 });
  });

  it('routes a report request to deep-report under auto', () => {
    const d = classifyTier('write a memo summarising the discovery disputes', 'auto');
    expect(d.tier).toBe('deep-report');
    expect(d.confidence).toBeGreaterThan(0);
  });

  it('rejects an unknown mode', () => {
    expect(() => classifyTier('q', 'turbo' as never)).toThrow(/mode must be one of/);
  });
});

describe('resolveTierSettings precedence', () => {
  const active: PresetV2 = {
    version: 2, name: 'active',
    routing: { deep: { provider: 'anthropic', model: 'claude-opus-5', effort: 'high' } },
  };
  const inline: PresetV2 = {
    version: 2, name: 'inline',
    routing: { deep: { effort: 'low' } as TierSettings },
  };

  it('layers overrides > inline > active > defaults field-wise', () => {
    const r = resolveTierSettings('deep', {
      activePreset: active,
      inlinePreset: inline,
      overrides: { maxTokens: 4096 },
      defaults: DEFAULTS,
    });
    expect(r.resolved).toEqual({
      provider: 'anthropic',       // active (defaults agree)
      model: 'claude-opus-5',      // active
      effort: 'low',               // inline beats active
      thinking: true,              // defaults — nothing above set it
      maxTokens: 4096,             // override
    });
    expect(r.presetUsed).toBe('inline');
    expect(r.clamps).toEqual([]);
  });

  it('falls through to defaults when presets have no entry for the tier', () => {
    const r = resolveTierSettings('fast', { activePreset: active, inlinePreset: inline, defaults: DEFAULTS });
    expect(r.resolved).toEqual({ provider: 'ollama', model: 'qwen2.5:14b' });
    expect(r.presetUsed).toBeUndefined();
  });

  it('a provider change without a model discards the inherited model', () => {
    const r = resolveTierSettings('deep', { overrides: { provider: 'openai' }, defaults: DEFAULTS });
    expect(r.resolved.provider).toBe('openai');
    expect(r.resolved.model).toBe('gpt-5.6-terra');
  });
});

describe('resolveTierSettings capability clamps', () => {
  it('clamps effort to the nearest level the model supports', () => {
    // grok-4.5 supports low/medium/high only
    const r = resolveTierSettings('deep', {
      overrides: { provider: 'grok', model: 'grok-4.5', effort: 'max' },
      defaults: DEFAULTS,
    });
    expect(r.resolved.effort).toBe('high');
    expect(r.clamps.some((c) => c.startsWith('effort max → high'))).toBe(true);
  });

  it('drops effort when the model has no effort control', () => {
    // claude-sonnet-4-6 has classic caps (effort: null)
    const r = resolveTierSettings('deep', {
      overrides: { model: 'claude-sonnet-4-6', effort: 'high' },
      defaults: DEFAULTS,
    });
    expect(r.resolved.effort).toBeUndefined();
    expect(r.clamps.some((c) => c.includes('effort high dropped'))).toBe(true);
  });

  it('drops thinking when unsupported and caps maxTokens', () => {
    // gpt-5.6-terra: thinking false, maxTokensCap 128000
    const r = resolveTierSettings('deep', {
      overrides: { provider: 'openai', model: 'gpt-5.6-terra', thinking: true, maxTokens: 999999, effort: 'medium' },
      defaults: DEFAULTS,
    });
    expect(r.resolved.thinking).toBeUndefined();
    expect(r.resolved.maxTokens).toBe(128000);
    expect(r.resolved.effort).toBe('medium');
    expect(r.clamps).toEqual(expect.arrayContaining([
      expect.stringContaining('thinking dropped'),
      expect.stringContaining('maxTokens 999999 → 128000'),
    ]));
  });

  it('ollama fast tier passes through untouched', () => {
    const r = resolveTierSettings('fast', { defaults: DEFAULTS });
    expect(r.resolved).toEqual({ provider: 'ollama', model: 'qwen2.5:14b' });
    expect(r.clamps).toEqual([]);
  });

  it('replaces a model that is not in the provider catalog', () => {
    const r = resolveTierSettings('deep', { overrides: { model: 'claude-made-up' }, defaults: DEFAULTS });
    expect(r.resolved.model).toBe('claude-sonnet-5');
    expect(r.clamps[0]).toMatch(/not in the anthropic catalog/);
  });

  it('throws when nothing resolves a provider', () => {
    expect(() => resolveTierSettings('deep', { defaults: { ...DEFAULTS, deep: { provider: '' } } })).toThrow(/no provider resolved/);
  });
});

describe('cost hints', () => {
  it('classifies and estimates', () => {
    expect(estimateCostClass('fast', DEFAULTS.fast)).toBe('gpu-only');
    expect(estimateCostClass('fast', { provider: 'anthropic' })).toBe('low');
    expect(estimateCostClass('deep', DEFAULTS.deep)).toBe('medium');
    expect(estimateCostClass('deep', { ...DEFAULTS.deep, effort: 'max' })).toBe('high');
    expect(estimateCostClass('deep-report', DEFAULTS['deep-report'])).toBe('high');

    expect(estimateSeconds('fast', DEFAULTS.fast)).toBe(10);
    expect(estimateSeconds('deep', DEFAULTS.deep)).toBe(40);
    expect(estimateSeconds('deep', { ...DEFAULTS.deep, multiPass: true })).toBe(90);
    expect(estimateSeconds('deep-rlm', DEFAULTS['deep-rlm'])).toBe(75);

    expect(wouldPromoteToJob('deep', DEFAULTS.deep)).toBe(false);
    expect(wouldPromoteToJob('deep-report', DEFAULTS['deep-report'])).toBe(true);
  });
});
