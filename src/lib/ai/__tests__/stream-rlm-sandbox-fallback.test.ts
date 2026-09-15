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

  it('resolves ss-rlm directly when running, without consulting sandbox config at all', async () => {
    mockGetFleetStatus.mockResolvedValue({
      sidecars: [
        sidecar({
          sidecarStatus: { containers: { rlm: { status: 'running', image: 'vllm/vllm-openai:v0.21.0' } } },
        }),
      ],
    });

    const resolved = await resolveRlmEndpoint();

    expect(resolved).toEqual({ endpoint: 'http://sidecar-a:8100', host: 'sidecar-a', contextTokens: RLM_CONTEXT_TOKENS });
    expect(mockGetConfig).not.toHaveBeenCalled();
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

    expect(resolved).toEqual({ endpoint: 'http://sidecar-a:8100', host: 'sidecar-a', contextTokens: RLM_CONTEXT_TOKENS });
    expect(mockGetConfig).not.toHaveBeenCalled();
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
