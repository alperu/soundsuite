/**
 * @jest-environment node
 *
 * Task 41: the registry is keyed by the sidecar's advertised address, so a host
 * moved by DHCP used to produce a SECOND entry for one machine while the first —
 * a dead address the master still dials — lived on.
 *
 * On the same-socket path the old entry leaked permanently: `ws-relay.ts`
 * reassigns the connection's `registeredUrl`, and the `close` handler only ever
 * deletes `registeredUrl`, so nothing removed the old key for the life of the
 * process and `persistSidecarList()` kept writing it out.
 *
 * These drive the real relay over a real loopback WebSocket. Addresses are
 * invented hostnames and RFC 5737 documentation ranges.
 */

import { WebSocket as WsClient } from 'ws';

// Re-keying moves the status-cache entry too, so these are real fakes rather
// than bare jest.fn()s — the test asserts the entry followed the address.
const cache = new Map<string, any>();
jest.mock('../status-cache', () => ({
  updateSidecarStatus: jest.fn((url: string, status: any) => {
    cache.set(url, { ...(cache.get(url) ?? {}), ...status, agentUrl: url });
  }),
  getSidecarStatus: jest.fn((url: string) => cache.get(url) ?? null),
  removeSidecarFromCache: jest.fn((url: string) => { cache.delete(url); }),
  markSidecarDisconnected: jest.fn(),
  getAllSidecarStatuses: jest.fn(() => []),
}));

// Persistence writes through the Config table; capture what it would persist.
const persisted: string[] = [];
jest.mock('@/lib/db/config', () => ({
  setConfigValue: jest.fn(async (_key: string, value: string) => { persisted.push(value); }),
  getConfig: jest.fn(async () => ({})),
}));

jest.mock('@/lib/db/prisma', () => ({
  prisma: { config: { upsert: jest.fn(), findUnique: jest.fn(async () => null) } },
}));

// The register handler fires these off after acking; none is under test.
jest.mock('@/lib/db/host-provisioning', () => ({
  getProvisioning: jest.fn(async () => null),
  upsertProvisioning: jest.fn(),
  deleteProvisioning: jest.fn(),
}));

const PORT = 34101;
process.env.GPU_WS_PORT = String(PORT);

// eslint-disable-next-line @typescript-eslint/no-var-requires
// The relay caches its server and maps on globalThis so Next.js module
// isolation cannot produce two of them. Jest reuses a worker process across test
// FILES, so that cache leaks between suites: a second relay suite would call
// startWsRelay(), find an existing __ss_wss__ from the first, and silently share
// its server — making any assertion on a global socket count measure the other
// suite's connections. Reset the cache so this suite gets its own relay.
const __g = globalThis as any;
for (const k of ['__ss_wss__', '__ss_ws_sidecars__', '__ss_ws_pending__',
                 '__ss_ws_sweep__', '__ss_ws_blocked__', '__ss_ws_cmdCounter__']) {
  delete __g[k];
}

const relay = require('../ws-relay');

let seq = 0;
const oldAddr = () => `http://192.0.2.${100 + ++seq}:8098`;

function connect(): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${PORT}/sidecar`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Send `register` and resolve with the relay's ack frame. */
function register(ws: WsClient, agentUrl: string, hostname = 'sidecar-alpha'): Promise<any> {
  return new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'registered') { ws.off('message', onMsg); resolve(msg); }
      } catch { /* ignore non-JSON */ }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'register', agentUrl, hostname, containers: ['ss-embed'] }));
  });
}

const closed = (ws: WsClient) =>
  new Promise<void>((r) => (ws.readyState === WsClient.CLOSED ? r() : ws.once('close', () => r())));

const urls = () => relay.getConnectedSidecars().map((s: any) => s.agentUrl);

beforeAll(() => { relay.startWsRelay(); });
afterAll(() => { relay.stopWsRelay(); });
beforeEach(() => { cache.clear(); persisted.length = 0; });

describe('a sidecar whose address changes', () => {
  it('moves its registry entry instead of adding a second one', async () => {
    const from = oldAddr();
    const to = 'http://192.0.2.238:8098';
    const ws = await connect();
    await register(ws, from);
    expect(urls()).toContain(from);

    // The sidecar's revalidation tick re-registers on the SAME live socket.
    await register(ws, to);

    // This is the assertion that fails without the fix: `from` stays in the map
    // forever, pointing at this very socket.
    expect(urls()).not.toContain(from);
    expect(urls()).toContain(to);
    expect(urls().filter((u: string) => u === to)).toHaveLength(1);

    // And the persisted list — what the fleet UI and router read — carries one.
    const last = JSON.parse(persisted[persisted.length - 1]);
    expect(last.filter((e: any) => e.url === from)).toHaveLength(0);
    expect(last.filter((e: any) => e.url === to)).toHaveLength(1);

    ws.close();
    await closed(ws);
  });

  it('carries roles and vram across the move rather than restarting empty', async () => {
    const from = oldAddr();
    const to = 'http://192.0.2.239:8098';
    const ws = await connect();
    await register(ws, from);

    // Stand in for what a heartbeat would have cached under the old address.
    cache.set(from, {
      agentUrl: from,
      hostname: 'sidecar-alpha',
      roles: { embedding: { loaded: true } },
      vram: { totalMb: 24576 },
      peakDemand: { embedding: 4 },
    });

    await register(ws, to);

    expect(cache.has(from)).toBe(false);
    expect(cache.get(to)).toMatchObject({
      agentUrl: to,
      roles: { embedding: { loaded: true } },
      vram: { totalMb: 24576 },
      peakDemand: { embedding: 4 },
    });

    ws.close();
    await closed(ws);
  });

  it('keeps the socket alive and heartbeating under the new key', async () => {
    const from = oldAddr();
    const to = 'http://192.0.2.240:8098';
    const ws = await connect();
    await register(ws, from);
    await register(ws, to);

    expect(ws.readyState).toBe(WsClient.OPEN);

    ws.send(JSON.stringify({
      type: 'heartbeat', containers: ['ss-embed'], activeRequests: 2,
      statusData: { hostname: 'sidecar-alpha' },
    }));
    await new Promise((r) => setTimeout(r, 100));

    // A heartbeat landing under the new key proves the connection's own notion
    // of its address moved with the registry entry.
    const entry = relay.getConnectedSidecars().find((s: any) => s.agentUrl === to);
    expect(entry.activeRequests).toBe(2);

    ws.close();
    await closed(ws);
  });

  it('drops the old key when the socket later closes, leaving nothing behind', async () => {
    const from = oldAddr();
    const to = 'http://192.0.2.241:8098';
    const ws = await connect();
    await register(ws, from);
    await register(ws, to);
    ws.close();
    await closed(ws);
    await new Promise((r) => setTimeout(r, 100));

    expect(urls()).not.toContain(from);
    expect(urls()).not.toContain(to);
  });
});

describe('the master observes where a sidecar actually connected from', () => {
  it('records the socket peer address alongside the declared one', async () => {
    // The sidecar declares an address it cannot validate. The peer address is by
    // construction the one it reached this master from — correct for whichever
    // path is in use (LAN / VPN / Tailscale), which the sidecar cannot know.
    const declared = 'http://192.0.2.77:8098';
    const ws = await connect();
    await register(ws, declared);

    const entry = relay.getConnectedSidecars().find((s: any) => s.agentUrl === declared);
    // The test client dials loopback, so that is legitimately what was observed —
    // and it differs from the declared address, which is the whole point.
    expect(entry.observedFromIp).toBe('127.0.0.1');
    expect(entry.observedFromIp).not.toBe(relay.declaredHostOf(declared));

    const last = JSON.parse(persisted[persisted.length - 1]);
    expect(last.find((e: any) => e.url === declared).lastSeenFromIp).toBe('127.0.0.1');

    ws.close();
    await closed(ws);
  });

  it('normalises IPv4-mapped IPv6 peer addresses', () => {
    // Node reports IPv4 over a dual-stack listener this way; left as-is it would
    // never compare equal to a declared address.
    expect(relay.normalizePeerAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(relay.normalizePeerAddress('192.0.2.1')).toBe('192.0.2.1');
    expect(relay.normalizePeerAddress('fe80::1')).toBe('fe80::1');
    expect(relay.normalizePeerAddress(undefined)).toBeUndefined();
  });

  it('keeps reporting the real peer across an address move', async () => {
    const from = oldAddr();
    const to = 'http://192.0.2.245:8098';
    const ws = await connect();
    await register(ws, from);
    await register(ws, to);

    const entry = relay.getConnectedSidecars().find((s: any) => s.agentUrl === to);
    expect(entry.observedFromIp).toBe('127.0.0.1');

    ws.close();
    await closed(ws);
  });
});

describe('two sidecars claiming one address', () => {
  it('names the conflict and replaces neither entry', async () => {
    const held = 'http://192.0.2.250:8098';
    const other = oldAddr();

    const incumbent = await connect();
    await register(incumbent, held, 'sidecar-incumbent');

    const challenger = await connect();
    await register(challenger, other, 'sidecar-challenger');

    // The challenger now claims the address the incumbent already holds.
    const ack = await register(challenger, held, 'sidecar-challenger');

    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/address-conflict/);
    expect(ack.error).toContain('sidecar-incumbent');

    // Neither side lost its entry — no silent replacement.
    const after = relay.getConnectedSidecars();
    expect(after.find((s: any) => s.agentUrl === held).hostname).toBe('sidecar-incumbent');
    expect(after.find((s: any) => s.agentUrl === other)).toBeDefined();

    incumbent.close(); challenger.close();
    await Promise.all([closed(incumbent), closed(challenger)]);
  });
});
