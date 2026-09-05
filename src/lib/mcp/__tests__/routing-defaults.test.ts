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
import {
  getDefaultRouting,
  getDefaultRoutingInfo,
  OLLAMA_ONLY_NOTE,
  LOCAL_ROUTING,
  localDecomposeModel,
  localOutlineModel,
  resetOllamaTagsCache,
} from '../routing-defaults';

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

describe('LOCAL_ROUTING.outline (v4 N-3)', () => {
  it('caps the outline at 25 s over 40 items of 400 chars', () => {
    expect(LOCAL_ROUTING.outline).toEqual({
      model: expect.any(String),
      timeoutMs: 25_000,
      maxItems: 40,
      maxCharsPerItem: 400,
    });
    // Must fire before the caller's own outline phase budget (60 s).
    expect(LOCAL_ROUTING.outline.timeoutMs).toBeLessThan(60_000);
  });
});

describe('localOutlineModel', () => {
  const realFetch = global.fetch;
  const withTags = (tags: string[]) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: tags.map((name) => ({ name })) }),
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    resetOllamaTagsCache();
    delete process.env.SS_LOCAL_OUTLINE_MODEL;
    delete process.env.SS_LOCAL_DECOMPOSE_MODEL;
  });
  afterEach(() => {
    global.fetch = realFetch;
    resetOllamaTagsCache();
  });

  const config = { ollamaCompletionHost: 'http://localhost:11434', ollamaCompletionModel: 'local-9b' };

  it('prefers the explicit env override', async () => {
    process.env.SS_LOCAL_OUTLINE_MODEL = 'tiny-instruct:1b';
    await expect(localOutlineModel(config)).resolves.toBe('tiny-instruct:1b');
  });

  it('uses the preferred small tag when the host has it', async () => {
    withTags(['local-9b', LOCAL_ROUTING.outline.model]);
    await expect(localOutlineModel(config)).resolves.toBe(LOCAL_ROUTING.outline.model);
  });

  it('falls back to any small instruct tag on the host', async () => {
    withTags(['local-9b', 'llama3.2:3b']);
    await expect(localOutlineModel(config)).resolves.toBe('llama3.2:3b');
  });

  it('never regresses below the decompose model when nothing small is pulled', async () => {
    withTags(['local-9b']);
    await expect(localOutlineModel(config)).resolves.toBe('local-9b');
  });

  // --- Admin config is the top of the chain (stream D) -----------------------

  it('admin config beats the env override', async () => {
    process.env.SS_LOCAL_OUTLINE_MODEL = 'env-tiny:1b';
    withTags(['local-9b', LOCAL_ROUTING.outline.model]);
    await expect(
      localOutlineModel({ ...config, ollamaOutlineModel: 'admin-picked:2b' }),
    ).resolves.toBe('admin-picked:2b');
  });

  it('admin config is honoured even when the host does not report the tag', async () => {
    withTags(['local-9b']);
    await expect(
      localOutlineModel({ ...config, ollamaOutlineModel: '  admin-picked:2b  ' }),
    ).resolves.toBe('admin-picked:2b');
  });

  it('"Auto" (empty string) falls through to the env override', async () => {
    process.env.SS_LOCAL_OUTLINE_MODEL = 'env-tiny:1b';
    withTags(['local-9b']);
    await expect(localOutlineModel({ ...config, ollamaOutlineModel: '' })).resolves.toBe('env-tiny:1b');
  });

  it('"Auto" with no env falls through to the host scan', async () => {
    withTags(['local-9b', 'llama3.2:3b']);
    await expect(localOutlineModel({ ...config, ollamaOutlineModel: '' })).resolves.toBe('llama3.2:3b');
  });

  it('outline "Auto" inherits the admin-picked decompose model as its floor', async () => {
    withTags(['local-9b']);
    await expect(
      localOutlineModel({ ...config, ollamaOutlineModel: '', ollamaDecomposeModel: 'admin-decompose:4b' }),
    ).resolves.toBe('admin-decompose:4b');
  });

  it('outline and decompose are independent knobs', async () => {
    withTags(['local-9b']);
    const cfg = { ...config, ollamaOutlineModel: 'outline:1b', ollamaDecomposeModel: 'decompose:4b' };
    await expect(localOutlineModel(cfg)).resolves.toBe('outline:1b');
    await expect(localDecomposeModel(cfg)).resolves.toBe('decompose:4b');
  });
});

describe('localDecomposeModel preference order', () => {
  const realFetch = global.fetch;
  const withTags = (tags: string[]) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: tags.map((name) => ({ name })) }),
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    resetOllamaTagsCache();
    delete process.env.SS_LOCAL_DECOMPOSE_MODEL;
  });
  afterEach(() => {
    global.fetch = realFetch;
    resetOllamaTagsCache();
  });

  const config = { ollamaCompletionHost: 'http://localhost:11434', ollamaCompletionModel: 'local-9b' };

  it('config beats env beats host scan', async () => {
    withTags(['local-9b', 'llama3.2:3b']);
    process.env.SS_LOCAL_DECOMPOSE_MODEL = 'env-small:3b';
    await expect(localDecomposeModel({ ...config, ollamaDecomposeModel: 'admin:2b' })).resolves.toBe('admin:2b');
    await expect(localDecomposeModel(config)).resolves.toBe('env-small:3b');
    delete process.env.SS_LOCAL_DECOMPOSE_MODEL;
    await expect(localDecomposeModel(config)).resolves.toBe('llama3.2:3b');
  });

  it('"Auto" (empty string) does not pin anything', async () => {
    withTags(['local-9b']);
    await expect(localDecomposeModel({ ...config, ollamaDecomposeModel: '' })).resolves.toBe('local-9b');
  });
});
