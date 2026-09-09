/**
 * @jest-environment node
 *
 * Task 40 items 3, 4, 5, 6 — stale-acquire discount, opt-in admission control,
 * legible refusal, and the acquire-feedback step.
 *
 * All fixture data is synthetic (host-a/b/c, 127.0.0.x).
 */

const mockGetConfig = jest.fn();
const mockQueueSidecarCommand = jest.fn();
const mockUpdateSidecarStatus = jest.fn();
const mockUpdateRoleLoad = jest.fn();

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('@/lib/db/config', () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  setConfigValue: jest.fn(),
}));
jest.mock('@/lib/gpu/command-queue', () => ({
  queueSidecarCommand: (...a: unknown[]) => mockQueueSidecarCommand(...a),
}));
jest.mock('@/lib/gpu/ws-relay', () => ({
  hasSidecarConnection: () => true, getConnectedSidecars: () => [], sendCommand: jest.fn(),
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

type FakeStatus = {
  agentUrl: string; hostname: string; wsConnected: boolean; lastSeen: number;
  containers: Record<string, { status: string; gpuReady?: boolean; config?: { port?: number; gpuOnly?: boolean }; loadedModels?: Array<{ gpuPercent?: number }> }>;
  activeRequests: number;
  roles: Record<string, { activeRequests: number; idleTimerActive?: boolean; lastAcquire?: string | null; lastRelease?: string | null }>;
};
const fakeCache = new Map<string, FakeStatus>();

jest.mock('@/lib/gpu/status-cache', () => ({
  getSidecarStatus: (url: string) => fakeCache.get(url.replace(/\/+$/, '')),
  getAllSidecarStatuses: () => Array.from(fakeCache.values()),
  isSidecarConnected: (url: string) => fakeCache.has(url.replace(/\/+$/, '')),
  updateSidecarStatus: (...a: unknown[]) => mockUpdateSidecarStatus(...a),
  updateRoleLoad: (...a: unknown[]) => mockUpdateRoleLoad(...a),
  markSidecarDisconnected: jest.fn(),
}));

const HOSTS = [
  { url: 'http://127.0.0.1:8098', hostname: 'host-a' },
  { url: 'http://127.0.0.2:8098', hostname: 'host-b' },
  { url: 'http://127.0.0.3:8098', hostname: 'host-c' },
];

function seedFleet(opts: {
  role: string;
  loads: number[];
  lastAcquire?: (string | null)[];
  gpuPercent?: number[];
  running?: boolean;
}) {
  fakeCache.clear();
  HOSTS.forEach((h, i) => {
    fakeCache.set(h.url, {
      agentUrl: h.url, hostname: h.hostname, wsConnected: true, lastSeen: Date.now(),
      containers: (opts.running ?? true) ? {
        [opts.role]: {
          status: 'running', gpuReady: true, config: { port: 11434 },
          loadedModels: [{ gpuPercent: opts.gpuPercent ? opts.gpuPercent[i] : 100 }],
        },
      } : {},
      activeRequests: 0,
      roles: {
        [opts.role]: {
          activeRequests: opts.loads[i],
          idleTimerActive: false,
          lastAcquire: opts.lastAcquire ? opts.lastAcquire[i] : new Date().toISOString(),
        },
      },
    });
  });
  mockGetConfig.mockResolvedValue({
    gpuSidecars: JSON.stringify(HOSTS.map(h => ({
      url: h.url, hostname: h.hostname, mode: 'websocket', status: 'connected',
      lastSeen: new Date().toISOString(), containers: [],
    }))),
  });
}

const ENV_KEYS = ['FLEET_MAX_ACTIVE_PER_ROLE', 'FLEET_MAX_ACTIVE_PER_HOST', 'FLEET_STALE_ACQUIRE_MS'] as const;

describe('Task 40 — stale-acquire discount and admission control', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    jest.resetModules();
    mockQueueSidecarCommand.mockReset();
    mockGetConfig.mockReset();
    mockUpdateSidecarStatus.mockReset();
    mockUpdateRoleLoad.mockReset();
    savedEnv = {};
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
  });

  // ── item 3: the discount itself ────────────────────────────────────────────

  describe('effectiveRoleLoad', () => {
    it('passes a fresh counter through untouched', async () => {
      const { effectiveRoleLoad } = await import('@/lib/gpu/fleet-router');
      const r = effectiveRoleLoad(
        { roles: { embedding: { activeRequests: 3, lastAcquire: new Date().toISOString() } } },
        'embedding',
      );
      expect(r).toEqual({ load: 3, reported: 3, discounted: false });
    });

    it('discounts a positive counter whose last acquire is older than the threshold', async () => {
      const { effectiveRoleLoad } = await import('@/lib/gpu/fleet-router');
      const old = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
      const r = effectiveRoleLoad(
        { roles: { embedding: { activeRequests: 4, lastAcquire: old } } },
        'embedding',
      );
      expect(r).toEqual({ load: 0, reported: 4, discounted: true });
    });

    it('does NOT discount when lastAcquire is absent — UNREPORTED is not stale', async () => {
      const { effectiveRoleLoad } = await import('@/lib/gpu/fleet-router');
      const r = effectiveRoleLoad({ roles: { embedding: { activeRequests: 2 } } }, 'embedding');
      expect(r).toEqual({ load: 2, reported: 2, discounted: false });
    });

    it('does NOT discount an unparseable lastAcquire', async () => {
      const { effectiveRoleLoad } = await import('@/lib/gpu/fleet-router');
      const r = effectiveRoleLoad(
        { roles: { embedding: { activeRequests: 2, lastAcquire: 'not-a-date' } } },
        'embedding',
      );
      expect(r.discounted).toBe(false);
      expect(r.load).toBe(2);
    });

    it('leaves a zero counter alone (nothing to reconcile)', async () => {
      const { effectiveRoleLoad } = await import('@/lib/gpu/fleet-router');
      const old = new Date(Date.now() - 60 * 60_000).toISOString();
      const r = effectiveRoleLoad(
        { roles: { embedding: { activeRequests: 0, lastAcquire: old } } },
        'embedding',
      );
      expect(r).toEqual({ load: 0, reported: 0, discounted: false });
    });

    it('falls back to the legacy top-level counter for older sidecars', async () => {
      const { effectiveRoleLoad } = await import('@/lib/gpu/fleet-router');
      const r = effectiveRoleLoad({ activeRequests: 5, roles: {} }, 'embedding');
      expect(r).toEqual({ load: 5, reported: 5, discounted: false });
    });

    it('honours FLEET_STALE_ACQUIRE_MS', async () => {
      process.env.FLEET_STALE_ACQUIRE_MS = '1000';
      const { effectiveRoleLoad } = await import('@/lib/gpu/fleet-router');
      const r = effectiveRoleLoad(
        { roles: { embedding: { activeRequests: 1, lastAcquire: new Date(Date.now() - 5_000).toISOString() } } },
        'embedding',
      );
      expect(r.discounted).toBe(true);
    });
  });

  // ── item 3: the discount changes routing (this is the fix working) ─────────

  it('routes to the host with the LEAKED counter once it is discounted', async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const fresh = new Date().toISOString();
    // host-a looks busiest (9) but its counter is stale → actually free.
    // host-b/c are genuinely busy.
    seedFleet({ role: 'embedding', loads: [9, 2, 3], lastAcquire: [old, fresh, fresh] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const r = await resolveEndpoint('embedding' as never);
    expect(r.host).toContain('127.0.0.1'); // host-a
  });

  it('still avoids a genuinely busy host when every counter is fresh', async () => {
    const fresh = new Date().toISOString();
    seedFleet({ role: 'embedding', loads: [9, 2, 3], lastAcquire: [fresh, fresh, fresh] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const r = await resolveEndpoint('embedding' as never);
    expect(r.host).toContain('127.0.0.2'); // host-b, load 2
  });

  // ── item 4: admission is OFF by default ───────────────────────────────────

  it('is disabled by default — a heavily loaded fleet still routes', async () => {
    seedFleet({ role: 'embedding', loads: [50, 60, 70] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { readAdmissionCaps, resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    expect(readAdmissionCaps().enabled).toBe(false);
    await expect(resolveEndpoint('embedding' as never)).resolves.toBeDefined();
  });

  it('opts in via FLEET_MAX_ACTIVE_PER_ROLE and refuses when every host is at cap', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '4';
    seedFleet({ role: 'embedding', loads: [4, 6, 9] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await expect(resolveEndpoint('embedding' as never)).rejects.toThrow(/Fleet saturated/);
  });

  it('admits when a single host still has headroom', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '4';
    seedFleet({ role: 'embedding', loads: [9, 3, 9] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const r = await resolveEndpoint('embedding' as never);
    expect(r.host).toContain('127.0.0.2');
  });

  it('a five-user burst on an IDLE fleet is never refused (the burst-starvation risk)', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '4';
    seedFleet({ role: 'embedding', loads: [0, 0, 0] });
    // Each acquire increments that host's counter, as the real sidecar does.
    mockQueueSidecarCommand.mockImplementation(async (agentUrl: string, action: string) => {
      const e = fakeCache.get(agentUrl.replace(/\/+$/, ''));
      if (action === 'acquire' && e) e.roles.embedding.activeRequests += 1;
      return { action: 'already_running', activeRequests: e?.roles.embedding.activeRequests };
    });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    for (let i = 0; i < 5; i++) {
      await expect(resolveEndpoint('embedding' as never)).resolves.toBeDefined();
    }
  });

  it('per-host caps route AROUND a host at cap to a bigger host with headroom', async () => {
    // The regression this pins: the cap must be a candidate FILTER, not a check
    // on the winner. host-a/b/c all tie at load 5, so host-a wins on load — but
    // host-a's cap is 2 and host-c's is 12. Checking only the winner would
    // refuse the whole fleet while host-c had seven free slots.
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '2';
    process.env.FLEET_MAX_ACTIVE_PER_HOST = JSON.stringify({ 'host-c': 12 });
    seedFleet({ role: 'embedding', loads: [5, 5, 5] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { readAdmissionCaps, resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    expect(readAdmissionCaps().perHost).toEqual({ 'host-c': 12 });
    const r = await resolveEndpoint('embedding' as never);
    expect(r.host).toContain('127.0.0.3'); // host-c
  });

  it('refuses only when NO host has headroom under its own cap', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '2';
    process.env.FLEET_MAX_ACTIVE_PER_HOST = JSON.stringify({ 'host-c': 12 });
    seedFleet({ role: 'embedding', loads: [5, 5, 20] }); // host-c now over 12 too
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await expect(resolveEndpoint('embedding' as never)).rejects.toThrow(/Fleet saturated/);
  });

  it('ignores malformed FLEET_MAX_ACTIVE_PER_HOST rather than throwing', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '4';
    process.env.FLEET_MAX_ACTIVE_PER_HOST = '{not json';
    const { readAdmissionCaps } = await import('@/lib/gpu/fleet-router');
    const caps = readAdmissionCaps();
    expect(caps.enabled).toBe(true);
    expect(caps.perHost).toEqual({});
  });

  // ── item 5: the refusal is legible ────────────────────────────────────────

  it('the refusal names the role, every host load, and the cap', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '4';
    seedFleet({ role: 'embedding', loads: [4, 6, 9] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const { FleetSaturatedError } = await import('@/lib/gpu/errors');

    let caught: unknown;
    try { await resolveEndpoint('embedding' as never); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(FleetSaturatedError);
    const err = caught as InstanceType<typeof FleetSaturatedError>;
    expect(err.role).toBe('embedding');
    expect(err.cap).toBe(4);
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.hosts).toEqual([
      { hostname: 'host-a', load: 4, cap: 4 },
      { hostname: 'host-b', load: 6, cap: 4 },
      { hostname: 'host-c', load: 9, cap: 4 },
    ]);
    expect(err.retryAfterMs).toBe(15_000);
    // Legible without unpacking the object — the message carries it too.
    expect(err.message).toContain('embedding');
    expect(err.message).toContain('host-a=4/4');
  });

  it('refuses on the DISCOUNTED load, so a leaked counter cannot fake saturation', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '4';
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    seedFleet({ role: 'embedding', loads: [99, 99, 99], lastAcquire: [old, old, old] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await expect(resolveEndpoint('embedding' as never)).resolves.toBeDefined();
  });

  // ── item 6: acquire feedback ──────────────────────────────────────────────

  it('feeds the sidecar-reported activeRequests from /acquire back into the cache', async () => {
    seedFleet({ role: 'embedding', loads: [0, 0, 0] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running', activeRequests: 7 });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await resolveEndpoint('embedding' as never);

    expect(mockUpdateRoleLoad).toHaveBeenCalledWith('http://127.0.0.1:8098', 'embedding', 7);
  });

  it('never routes the feedback write through updateSidecarStatus (it would refresh lastSeen)', async () => {
    // Liveness must come from heartbeats only. If the acquire feedback stamped
    // lastSeen, a sidecar that had stopped heartbeating but still answered
    // /acquire would read as connected indefinitely, and sendToSidecar would
    // serve its stale /status snapshot as fresh.
    seedFleet({ role: 'embedding', loads: [0, 0, 0] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running', activeRequests: 7 });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await resolveEndpoint('embedding' as never);
    expect(mockUpdateSidecarStatus).not.toHaveBeenCalled();
  });

  it('does not write to the cache when /acquire reports no count', async () => {
    seedFleet({ role: 'embedding', loads: [0, 0, 0] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await resolveEndpoint('embedding' as never);
    expect(mockUpdateRoleLoad).not.toHaveBeenCalled();
  });

  it('a failing /acquire still routes — the container is already running', async () => {
    seedFleet({ role: 'embedding', loads: [0, 0, 0] });
    mockQueueSidecarCommand.mockRejectedValue(new Error('sidecar unreachable'));

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await expect(resolveEndpoint('embedding' as never)).resolves.toBeDefined();
  });

  // ── the load-bearing invariant admission must never weaken ────────────────

  it('INVARIANT: a GPU-only role is never routed to a CPU-offloaded host, cap or no cap', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '100'; // cap so high it can never refuse
    seedFleet({ role: 'ocr', loads: [0, 0, 0], gpuPercent: [40, 55, 10] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const { NoGpuReadyEndpointError } = await import('@/lib/gpu/errors');

    let caught: unknown;
    try { await resolveEndpoint('ocr' as never); } catch (e) { caught = e; }
    // gpuOnly refusal, NOT a saturation refusal — the guard fires first and
    // admission control never gets to override it.
    expect(caught).toBeInstanceOf(NoGpuReadyEndpointError);
  });

  it('a saturated GPU-only fleet is told SATURATED, not "no GPU-ready sidecar"', async () => {
    // Every host is fully GPU-ready — the only reason none can serve is the cap.
    // Reporting NoGpuReadyEndpointError here would misdescribe the failure and
    // recreate the `notReady` defect: a signal that says nothing actionable.
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '2';
    seedFleet({ role: 'ocr', loads: [5, 5, 5], gpuPercent: [100, 100, 100] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const { FleetSaturatedError } = await import('@/lib/gpu/errors');

    let caught: unknown;
    try { await resolveEndpoint('ocr' as never); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FleetSaturatedError);
    expect((caught as InstanceType<typeof FleetSaturatedError>).role).toBe('ocr');
  });

  it('INVARIANT: gpuOnly refusal wins when hosts are CPU-offloaded AND saturated', async () => {
    process.env.FLEET_MAX_ACTIVE_PER_ROLE = '1';
    seedFleet({ role: 'ocr', loads: [8, 8, 8], gpuPercent: [40, 55, 10] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const { NoGpuReadyEndpointError } = await import('@/lib/gpu/errors');

    let caught: unknown;
    try { await resolveEndpoint('ocr' as never); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(NoGpuReadyEndpointError);
  });
});

// Module scope: keeps these fixture identifiers out of the global TS namespace,
// so the two Task 40 suites can share names without colliding under tsc.
export {};
