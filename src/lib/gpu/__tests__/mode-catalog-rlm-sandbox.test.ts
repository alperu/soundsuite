/**
 * ss-rlm-sandbox mode-catalog coverage: it must be a full member of the
 * fixed mode catalog (ALL_MODES / MODE_METADATA / STATIC_FALLBACK_MODEL /
 * settingsPageForMode / resolveModelFromConfig), not a bolt-on that a
 * `Record<ModeName, ...>` map or a switch elsewhere silently drops.
 */

import {
  ALL_MODES,
  MODE_CATALOG,
  isModeName,
  settingsPageForMode,
  resolveModelFromConfig,
  defaultModelFor,
} from '../mode-catalog';

describe('ss-rlm-sandbox — mode catalog membership', () => {
  it('is in ALL_MODES and recognized by isModeName', () => {
    expect(ALL_MODES).toContain('ss-rlm-sandbox');
    expect(isModeName('ss-rlm-sandbox')).toBe(true);
  });

  it('has a MODE_CATALOG entry available on every host OS (no VRAM/GPU requirement)', () => {
    const entry = MODE_CATALOG.find((m) => m.name === 'ss-rlm-sandbox');
    expect(entry).toBeDefined();
    expect(entry!.availableOn.sort()).toEqual(
      ['linux', 'mac-docker-ollama', 'windows-docker-wsl2'].sort(),
    );
  });

  it('has a hardcoded last-resort default model (an OpenRouter chat-model id, not a local weight)', () => {
    // deepseek/deepseek-v4-flash per the operator's verified pick (17
    // providers) — NOT poolside/laguna-s-2.1, which has only one provider.
    expect(defaultModelFor('ss-rlm-sandbox', 'linux')).toBe('deepseek/deepseek-v4-flash');
  });

  it('maps to the OpenRouter settings page and rlm.sandboxModel config key', () => {
    expect(settingsPageForMode('ss-rlm-sandbox')).toEqual({
      label: 'OpenRouter settings',
      href: '/admin/openrouter',
      configKey: 'rlm.sandboxModel',
    });
  });

  it('resolveModelFromConfig reads cfg.rlmSandboxModel, falling back to the static default when unset', () => {
    expect(resolveModelFromConfig('ss-rlm-sandbox', { rlmSandboxModel: 'x/y-model' })).toBe('x/y-model');
    expect(resolveModelFromConfig('ss-rlm-sandbox', {})).toBe('deepseek/deepseek-v4-flash');
  });

  it('does not disturb the pre-existing ss-rlm entry', () => {
    expect(defaultModelFor('ss-rlm', 'linux')).toBe('mit-oasys/rlm-qwen3-8b-v0.1');
    expect(settingsPageForMode('ss-rlm')).toEqual({
      label: 'RLM AI settings',
      href: '/admin/rlm',
      configKey: 'rlm.model',
    });
  });
});
