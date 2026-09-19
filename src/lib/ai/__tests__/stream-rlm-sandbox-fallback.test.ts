/**
 * Tests for resolveRlmEndpoint()'s ss-rlm-sandbox fallback (Phase 2 — see
 * stream-rlm.ts header comment above RLM_SANDBOX_PORT).
 *
 * ss-rlm-sandbox runs the RLM *pattern* against a hosted OpenRouter chat
 * model instead of self-hosting mit-oasys/rlm-qwen3-8b-v0.1. The master
 * should fall back to it only when:
 *   1. no sidecar has ss-rlm running, AND
 *   2. the operator opted in via virtualInference.mode.rlm !== 'local-only'
 *      (default stays local-only — an unconfigured install must fail exactly
 *      as before this fallback existed, not silently serve a different
 *      model), AND
 *   3. a Config value for rlm.sandboxModel exists, AND
 *   4. some connected sidecar actually has rlm-sandbox running.
 *
 * No live network calls — every sidecar's rlm container status is set to
 * something OTHER than the "transitional" set (not_found/created/starting/
 * restarting) so resolveRlmEndpoint() never enters its live-probe/fetch
 * fallback paths.
 */

jest.mock('@/lib/gpu/fleet-router', () => ({
  getFleetStatus: jest.fn(),
}));
jest.mock('@/lib/db/config', () => ({
  getConfig: jest.fn(),
}));

import { getFleetStatus } from '@/lib/gpu/fleet-router';
import { getConfig } from '@/lib/db/config';
import { resolveRlmEndpoint, RLM_CONTEXT_TOKENS } from '../stream-rlm';

const mockGetFleetStatus = getFleetStatus as jest.Mock;
const mockGetConfig = getConfig as jest.Mock;

function sidecar(overrides: Record<string, unknown> = {}) {
  return {
    url: 'http://sidecar-a:8098',
    hostname: 'sidecar-a',
    status: 'connected',
    sidecarStatus: { containers: { rlm: { status: 'exited' } } },
    ...overrides,
  };
}

describe('resolveRlmEndpoint — ss-rlm-sandbox fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves ss-rlm directly when running, whatever the sandbox model says', async () => {
    // This used to assert getConfig() was never called. That stopped being
    // true when 'cloud-only' landed: the mode has to be read BEFORE ss-rlm
    // discovery, because its entire purpose is to skip that discovery. The
    // property worth pinning was never "no config read" — it is that in
    // local-only/local-first a running ss-rlm wins regardless of what the
    // sandbox is configured with. That is what this asserts now.
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          sidecarStatus: { containers: { rlm: { status: 'running', image: 'vllm/vllm-openai:v0.21.0' } } },
        }),
      ],
    });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'local-first',
      rlmSandboxModel: 'deepseek/deepseek-v4.1-flash',
    });

    const resolved = await resolveRlmEndpoint();

    expect(resolved).toEqual({ endpoint: 'http://sidecar-a:8100', host: 'sidecar-a', contextTokens: RLM_CONTEXT_TOKENS });
  });

  it('still resolves ss-rlm when the config read throws — a config failure must not disable RLM', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          sidecarStatus: { containers: { rlm: { status: 'running', image: 'vllm/vllm-openai:v0.21.0' } } },
        }),
      ],
    });
    mockGetConfig.mockRejectedValue(new Error('db unavailable'));

    const resolved = await resolveRlmEndpoint();
    expect(resolved?.endpoint).toBe('http://sidecar-a:8100');
  });

  it('returns null — no fallback — when ss-rlm is absent and virtualInference.mode.rlm is local-only (default)', async () => {
    mockGetFleetStatus.mockResolvedValue({ sidecars: [sidecar()] });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'local-only',
      rlmSandboxModel: 'deepseek/deepseek-v4-flash',
    });

    const resolved = await resolveRlmEndpoint();

    expect(resolved).toBeNull();
  });

  it('returns null when local-first is set but no rlm.sandboxModel is configured', async () => {
    mockGetFleetStatus.mockResolvedValue({ sidecars: [sidecar()] });
    mockGetConfig.mockResolvedValue({ virtualInferenceModeRlm: 'local-first', rlmSandboxModel: undefined });

    const resolved = await resolveRlmEndpoint();

    expect(resolved).toBeNull();
  });

  it('returns null when local-first + a model are set but no sidecar has rlm-sandbox running', async () => {
    mockGetFleetStatus.mockResolvedValue({ sidecars: [sidecar()] });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'local-first',
      rlmSandboxModel: 'deepseek/deepseek-v4-flash',
    });

    const resolved = await resolveRlmEndpoint();

    expect(resolved).toBeNull();
  });

  it('falls back to ss-rlm-sandbox when ss-rlm is unavailable, the operator opted in, and a sidecar has it running', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          sidecarStatus: { containers: { rlm: { status: 'exited' }, 'rlm-sandbox': { status: 'running' } } },
        }),
      ],
    });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'local-first',
      rlmSandboxModel: 'deepseek/deepseek-v4-flash',
    });

    const resolved = await resolveRlmEndpoint();

    expect(resolved).toEqual({
      endpoint: 'http://sidecar-a:8101',
      host: 'sidecar-a',
      sandbox: true,
      model: 'deepseek/deepseek-v4-flash',
      // The hosted model's own window (1_048_576 × HOSTED_CONTEXT_UTILIZATION),
      // not ss-rlm's 40960 vLLM ceiling. Written as a literal rather than
      // recomputed, so changing either input has to be deliberate.
      contextTokens: 943_718,
    });
    expect(resolved!.contextTokens).toBeGreaterThan(RLM_CONTEXT_TOKENS);
  });

  it('prefers ss-rlm over the sandbox when both are available', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          sidecarStatus: {
            containers: {
              rlm: { status: 'running', image: 'vllm/vllm-openai:v0.21.0' },
              'rlm-sandbox': { status: 'running' },
            },
          },
        }),
      ],
    });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'local-first',
      rlmSandboxModel: 'deepseek/deepseek-v4-flash',
    });

    const resolved = await resolveRlmEndpoint();

    // 8100, not 8101 — in local-first the self-hosted role wins. The mode IS
    // read first now (cloud-only needs it before discovery), so this no longer
    // asserts getConfig went uncalled; it asserts the outcome, which is the
    // part that matters. The cloud-only suite below covers the inverse.
    expect(resolved).toEqual({ endpoint: 'http://sidecar-a:8100', host: 'sidecar-a', contextTokens: RLM_CONTEXT_TOKENS });
  });

  it('skips a disconnected sidecar for the sandbox fallback', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          url: 'http://sidecar-b:8098',
          hostname: 'sidecar-b',
          status: 'disconnected',
          sidecarStatus: { containers: { 'rlm-sandbox': { status: 'running' } } },
        }),
      ],
    });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'local-first',
      rlmSandboxModel: 'deepseek/deepseek-v4-flash',
    });

    const resolved = await resolveRlmEndpoint();

    expect(resolved).toBeNull();
  });
});

/**
 * `cloud-only` — the sandbox IS the RLM, not a fallback.
 *
 * Added because probing for an ss-rlm that is deliberately not deployed costs
 * a live HTTP probe per transitional sidecar on every single call, and then
 * logs DEGRADED for what is actually the chosen configuration. Logging
 * DEGRADED for a deliberate setting trains people to ignore the word.
 */
describe('resolveRlmEndpoint — virtualInference.mode.rlm=cloud-only', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the sandbox even when ss-rlm IS running — never probes for it', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          sidecarStatus: {
            containers: {
              rlm: { status: 'running', image: 'vllm/vllm-openai:v0.21.0' },
              'rlm-sandbox': { status: 'running' },
            },
          },
        }),
      ],
    });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'cloud-only',
      rlmSandboxModel: 'deepseek/deepseek-v4.1-flash',
    });

    const resolved = await resolveRlmEndpoint();

    // 8101, not 8100 — the self-hosted role was available and deliberately ignored.
    expect(resolved?.endpoint).toBe('http://sidecar-a:8101');
    expect(resolved?.sandbox).toBe(true);
    expect(resolved?.model).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('returns null when no sandbox is running — there is nothing to fall back to', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          sidecarStatus: { containers: { rlm: { status: 'running' }, 'rlm-sandbox': { status: 'exited' } } },
        }),
      ],
    });
    mockGetConfig.mockResolvedValue({
      virtualInferenceModeRlm: 'cloud-only',
      rlmSandboxModel: 'deepseek/deepseek-v4.1-flash',
    });

    // Deliberate: cloud-only means "do not use ss-rlm". Quietly serving the
    // self-hosted model here would ignore an explicit operator instruction.
    expect(await resolveRlmEndpoint()).toBeNull();
  });

  it('returns null when cloud-only is set but no sandbox model is configured', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [sidecar({ sidecarStatus: { containers: { 'rlm-sandbox': { status: 'running' } } } })],
    });
    mockGetConfig.mockResolvedValue({ virtualInferenceModeRlm: 'cloud-only', rlmSandboxModel: '' });

    expect(await resolveRlmEndpoint()).toBeNull();
  });
});

/**
 * `excludeHosts` — the failover contract used by streamRlm / runRlmWithTools.
 *
 * A sidecar's cached container status is a heartbeat ~5s stale, so a host can
 * report rlm-sandbox=running while its :8101 is mid-restart. A cloud-only run
 * picked exactly such a host, got `fetch failed`, and skipped RLM for the
 * whole report — while three other sandboxes in the fleet were healthy. The
 * caller now excludes the failed host and re-resolves. These pin that a
 * resolve honours the exclusion at every discovery phase.
 *
 * Still no network: these exercise resolution only. The fetch-level failover
 * itself is covered in stream-rlm-failover.test.ts, which mocks global.fetch
 * and therefore lives on its own.
 */
describe('resolveRlmEndpoint — excludeHosts (failover contract)', () => {
  beforeEach(() => jest.clearAllMocks());

  const sandboxOn = (name: string) =>
    sidecar({
      url: `http://${name}:8098`,
      hostname: name,
      sidecarStatus: { containers: { rlm: { status: 'exited' }, 'rlm-sandbox': { status: 'running' } } },
    });
  const rlmOn = (name: string) =>
    sidecar({
      url: `http://${name}:8098`,
      hostname: name,
      sidecarStatus: { containers: { rlm: { status: 'running', image: 'vllm/vllm-openai:v0.21.0' } } },
    });

  it('cloud-only: an excluded sandbox host is passed over even though its cache still says running', async () => {
    mockGetFleetStatus.mockResolvedValue({ sidecars: [sandboxOn('sidecar-a'), sandboxOn('sidecar-b')] });
    mockGetConfig.mockResolvedValue({ virtualInferenceModeRlm: 'cloud-only', rlmSandboxModel: 'deepseek/deepseek-v4-flash' });

    // Without exclusion the first host wins — the pre-fix behaviour, unchanged.
    expect((await resolveRlmEndpoint())?.host).toBe('sidecar-a');

    const r = await resolveRlmEndpoint({ excludeHosts: ['sidecar-a'] });
    expect(r?.endpoint).toBe('http://sidecar-b:8101');
    expect(r?.sandbox).toBe(true);
  });

  it('returns null once every sandbox host is excluded — the caller must stop, not spin', async () => {
    mockGetFleetStatus.mockResolvedValue({ sidecars: [sandboxOn('sidecar-a'), sandboxOn('sidecar-b')] });
    mockGetConfig.mockResolvedValue({ virtualInferenceModeRlm: 'cloud-only', rlmSandboxModel: 'deepseek/deepseek-v4-flash' });

    expect(await resolveRlmEndpoint({ excludeHosts: ['sidecar-a', 'sidecar-b'] })).toBeNull();
  });

  it('local-first: an excluded ss-rlm host is skipped in Phase 1 and does not seed the live-probe list', async () => {
    mockGetFleetStatus.mockResolvedValue({ sidecars: [rlmOn('sidecar-a'), rlmOn('sidecar-b')] });
    mockGetConfig.mockResolvedValue({ virtualInferenceModeRlm: 'local-first', rlmSandboxModel: 'deepseek/deepseek-v4-flash' });

    const r = await resolveRlmEndpoint({ excludeHosts: ['sidecar-a'] });
    expect(r).toEqual({ endpoint: 'http://sidecar-b:8100', host: 'sidecar-b', contextTokens: RLM_CONTEXT_TOKENS });
  });

  it('local-first: excluding the only ss-rlm host falls through to a sandbox on another host', async () => {
    mockGetFleetStatus.mockResolvedValue({ sidecars: [rlmOn('sidecar-a'), sandboxOn('sidecar-b')] });
    mockGetConfig.mockResolvedValue({ virtualInferenceModeRlm: 'local-first', rlmSandboxModel: 'deepseek/deepseek-v4-flash' });

    const r = await resolveRlmEndpoint({ excludeHosts: ['sidecar-a'] });
    expect(r?.endpoint).toBe('http://sidecar-b:8101');
    expect(r?.sandbox).toBe(true);
  });
});
