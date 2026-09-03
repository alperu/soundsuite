/** @jest-environment node */

jest.mock('../../../db/config', () => ({ getConfig: jest.fn() }));

import { getConfig } from '../../../db/config';
import { readPreset, upgradePresetV1, validatePreset, validatePresetShape } from '../preset-schema';

const mockedConfig = getConfig as jest.MockedFunction<typeof getConfig>;

function configured(overrides: Record<string, unknown> = {}) {
  mockedConfig.mockResolvedValue({
    embeddingProvider: 'transformers',
    embeddingModel: 'x',
    ollamaHost: 'http://127.0.0.1:11434',
    claudeApiKey: 'sk-synthetic',
    ...overrides,
  } as never);
}

/** A dashboard v1 blob, as search-interface.tsx writes it (synthetic values). */
const V1_BLOB = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  auto: true,
  deep: true,
  rlm: false,
  compare: false,
  thinking: true,
  multiPass: false,
  maxTokens: 8192,
  effort: 'high',
  includeCaseScope: true,
  caseId: 'case-synthetic-1',
  compareSelections: [['a', 'b']],
};

describe('upgradePresetV1', () => {
  it('maps the dashboard v1 fields to PresetV2 and derives a routing table', () => {
    const v2 = upgradePresetV1('My Preset', V1_BLOB);
    expect(v2.version).toBe(2);
    expect(v2.name).toBe('My Preset');
    expect(v2.provider).toBe('anthropic');
    expect(v2.model).toBe('claude-sonnet-5');
    expect(v2.deep).toBe(true);
    expect(v2.rlm).toBe(false);
    expect(v2.multiPass).toBe(false);
    expect(v2.thinking).toBe(true);
    expect(v2.effort).toBe('high');
    expect(v2.maxTokens).toBe(8192);
    expect(v2.includeCaseScope).toBe(true);
    expect(v2.caseId).toBe('case-synthetic-1');
    // unknown scalars preserved, non-scalars dropped
    expect((v2 as unknown as Record<string, unknown>).auto).toBe(true);
    expect((v2 as unknown as Record<string, unknown>).compare).toBe(false);
    expect((v2 as unknown as Record<string, unknown>).compareSelections).toBeUndefined();
    // derived routing for the cloud tiers only
    expect(v2.routing?.fast).toBeUndefined();
    expect(v2.routing?.deep).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high', thinking: true, maxTokens: 8192 });
    expect(v2.routing?.['deep-report']?.multiPass).toBe(false);
    expect(v2.routing?.['deep-rlm']?.useRlm).toBe(true);
  });

  it('survives a garbage blob', () => {
    const v2 = upgradePresetV1('x', null);
    expect(v2).toEqual({ version: 2, name: 'x' });
  });
});

describe('validatePresetShape', () => {
  it('rejects an unknown tier', () => {
    const r = validatePresetShape({ version: 2, name: 'p', routing: { turbo: { provider: 'ollama' } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/routing\.turbo: unknown tier/);
  });

  it('rejects a model outside the provider catalog and a bad effort', () => {
    const r = validatePresetShape({
      version: 2, name: 'p',
      routing: { deep: { provider: 'anthropic', model: 'claude-made-up', effort: 'ultra' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('not in the anthropic catalog'))).toBe(true);
      expect(r.errors.some((e) => e.includes('routing.deep.effort'))).toBe(true);
    }
  });

  it('accepts free-form ollama models and warns on unknown tier keys', () => {
    const r = validatePresetShape({
      version: 2, name: 'p',
      routing: { fast: { provider: 'ollama', model: 'anything:7b', temperature: 0.2 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preset.routing?.fast).toEqual({ provider: 'ollama', model: 'anything:7b' });
      expect(r.warnings[0]).toMatch(/routing\.fast\.temperature/);
    }
  });

  it('rejects version !== 2 and non-positive numbers', () => {
    const r = validatePresetShape({ version: 1, name: 'p', maxTokens: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBe(2);
  });
});

describe('validatePreset (configured providers)', () => {
  beforeEach(() => mockedConfig.mockReset());

  it('rejects a routing entry whose provider has no key configured', async () => {
    configured({ claudeApiKey: undefined });
    const r = await validatePreset({ version: 2, name: 'p', routing: { deep: { provider: 'anthropic' } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/routing\.deep\.provider: provider "anthropic" is not configured/);
  });

  it('accepts when the key is present in config', async () => {
    configured();
    const r = await validatePreset({ version: 2, name: 'p', routing: { deep: { provider: 'anthropic', model: 'claude-sonnet-5' } } });
    expect(r.ok).toBe(true);
  });

  it('accepts when the key is present in the environment', async () => {
    configured({ claudeApiKey: undefined, groqApiKey: undefined });
    const prev = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = 'gsk-synthetic';
    try {
      const r = await validatePreset({ version: 2, name: 'p', routing: { fast: { provider: 'groq' } } });
      expect(r.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prev;
    }
  });

  it('rejects ollama when no host is set', async () => {
    configured({ ollamaHost: undefined, ollamaCompletionHost: undefined });
    const prev = process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_HOST;
    try {
      const r = await validatePreset({ version: 2, name: 'p', routing: { fast: { provider: 'ollama' } } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/ollama.*no host/);
    } finally {
      if (prev !== undefined) process.env.OLLAMA_HOST = prev;
    }
  });
});

describe('readPreset', () => {
  it('passes a v2 blob through and upgrades a v1 blob', () => {
    const v2 = readPreset({ id: 'r1', name: 'row-name', settings: { version: 2, name: 'inner', routing: { fast: { provider: 'ollama' } } } });
    expect(v2.name).toBe('inner');
    expect(v2.routing?.fast?.provider).toBe('ollama');

    const up = readPreset({ id: 'r2', name: 'legacy', version: 1, settings: V1_BLOB });
    expect(up.version).toBe(2);
    expect(up.name).toBe('legacy');
    expect(up.routing?.deep?.provider).toBe('anthropic');
  });

  it('throws on a malformed v2 blob', () => {
    expect(() => readPreset({ id: 'r3', name: 'bad', settings: { version: 2, name: 'bad', routing: { deep: { provider: 'nope' } } } }))
      .toThrow(/malformed/);
  });
});
