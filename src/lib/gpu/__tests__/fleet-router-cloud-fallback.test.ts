/**
 * @jest-environment node
 *
 * POLICY 2 — "if local GPU is not available, use OpenRouter."
 *
 * `resolveEndpoint('completion')` must fall through to Phase 4 — an ordered
 * `CloudProvider` list (docs/SPEC-openrouter-virtual-inference.md §9.2) —
 * ONLY when the operator has opted the role out of `local-only`
 * (`virtualInferenceModeCompletion`). With no sidecars registered at all,
 * Phases 1-3 have nothing to try, so Phase 4 (or the final throw) decides
 * the outcome.
 *
 * Synthetic fixtures only (CLAUDE.md § Privacy).
 */

const mockGetConfig = jest.fn();
const mockAssertSpendAllowed = jest.fn();

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

jest.mock('@/lib/db/config', () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  setConfigValue: jest.fn(),
}));

jest.mock('@/lib/gpu/status-cache', () => ({
  getSidecarStatus: () => undefined,
  getAllSidecarStatuses: () => [],
  isSidecarConnected: () => false,
  updateSidecarStatus: jest.fn(),
  markSidecarDisconnected: jest.fn(),
  updateRoleLoad: jest.fn(),
}));

jest.mock('@/lib/gpu/ws-relay', () => ({
  hasSidecarConnection: () => false,
  getConnectedSidecars: () => [],
  sendCommand: jest.fn(),
}));

jest.mock('@/lib/db/role-registry', () => ({
  getEnabledModesForHost: jest.fn(async () => []),
  getModelOverridesForHost: jest.fn(async () => ({})),
  getEffectiveMinOnline: jest.fn(async () => ({})),
  getEffectiveIdleTimeoutsMs: jest.fn(async () => ({})),
  getRuntimesForHost: jest.fn(async () => ({})),
  listAllAssignments: jest.fn(async () => []),
}));
jest.mock('@/lib/db/role-registry-seed', () => ({ seedAssignmentsForHost: jest.fn() }));
jest.mock('@/lib/db/host-provisioning', () => ({ getProvisioning: jest.fn(async () => ({})) }));

jest.mock('@/lib/openrouter/client', () => ({
  assertSpendAllowed: (...a: unknown[]) => mockAssertSpendAllowed(...a),
}));

const BASE_CONFIG = {
  gpuSidecars: JSON.stringify([]), // no sidecars registered — Phases 1-3 have nothing to try
  openRouterEnabled: true,
  openRouterChatModel: 'deepseek/deepseek-v4-flash',
  virtualInferenceModeCompletion: 'local-only' as const,
};

async function loadResolveEndpoint() {
  jest.resetModules();
  return (await import('@/lib/gpu/fleet-router')).resolveEndpoint;
}

describe('resolveEndpoint Phase 4 — cloud fallback (Policy 2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertSpendAllowed.mockResolvedValue(undefined);
  });

  it('throws (today’s behaviour, unchanged) when the role stays local-only', async () => {
    mockGetConfig.mockResolvedValue({ ...BASE_CONFIG, virtualInferenceModeCompletion: 'local-only' });
    const resolveEndpoint = await loadResolveEndpoint();
    await expect(resolveEndpoint('completion' as never)).rejects.toThrow(/No sidecar available/);
  });

  it('falls back to OpenRouter when mode is local-first and no local GPU is available', async () => {
    mockGetConfig.mockResolvedValue({ ...BASE_CONFIG, virtualInferenceModeCompletion: 'local-first' });
    const resolveEndpoint = await loadResolveEndpoint();
    const ep = await resolveEndpoint('completion' as never);

    expect(ep.source).toBe('cloud');
    expect(ep.cloudProviderId).toBe('openrouter');
    expect(ep.cloudModel).toBe('deepseek/deepseek-v4-flash');
    expect(mockAssertSpendAllowed).toHaveBeenCalledWith('completion');
  });

  it('does not engage Phase 4 for a role with no wired cloud mode (e.g. embedding)', async () => {
    mockGetConfig.mockResolvedValue({ ...BASE_CONFIG, virtualInferenceModeCompletion: 'cloud-only' });
    const resolveEndpoint = await loadResolveEndpoint();
    // 'embedding' is not wired to any virtualInference mode in fleet-router's
    // Phase 4 gate (embedding has its own AllSourcesEmbeddingProvider story) —
    // it must still throw, never silently route to OpenRouter.
    await expect(resolveEndpoint('embedding' as never)).rejects.toThrow(/No sidecar available/);
  });

  it('falls through to the ordinary throw when OpenRouter is not enabled, even in local-first', async () => {
    mockGetConfig.mockResolvedValue({
      ...BASE_CONFIG,
      virtualInferenceModeCompletion: 'local-first',
      openRouterEnabled: false,
    });
    const resolveEndpoint = await loadResolveEndpoint();
    await expect(resolveEndpoint('completion' as never)).rejects.toThrow(/No sidecar available/);
    expect(mockAssertSpendAllowed).not.toHaveBeenCalled();
  });

  it('falls through to the ordinary throw when the daily spend cap / circuit breaker has tripped', async () => {
    mockGetConfig.mockResolvedValue({ ...BASE_CONFIG, virtualInferenceModeCompletion: 'local-first' });
    mockAssertSpendAllowed.mockRejectedValue(new Error('daily cap reached'));
    const resolveEndpoint = await loadResolveEndpoint();
    await expect(resolveEndpoint('completion' as never)).rejects.toThrow(/No sidecar available/);
  });
});
