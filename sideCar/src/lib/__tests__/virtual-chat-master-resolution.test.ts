/**
 * Which master's key a sandbox sub-model call spends.
 *
 * Every other virtual-* action arrives over a specific master's WebSocket and
 * gets `m.serverUrl` for free. The sandbox calls in over HTTP with no such
 * context — and `apiKey`, `allowedModels` and the spend are per-master by
 * design, precisely so Sound Suite and Fantom cannot charge each other.
 *
 * The tempting shortcut is "use the first configured master". These tests exist
 * to stop that: picking the first silently spends one master's budget on the
 * other's model, and nothing downstream would ever reveal it. Refusing with 409
 * is what forces the caller-identity header to be built when Fantom's half of
 * the contract lands.
 */

import { setOpenRouterConfig, clearOpenRouterConfig, resolveSandboxMaster, sandboxModelFor } from '../virtual-inference';

const SS = 'http://192.0.2.10:3000';
const FANTOM = 'http://192.0.2.10:3848';

function push(serverUrl: string, apiKey: string | undefined, model?: string) {
  setOpenRouterConfig(serverUrl, {
    ...(apiKey ? { apiKey } : {}),
    allowedModels: model ? { 'rlm-sandbox': { model } } : {},
    modeByRole: { 'rlm-sandbox': 'local-first' },
  });
}

beforeEach(() => {
  clearOpenRouterConfig(SS);
  clearOpenRouterConfig(FANTOM);
});

describe('resolveSandboxMaster', () => {
  it('refuses when no master has pushed a key', () => {
    const r = resolveSandboxMaster();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it('resolves the single configured master', () => {
    push(SS, 'sk-test', 'deepseek/deepseek-v4-flash');
    const r = resolveSandboxMaster();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.serverUrl).toBe(SS);
      expect(sandboxModelFor(r.config, 'rlm-sandbox')).toBe('deepseek/deepseek-v4-flash');
    }
  });

  it('REFUSES with 409 when two masters have keys — never picks one', () => {
    push(SS, 'sk-soundsuite', 'deepseek/deepseek-v4-flash');
    push(FANTOM, 'sk-fantom', 'some/other-model');
    const r = resolveSandboxMaster();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      // The error has to name both, or an operator cannot act on it.
      expect(r.error).toContain(SS);
      expect(r.error).toContain(FANTOM);
      expect(r.error).toMatch(/X-SoundSuite-Master/i);
    }
  });

  it('an explicit master disambiguates', () => {
    push(SS, 'sk-soundsuite', 'deepseek/deepseek-v4-flash');
    push(FANTOM, 'sk-fantom', 'some/other-model');
    const r = resolveSandboxMaster(FANTOM);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.serverUrl).toBe(FANTOM);
      expect(sandboxModelFor(r.config, 'rlm-sandbox')).toBe('some/other-model');
    }
  });

  it('a master with models but no key does not count as configured', () => {
    // setOpenRouterConfig stores models/modes even with no key (see its doc);
    // such a master cannot serve a call and must not create false ambiguity.
    push(SS, 'sk-soundsuite', 'deepseek/deepseek-v4-flash');
    push(FANTOM, undefined, 'some/other-model');
    const r = resolveSandboxMaster();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.serverUrl).toBe(SS);
  });

  it('404s for an explicit master that pushed nothing', () => {
    push(SS, 'sk-soundsuite', 'deepseek/deepseek-v4-flash');
    const r = resolveSandboxMaster('http://192.0.2.99:3000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });
});

describe('sandboxModelFor', () => {
  it('is undefined when the master configured no model for the role', () => {
    push(SS, 'sk-test');
    const r = resolveSandboxMaster();
    expect(r.ok).toBe(true);
    // This is the live state observed 2026-09-15: a key present, the sandbox
    // model blank. The route must 503 with a pointer to /admin/openrouter
    // rather than call OpenRouter with an empty model id.
    if (r.ok) expect(sandboxModelFor(r.config, 'rlm-sandbox')).toBeUndefined();
  });

  it('treats a whitespace-only model as unset', () => {
    push(SS, 'sk-test', '   ');
    const r = resolveSandboxMaster();
    if (r.ok) expect(sandboxModelFor(r.config, 'rlm-sandbox')).toBeUndefined();
  });
});
