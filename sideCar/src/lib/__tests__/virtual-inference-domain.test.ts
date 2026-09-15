/** @jest-environment node */
/**
 * `domain` — the two-master contract for ss-rlm-sandbox (see
 * docs/SPEC-ss-rlm-sandbox.md). Each master declares its own retrieval
 * domain ('legal' for Sound Suite, 'code' for the Fantom MCP master);
 * the sidecar must never infer it and must treat "no domain declared" as
 * unconfigured, not as a default to either side.
 */
import {
  setOpenRouterConfig,
  clearOpenRouterConfig,
  getOpenRouterStatus,
  __resetVirtualInferenceForTest,
} from '@/lib/virtual-inference';

const SOUND_SUITE = 'http://sound-suite-master.example:3000';
const FANTOM = 'http://fantom-master.example:3848';

describe('virtual-inference — ss-rlm-sandbox domain declaration', () => {
  beforeEach(() => {
    __resetVirtualInferenceForTest();
  });

  it('a master that never pushed a domain is undeclared, not defaulted', () => {
    expect(getOpenRouterStatus(SOUND_SUITE).domain).toBeUndefined();
  });

  it('stores a valid domain and returns it via getOpenRouterStatus', () => {
    setOpenRouterConfig(SOUND_SUITE, {
      apiKey: 'sk-or-v1-a',
      modeByRole: { 'rlm-sandbox': 'local-first' },
      allowedModels: { 'rlm-sandbox': { model: 'deepseek/deepseek-v4-flash' } },
      domain: 'legal',
    });

    expect(getOpenRouterStatus(SOUND_SUITE).domain).toBe('legal');
  });

  it('two masters on the same sidecar declare different domains independently', () => {
    setOpenRouterConfig(SOUND_SUITE, {
      apiKey: 'sk-or-v1-a',
      allowedModels: { 'rlm-sandbox': { model: 'deepseek/deepseek-v4-flash' } },
      domain: 'legal',
    });
    setOpenRouterConfig(FANTOM, {
      apiKey: 'sk-or-v1-b',
      allowedModels: { 'rlm-sandbox': { model: 'deepseek/deepseek-v4-flash' } },
      domain: 'code',
    });

    expect(getOpenRouterStatus(SOUND_SUITE).domain).toBe('legal');
    expect(getOpenRouterStatus(FANTOM).domain).toBe('code');
  });

  it('rejects an invalid domain value — falls back to undeclared, never a guess', () => {
    setOpenRouterConfig(SOUND_SUITE, {
      apiKey: 'sk-or-v1-a',
      allowedModels: {},
      domain: 'medical', // not in the two-value union
    });

    expect(getOpenRouterStatus(SOUND_SUITE).domain).toBeUndefined();
  });

  it('a push that omits domain keeps the previously declared value (merge, not clear)', () => {
    setOpenRouterConfig(SOUND_SUITE, {
      apiKey: 'sk-or-v1-a',
      allowedModels: { 'rlm-sandbox': { model: 'deepseek/deepseek-v4-flash' } },
      domain: 'legal',
    });
    // Second push updates only modeByRole, as a real re-push after an admin
    // UI edit would — domain field absent entirely.
    setOpenRouterConfig(SOUND_SUITE, {
      modeByRole: { 'rlm-sandbox': 'local-only' },
    });

    expect(getOpenRouterStatus(SOUND_SUITE).domain).toBe('legal');
  });

  it('clearing a master also clears its domain declaration', () => {
    setOpenRouterConfig(SOUND_SUITE, {
      apiKey: 'sk-or-v1-a',
      allowedModels: {},
      domain: 'legal',
    });
    clearOpenRouterConfig(SOUND_SUITE);

    expect(getOpenRouterStatus(SOUND_SUITE).domain).toBeUndefined();
    expect(getOpenRouterStatus(SOUND_SUITE).openrouter).toBe('unset');
  });
});
