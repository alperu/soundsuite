/**
 * @jest-environment node
 *
 * fleet.source = follow (task 57 / 3.6): the fleet router stops managing the
 * sidecars. Min-online enforcement does nothing, container start/stop is
 * refused, config pushes answer "skipped" without a network call. In local mode
 * the same paths still run. Routing is not management (decision Q5): while
 * following, resolveEndpoint() still picks a host and takes its lease.
 *
 * All fixture data is synthetic (127.0.0.x).
 */

// Module scope: other fleet-router tests declare the same mock names at top level.
export {};

const mockGetConfig = jest.fn();
let followMode = false;
const followSkip = jest.fn((label: string) => ({ skipped: 'follow', reason: `Managed by sidecarmaster (${label})` }));
const listAllAssignments = jest.fn(async () => []);
const sendToSidecarCalls: string[] = [];

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/db/config', () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  setConfigValue: jest.fn(),
}));
jest.mock('@/lib/db/fleet-source', () => ({
  isFollowMode: async () => followMode,
  followSkip: (...a: unknown[]) => followSkip(...(a as [string])),
  refuseInFollowMode: async (what: string) => {
    if (followMode) throw new Error(`${what} is managed by sidecarmaster at https://sm.example.test. Edit it there.`);
  },
}));
// sendToSidecar() goes over the WS command queue when the sidecar is connected.
const queueSidecarCommand = jest.fn(async (..._args: unknown[]) => ({ action: 'already_running', activeRequests: 1 }));
jest.mock('@/lib/gpu/command-queue', () => ({
  queueSidecarCommand: (...a: unknown[]) => queueSidecarCommand(...a),
}));
jest.mock('@/lib/gpu/ws-relay', () => ({
  hasSidecarConnection: () => true,
  getConnectedSidecars: () => [],
  sendCommand: jest.fn(),
}));
jest.mock('@/lib/db/role-registry', () => ({
  getEnabledModesForHost: jest.fn(async () => []),
  getModelOverridesForHost: jest.fn(async () => ({})),
  getEffectiveMinOnline: jest.fn(async () => ({})),
  getEffectiveIdleTimeoutsMs: jest.fn(async () => ({})),
  getRuntimesForHost: jest.fn(async () => ({})),
  listAllAssignments: (...a: unknown[]) => listAllAssignments(...(a as [])),
}));
jest.mock('@/lib/db/role-registry-seed', () => ({ seedAssignmentsForHost: jest.fn() }));
jest.mock('@/lib/db/host-provisioning', () => ({ getProvisioning: jest.fn(async () => ({})) }));
type FakeStatus = {
  agentUrl: string; hostname: string; wsConnected: boolean; lastSeen: number;
  containers: Record<string, { status: string; gpuReady?: boolean; config?: { port?: number }; loadedModels?: Array<{ gpuPercent?: number }> }>;
  activeRequests: number;
  roles: Record<string, { activeRequests: number; idleTimerActive?: boolean; lastAcquire?: string | null }>;
};
const fakeCache = new Map<string, FakeStatus>();
jest.mock('@/lib/gpu/status-cache', () => ({
  getSidecarStatus: (url: string) => fakeCache.get(url.replace(/\/+$/, '')),
  getAllSidecarStatuses: () => Array.from(fakeCache.values()),
  isSidecarConnected: (url: string) => fakeCache.has(url.replace(/\/+$/, '')),
  updateSidecarStatus: jest.fn(),
  updateRoleLoad: jest.fn(),
  markSidecarDisconnected: jest.fn(),
}));

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('fleet router in follow mode', () => {
  beforeEach(() => {
    jest.resetModules();
    followSkip.mockClear();
    listAllAssignments.mockClear();
    sendToSidecarCalls.length = 0;
    queueSidecarCommand.mockClear();
    fakeCache.clear();
    mockGetConfig.mockResolvedValue({ gpuSidecars: '[]' });
    // Any real sidecar call is a test failure: nothing here may reach the network.
    global.fetch = jest.fn(async (url: unknown) => {
      sendToSidecarCalls.push(String(url));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  it('min-online enforcement does nothing while following', async () => {
    followMode = true;
    const router = await import('@/lib/gpu/fleet-router');
    router.startMinOnlineEnforcement();
    try {
      await flush();
    } finally {
      router.stopMinOnlineEnforcement();
    }
    expect(followSkip).toHaveBeenCalledWith('min-online enforcement');
    expect(listAllAssignments).not.toHaveBeenCalled();
    expect(sendToSidecarCalls).toEqual([]);
  });

  it('min-online enforcement still runs in local mode', async () => {
    followMode = false;
    const router = await import('@/lib/gpu/fleet-router');
    router.startMinOnlineEnforcement();
    try {
      await flush();
    } finally {
      router.stopMinOnlineEnforcement();
    }
    expect(followSkip).not.toHaveBeenCalled();
    expect(listAllAssignments).toHaveBeenCalled();
  });

  it('container start/stop is refused and names sidecarmaster', async () => {
    followMode = true;
    const { controlContainer } = await import('@/lib/gpu/fleet-router');
    await expect(controlContainer('http://127.0.0.1:8098', 'start', 'embedding')).rejects.toThrow(
      /Container start is managed by sidecarmaster at https:\/\/sm\.example\.test/,
    );
    await expect(controlContainer('http://127.0.0.1:8098', 'stop', 'embedding')).rejects.toThrow(/managed by sidecarmaster/);
    expect(sendToSidecarCalls).toEqual([]);
  });

  it('config pushes answer "skipped" without a network call', async () => {
    followMode = true;
    const { pushIdleTimeouts, pushModelRegistry, pushFullConfig } = await import('@/lib/gpu/fleet-router');
    const timeouts = { embedding: 5, completion: 5, ocr: 5, reranker: 5 } as never;
    expect(await pushIdleTimeouts('http://127.0.0.1:8098', timeouts)).toMatchObject({ skipped: 'follow' });
    expect(await pushModelRegistry('http://127.0.0.1:8098')).toMatchObject({ skipped: 'follow' });
    expect(await pushFullConfig('http://127.0.0.1:8098', {} as never)).toMatchObject({ skipped: 'follow' });
    expect(sendToSidecarCalls).toEqual([]);
    expect(followSkip.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['idle-timeout push', 'model-registry push', 'full-config push']),
    );
  });

  it('routing still picks a host and takes its lease while following (Q5)', async () => {
    followMode = true;
    const url = 'http://127.0.0.1:8098';
    fakeCache.set(url, {
      agentUrl: url, hostname: 'host-a', wsConnected: true, lastSeen: Date.now(),
      containers: { embedding: { status: 'running', gpuReady: true, config: { port: 11434 }, loadedModels: [{ gpuPercent: 100 }] } },
      activeRequests: 0,
      roles: { embedding: { activeRequests: 0, idleTimerActive: false, lastAcquire: new Date().toISOString() } },
    });
    mockGetConfig.mockResolvedValue({
      gpuSidecars: JSON.stringify([
        { url, hostname: 'host-a', mode: 'websocket', status: 'connected', lastSeen: new Date().toISOString(), containers: [] },
      ]),
    });
    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const r = await resolveEndpoint('embedding' as never);
    expect(r.host).toContain('127.0.0.1');
    expect(r.sidecarUrl).toBe(url);
    // The lease call is routing, not management: it still reaches the sidecar.
    const sent = queueSidecarCommand.mock.calls.map((c) => [c[0], c[1]]);
    expect(sent).toContainEqual([url, 'acquire']);
    expect(sent.filter(([, action]) => action === 'start' || action === 'stop')).toEqual([]);
    // Routing may read the sidecar's status; it may not manage it.
    expect(sendToSidecarCalls.filter((u) => /\/(start|stop|config|provision|pull|load|update)(\?|$)/.test(u))).toEqual([]);
    expect(followSkip).not.toHaveBeenCalled();
  });
});
