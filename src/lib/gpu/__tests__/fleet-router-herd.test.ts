/**
 * @jest-environment node
 *
 * Task 40 item 2 — MEASURE the read-then-acquire "thundering herd" before
 * fixing it.
 *
 * This is a measurement harness, not a regression test. It fires N concurrent
 * `resolveEndpoint()` calls against a faked fleet and records which host each
 * one selected. No real sidecar, no real GPU, no network.
 *
 * All fixture data is synthetic (host-a/b/c, 127.0.0.x).
 *
 * Two configurations are measured, because a single one would be a tautology:
 *
 *   A. FROZEN snapshot — the status cache never changes during the burst.
 *      Phase 1's selection loop is fully synchronous over an in-memory Map,
 *      so a frozen snapshot forces 100% collision BY CONSTRUCTION. This is
 *      arithmetic, not an empirical result; it models the case where every
 *      arrival lands inside one heartbeat window.
 *
 *   B. FEEDBACK — the mocked `/acquire` response bumps that host's cached
 *      `activeRequests`, modelling what the code COULD do if it stopped
 *      discarding the acquire result. The delta between A and B is the
 *      design input for item 6.
 *
 * NOTE — why these numbers survive the item-6 fix: cases A/B/C mock `/acquire`
 * with a response carrying NO `activeRequests`, which is exactly what an older
 * sidecar returns. The feedback path added to Phase 1 is therefore inert in
 * A/B/C, so they keep recording the PRE-FIX baseline. Case D supplies the count
 * and shows post-fix behaviour. Do not "fix" A/B/C to feed back — that would
 * destroy the baseline this task was required to measure.
 */

const mockGetConfig = jest.fn();
const mockQueueSidecarCommand = jest.fn();

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  }),
}));

jest.mock('@/lib/db/config', () => ({
  getConfig: (...a: unknown[]) => mockGetConfig(...a),
  setConfigValue: jest.fn(),
}));

jest.mock('@/lib/gpu/command-queue', () => ({
  queueSidecarCommand: (...a: unknown[]) => mockQueueSidecarCommand(...a),
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
  listAllAssignments: jest.fn(async () => []),
}));

jest.mock('@/lib/db/role-registry-seed', () => ({ seedAssignmentsForHost: jest.fn() }));
jest.mock('@/lib/db/host-provisioning', () => ({ getProvisioning: jest.fn(async () => ({})) }));

// ─── Fake status cache ───────────────────────────────────────────────────────
// A plain mutable Map the tests own, so a burst can be run against a frozen
// snapshot or a snapshot that reacts to /acquire.

type FakeContainer = {
  status: string;
  gpuReady?: boolean;
  config?: { port?: number; gpuOnly?: boolean };
  loadedModels?: Array<{ gpuPercent?: number; processor?: string }>;
};
type FakeStatus = {
  agentUrl: string;
  hostname: string;
  wsConnected: boolean;
  lastSeen: number;
  containers: Record<string, FakeContainer>;
  activeRequests: number;
  roles: Record<string, { activeRequests: number; lastAcquire?: string | null; lastRelease?: string | null }>;
};

const fakeCache = new Map<string, FakeStatus>();

jest.mock('@/lib/gpu/status-cache', () => ({
  getSidecarStatus: (url: string) => fakeCache.get(url.replace(/\/+$/, '')),
  getAllSidecarStatuses: () => Array.from(fakeCache.values()),
  isSidecarConnected: (url: string) => fakeCache.has(url.replace(/\/+$/, '')),
  updateSidecarStatus: jest.fn(),
  markSidecarDisconnected: jest.fn(),
}));

const HOSTS = [
  { url: 'http://127.0.0.1:8098', hostname: 'host-a' },
  { url: 'http://127.0.0.2:8098', hostname: 'host-b' },
  { url: 'http://127.0.0.3:8098', hostname: 'host-c' },
];

function seedFleet(opts: {
  role: string;
  running: boolean;
  loads?: number[];
  gpuPercent?: number[];
  gpuOnly?: boolean;
  gpuReady?: boolean[];
}) {
  fakeCache.clear();
  HOSTS.forEach((h, i) => {
    const containers: Record<string, FakeContainer> = {};
    if (opts.running) {
      containers[opts.role] = {
        status: 'running',
        gpuReady: opts.gpuReady ? opts.gpuReady[i] : true,
        config: { port: 11434, ...(opts.gpuOnly ? { gpuOnly: true } : {}) },
        loadedModels: [{ gpuPercent: opts.gpuPercent ? opts.gpuPercent[i] : 100 }],
      };
    }
    fakeCache.set(h.url, {
      agentUrl: h.url,
      hostname: h.hostname,
      wsConnected: true,
      lastSeen: Date.now(),
      containers,
      activeRequests: 0,
      roles: { [opts.role]: { activeRequests: opts.loads ? opts.loads[i] : 0 } },
    });
  });

  mockGetConfig.mockResolvedValue({
    gpuSidecars: JSON.stringify(
      HOSTS.map(h => ({ url: h.url, hostname: h.hostname, mode: 'websocket', status: 'connected', lastSeen: new Date().toISOString(), containers: [] })),
    ),
  });
}

/** Count selections per hostname. */
function distribution(urls: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of urls) {
    const host = HOSTS.find(h => u.includes(new URL(h.url).hostname))?.hostname ?? u;
    out[host] = (out[host] ?? 0) + 1;
  }
  return out;
}

const N = 5; // "five users call at once" — the question this task answers

describe('Task 40 item 2 — concurrent resolveEndpoint distribution', () => {
  beforeEach(() => {
    jest.resetModules();
    mockQueueSidecarCommand.mockReset();
    mockGetConfig.mockReset();
  });

  it('A/cold: N concurrent resolutions for a role with NO running container', async () => {
    seedFleet({ role: 'embedding', running: false });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'started' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const results = await Promise.all(
      Array.from({ length: N }, () => resolveEndpoint('embedding' as never)),
    );
    const dist = distribution(results.map(r => r.host));
    console.log('[MEASURED] cold role, frozen cache:', JSON.stringify(dist));

    // Phase 2 has NO load criterion at all — it returns reachable[0] on first
    // success. Every arrival lands on the same host regardless of cache state.
    expect(dist['host-a']).toBe(N);
  });

  it('B/warm-tied: N concurrent resolutions, all hosts running with EQUAL load (frozen cache)', async () => {
    seedFleet({ role: 'embedding', running: true, loads: [0, 0, 0] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const results = await Promise.all(
      Array.from({ length: N }, () => resolveEndpoint('embedding' as never)),
    );
    const dist = distribution(results.map(r => r.host));
    console.log('[MEASURED] warm role, equal load, frozen cache:', JSON.stringify(dist));

    expect(dist['host-a']).toBe(N);
  });

  it('C/warm-skewed: unequal cached load still sends the whole burst to the minimum', async () => {
    seedFleet({ role: 'embedding', running: true, loads: [4, 1, 7] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const results = await Promise.all(
      Array.from({ length: N }, () => resolveEndpoint('embedding' as never)),
    );
    const dist = distribution(results.map(r => r.host));
    console.log('[MEASURED] warm role, skewed load, frozen cache:', JSON.stringify(dist));

    expect(dist['host-b']).toBe(N);
  });

  it('D/feedback: same burst, but /acquire feeds the cache back — models the item-6 fix', async () => {
    seedFleet({ role: 'embedding', running: true, loads: [0, 0, 0] });
    // Model the acquire response the router currently DISCARDS: the sidecar
    // reports its own post-increment activeRequests, and the cache learns it.
    mockQueueSidecarCommand.mockImplementation(async (agentUrl: string, action: string) => {
      if (action === 'acquire') {
        const entry = fakeCache.get(agentUrl.replace(/\/+$/, ''));
        if (entry) entry.roles.embedding.activeRequests += 1;
        return { action: 'already_running', activeRequests: entry?.roles.embedding.activeRequests };
      }
      return { action: 'ok' };
    });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    // Sequential-with-feedback is the upper bound of what feedback can buy;
    // a true concurrent burst sits between this and the frozen case.
    const seq: string[] = [];
    for (let i = 0; i < N; i++) {
      seq.push((await resolveEndpoint('embedding' as never)).host);
    }
    const dist = distribution(seq);
    console.log('[MEASURED] warm role, acquire feeds cache back (serialised):', JSON.stringify(dist));

    // With feedback, the burst spreads across all three hosts.
    expect(Object.keys(dist).length).toBeGreaterThan(1);
  });

  it("B'/feedback under a TRUE concurrent burst — what item 6 actually buys", async () => {
    // Case D is sequential, so it measures the UPPER BOUND of what feedback can
    // do. This is the concurrent case: N resolutions in flight at once, with
    // /acquire reporting its post-increment count. The question is whether the
    // awaits inside resolveEndpoint (getFleetStatus, then /acquire) interleave
    // enough for feedback to land before later resolutions run selection.
    seedFleet({ role: 'embedding', running: true, loads: [0, 0, 0] });
    mockQueueSidecarCommand.mockImplementation(async (agentUrl: string, action: string) => {
      const entry = fakeCache.get(agentUrl.replace(/\/+$/, ''));
      if (action === 'acquire' && entry) {
        entry.roles.embedding.activeRequests += 1;
        return { action: 'already_running', activeRequests: entry.roles.embedding.activeRequests };
      }
      return { action: 'ok' };
    });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    const results = await Promise.all(
      Array.from({ length: N }, () => resolveEndpoint('embedding' as never)),
    );
    const dist = distribution(results.map(r => r.host));
    console.log("[MEASURED] warm role, acquire feeds cache back (CONCURRENT):", JSON.stringify(dist));

    // Recorded, not asserted-to-spread: the POINT of this case is the number.
    // Whichever way it falls, it is the honest scope of the item-6 fix.
    expect(Object.values(dist).reduce((a, b) => a + b, 0)).toBe(N);
  });

  it('E/gpuOnly invariant: a GPU-only role is never routed to a CPU-offloaded host', async () => {
    // ocr is gpuOnly by the cold-path guard (fleet-router GPU_ONLY_ROLES).
    // Every host is partially offloaded → must throw, never route.
    seedFleet({ role: 'ocr', running: true, loads: [0, 0, 0], gpuPercent: [40, 55, 10] });
    mockQueueSidecarCommand.mockResolvedValue({ action: 'already_running' });

    const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
    await expect(resolveEndpoint('ocr' as never)).rejects.toThrow(/GPU-ready/i);
  });
});

// Module scope: keeps these fixture identifiers out of the global TS namespace,
// so the two Task 40 suites can share names without colliding under tsc.
export {};
