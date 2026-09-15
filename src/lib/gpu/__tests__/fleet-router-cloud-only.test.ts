/**
 * @jest-environment node
 *
 * `cloud-only` must go straight to the cloud, and must not touch anything else.
 *
 * Before Phase 0, the only mode gate in resolveEndpoint tested for
 * `local-only` and treated every other value alike — so `cloud-only` and
 * `local-first` were indistinguishable: Phases 1-3 ran first and cloud was
 * reached only when they ALL failed. A role set to "OpenRouter Only" kept using
 * a local GPU whenever one was running, which is the opposite of the setting.
 *
 * The second half of this file is the safety property: Phase 0 must be
 * unreachable for every role except `completion`, and must never take a role
 * down when the cloud cannot serve it.
 */

const getConfig = jest.fn();
const getCloudProviders = jest.fn();
const getFleetStatus = jest.fn();

jest.mock('@/lib/db/config', () => ({ getConfig: () => getConfig() }));
jest.mock('@/lib/gpu/cloud-provider', () => ({ getCloudProviders: () => getCloudProviders() }));
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: loggerInfo, warn: loggerWarn, error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/db/role-registry', () => ({
  getEnabledModesForHost: jest.fn().mockResolvedValue([]),
  getRuntimesForHost: jest.fn().mockResolvedValue({}),
  getModelOverridesForHost: jest.fn().mockResolvedValue({}),
  getEffectiveMinOnline: jest.fn().mockResolvedValue({}),
  getEffectiveIdleTimeoutsMs: jest.fn().mockResolvedValue({}),
  isModeName: jest.fn().mockReturnValue(true),
  resolveModelFromConfig: jest.fn(),
}));
jest.mock('@/lib/db/role-registry-seed', () => ({ seedAssignmentsForHost: jest.fn() }));

const openrouter = {
  id: 'openrouter',
  resolve: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  getCloudProviders.mockReturnValue([openrouter]);
  openrouter.resolve.mockResolvedValue({ providerId: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' });
  // An EMPTY fleet. If Phase 0 works, nothing below it is consulted — and if it
  // regresses, the local phases have nothing to find and the call throws, so a
  // regression fails loudly rather than quietly using a different route.
  getFleetStatus.mockResolvedValue({ sidecars: [] });
});

async function resolve(role: string) {
  const mod = await import('../fleet-router');
  return mod.resolveEndpoint(role as never);
}

/**
 * Which phase produced the cloud endpoint.
 *
 * resolveCloudEndpoint logs `{ phase }`, and that is the only observable
 * difference between Phase 0 and Phase 4 — both return an identical cloud
 * endpoint. An earlier draft tried to spy on getFleetStatus instead; that does
 * not work, because resolveEndpoint calls the module-local binding and
 * reassigning the export has no effect on it.
 */
function cloudPhase(): number | undefined {
  const call = loggerInfo.mock.calls.find(
    ([msg, meta]) => typeof msg === 'string' && msg.includes('cloud:') && meta && 'phase' in meta,
  );
  return call?.[1]?.phase;
}

describe('Phase 0 — completion with cloud-only', () => {
  it('resolves to the cloud without consulting the fleet', async () => {
    getConfig.mockResolvedValue({ virtualInferenceModeCompletion: 'cloud-only' });
    const ep = await resolve('completion');
    expect(ep.source).toBe('cloud');
    expect(ep.cloudProviderId).toBe('openrouter');
    expect(ep.cloudModel).toBe('deepseek/deepseek-v4.1-flash');
    expect(openrouter.resolve).toHaveBeenCalledTimes(1);
    // Phase 0, not 4 — it did not go through local discovery first.
    expect(cloudPhase()).toBe(0);
  });

  it('falls THROUGH when no cloud provider can serve it — never takes the role down', async () => {
    // A missing model or a tripped spend cap must degrade to local discovery,
    // not fail the request outright.
    getConfig.mockResolvedValue({ virtualInferenceModeCompletion: 'cloud-only' });
    openrouter.resolve.mockResolvedValue(null);
    // Empty fleet, so local discovery legitimately fails — the point is that we
    // REACHED it rather than returning a cloud error.
    await expect(resolve('completion')).rejects.toThrow(/No sidecar available/);
  });

  it('survives a provider that throws', async () => {
    getConfig.mockResolvedValue({ virtualInferenceModeCompletion: 'cloud-only' });
    openrouter.resolve.mockRejectedValue(new Error('spend cap tripped'));
    await expect(resolve('completion')).rejects.toThrow(/No sidecar available/);
  });
});

describe('Phase 0 is unreachable for everything else', () => {
  it('local-first reaches cloud only via Phase 4, AFTER local discovery', async () => {
    // Note what this does NOT assert: that the call fails. With no fleet, local
    // discovery legitimately fails and Phase 4 then resolves to cloud — correct
    // for local-first. Both phases return an identical endpoint, so the phase
    // number in the log is the discriminator.
    getConfig.mockResolvedValue({ virtualInferenceModeCompletion: 'local-first' });
    const ep = await resolve('completion');
    expect(ep.source).toBe('cloud');
    expect(cloudPhase()).toBe(4);
  });

  it('does not fire for local-only at all', async () => {
    getConfig.mockResolvedValue({ virtualInferenceModeCompletion: 'local-only' });
    await expect(resolve('completion')).rejects.toThrow();
    expect(openrouter.resolve).not.toHaveBeenCalled();
  });

  it.each(['embedding', 'code-embedding', 'reranker', 'ocr'])(
    'never fires for %s — virtualInferenceModeFor hard-returns local-only for it',
    async (role) => {
      // Even with completion set to cloud-only, these roles are not governed by
      // it. The reranker in particular routes via config.rerankProvider, not
      // this function — see task 51.
      getConfig.mockResolvedValue({ virtualInferenceModeCompletion: 'cloud-only' });
      await expect(resolve(role)).rejects.toThrow();
      expect(openrouter.resolve).not.toHaveBeenCalled();
    },
  );
});
