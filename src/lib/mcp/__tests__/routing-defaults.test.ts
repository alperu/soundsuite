/** @jest-environment node */

jest.mock('../../db/config', () => ({ getConfig: jest.fn() }));
jest.mock('../tools/ai-helper', () => ({
  DEFAULT_MODELS: {
    ollama: 'qwen2.5:14b',
    groq: 'llama-3.3-70b-versatile',
    openai: 'gpt-5.6-terra',
    anthropic: 'claude-sonnet-5',
    gemini: 'gemini-3.5-flash',
    grok: 'grok-4.5',
  },
  getAvailableProvider: jest.fn().mockRejectedValue(new Error('none')),
}));

import { getConfig } from '../../db/config';
import { getDefaultRouting, getDefaultRoutingInfo, OLLAMA_ONLY_NOTE } from '../routing-defaults';

const mockedGetConfig = getConfig as jest.MockedFunction<typeof getConfig>;
const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'GROK_API_KEY', 'XAI_API_KEY'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('getDefaultRouting (routed profile, cloud-first)', () => {
  it('primary=ollama with an Anthropic key → fast stays Ollama, deep tiers go to Anthropic', async () => {
    mockedGetConfig.mockResolvedValue({
      aiPrimaryProvider: 'ollama',
      aiPrimaryModel: 'local-9b',
      ollamaHost: 'http://localhost:11434',
      ollamaCompletionModel: 'local-9b',
      claudeApiKey: 'sk-test',
    } as never);

    const info = await getDefaultRoutingInfo();
    expect(info.source).toBe('code:cloud');
    expect(info.notes).toEqual([]);
    expect(info.routing.fast).toEqual({ provider: 'ollama', model: 'local-9b' });
    expect(info.routing.deep).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium' });
    expect(info.routing['deep-report']).toMatchObject({ provider: 'anthropic', multiPass: true });
    expect(info.routing['deep-rlm']).toMatchObject({ provider: 'anthropic', useRlm: true, rlmMaxRounds: 4 });
    expect(await getDefaultRouting()).toEqual(info.routing);
  });

  it('picks cloud providers in order anthropic, openai, gemini, groq, grok', async () => {
    mockedGetConfig.mockResolvedValue({ aiPrimaryProvider: 'ollama', ollamaHost: 'x', groqApiKey: 'g', geminiApiKey: 'gm' } as never);
    const info = await getDefaultRoutingInfo();
    expect(info.routing.deep).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash' });
  });

  it('nothing configured → Ollama on every tier, deep-report single-pass, note attached', async () => {
    mockedGetConfig.mockResolvedValue({ ollamaHost: 'http://localhost:11434', ollamaCompletionModel: 'local-9b' } as never);
    const info = await getDefaultRoutingInfo();
    expect(info.source).toBe('code:ollama-only');
    expect(info.notes).toEqual([OLLAMA_ONLY_NOTE]);
    for (const tier of ['fast', 'deep', 'deep-report', 'deep-rlm'] as const) {
      expect(info.routing[tier].provider).toBe('ollama');
    }
    expect(info.routing['deep-report'].multiPass).toBe(false);
    expect(info.routing['deep-rlm']).toMatchObject({ useRlm: true, rlmMaxRounds: 2 });
  });

  it('no Ollama host either → still a table, with an extra note', async () => {
    mockedGetConfig.mockResolvedValue({} as never);
    const info = await getDefaultRoutingInfo();
    expect(info.source).toBe('code:ollama-only');
    expect(info.notes).toHaveLength(2);
    expect(info.routing.deep).toEqual({ provider: 'ollama' });
  });

  it('primary=anthropic → deep tiers use the primary model', async () => {
    mockedGetConfig.mockResolvedValue({
      aiPrimaryProvider: 'anthropic',
      aiPrimaryModel: 'claude-opus-5',
      claudeApiKey: 'sk-test',
      openaiApiKey: 'sk-o',
    } as never);
    const info = await getDefaultRoutingInfo();
    expect(info.source).toBe('code:cloud');
    expect(info.routing.deep).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', effort: 'medium' });
    expect(info.routing.fast.provider).toBe('ollama');
  });

  it('primary is a cloud provider without a key → falls through to the first configured one', async () => {
    mockedGetConfig.mockResolvedValue({ aiPrimaryProvider: 'anthropic', openaiApiKey: 'sk-o' } as never);
    const info = await getDefaultRoutingInfo();
    expect(info.routing.deep).toMatchObject({ provider: 'openai', model: 'gpt-5.6-terra' });
  });

  it('env keys count as configured', async () => {
    mockedGetConfig.mockResolvedValue({ aiPrimaryProvider: 'ollama', ollamaHost: 'x' } as never);
    process.env.GROQ_API_KEY = 'g';
    const info = await getDefaultRoutingInfo();
    expect(info.routing.deep).toMatchObject({ provider: 'groq' });
    // Groq's catalog model has no thinking knob → no `thinking: true`.
    expect(info.routing.deep.thinking).toBeUndefined();
  });
});
