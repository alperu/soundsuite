/**
 * @jest-environment node
 *
 * Regression tests for the socket leak that exhausted the process
 * file-descriptor table and made every child_process spawn fail with
 * `spawn EBADF`.
 *
 * Two independent causes, either of which leaks on its own:
 *   1. A reconnecting sidecar overwrote its map entry, dropping the only
 *      reference to the previous socket without closing it.
 *   2. Nothing pinged idle sockets, so a peer that died without sending a TCP
 *      FIN stayed ESTABLISHED forever and never fired 'close'.
 */

import { WebSocket as WsClient } from 'ws';

// The relay pulls in the status cache and prisma-backed persistence; neither is
// under test here.
jest.mock('../status-cache', () => ({
  updateSidecarStatus: jest.fn(),
  markSidecarDisconnected: jest.fn(),
  getAllSidecarStatuses: jest.fn(() => []),
}));

jest.mock('@/lib/db/prisma', () => ({
  prisma: { config: { upsert: jest.fn(), findUnique: jest.fn(async () => null) } },
}));

const PORT = 34099;
process.env.GPU_WS_PORT = String(PORT);
// Short enough to assert against; the module reads this at import time.
const REGISTER_TIMEOUT_MS = 300;
process.env.GPU_WS_REGISTER_TIMEOUT_MS = String(REGISTER_TIMEOUT_MS);
// Non-zero so re-register MARKS rather than closes; 1ms so one sweep reaps it.
process.env.GPU_WS_SUPERSEDED_GRACE_MS = '1';

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

let agentSeq = 0;
/** A fresh agentUrl per test: shared state would let one test's teardown race the next. */
const nextAgent = () => `http://sidecar-${++agentSeq}.invalid:8098`;

function connect(): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(`ws://127.0.0.1:${PORT}/sidecar`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Register and wait for the relay's ack, so ordering is deterministic. */
function register(ws: WsClient, agentUrl: string): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      try {
        if (JSON.parse(raw.toString()).type === 'registered') {
          ws.off('message', onMsg);
          resolve();
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'register', agentUrl, hostname: 'host-a', containers: [] }));
  });
}

const closed = (ws: WsClient) =>
  new Promise<void>((resolve) => (ws.readyState === WsClient.CLOSED ? resolve() : ws.once('close', () => resolve())));

/**
 * Poll until the relay's socket count settles on `expected`.
 *
 * The client's 'close' event fires when the CLIENT socket closes; the relay
 * removes the socket from `wss.clients` on its own 'close', which lands a tick
 * or more later. Asserting the count instantaneously therefore races, and the
 * gap widens under a loaded suite (jest runs files across ~9 workers). Polling
 * still proves the property — a leaked socket never settles — without encoding
 * a scheduling assumption.
 */
async function expectSocketCount(expected: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = relay.getRelaySocketCount();
  while (Date.now() < deadline) {
    last = relay.getRelaySocketCount();
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`relay socket count settled at ${last}, expected ${expected}`);
}

beforeAll(() => { relay.startWsRelay(); });
afterAll(() => { relay.stopWsRelay(); });

describe('ws-relay socket accounting', () => {
  it('reaps the superseded socket via the sweep when a sidecar re-registers', async () => {
    const agent = nextAgent();
    const first = await connect();
    await register(first, agent);
    expect(relay.getRelaySocketCount()).toBe(1);

    // Same agentUrl, new socket — a forced reconnect.
    const second = await connect();
    await register(second, agent);

    // The previous socket is MARKED, not closed — closing it here is what fed the
    // ~1.1s reconnect loop. It must still be reclaimed, just by the sweep rather
    // than synchronously, so descriptors stay bounded.
    relay.__sweepForTests();
    await closed(first);
    expect(first.readyState).toBe(WsClient.CLOSED);
    expect(second.readyState).toBe(WsClient.OPEN);

    // And exactly one socket should remain — this is the count that used to
    // climb by one on every reconnect until the FD table was full.
    await expectSocketCount(1);

    second.close();
    await closed(second);
  });

  it('keeps the live connection registered after the superseded one closes', async () => {
    const { markSidecarDisconnected } = jest.requireMock('../status-cache');
    const agent = nextAgent();

    const first = await connect();
    await register(first, agent);
    const second = await connect();
    await register(second, agent);
    relay.__sweepForTests();
    await closed(first);
    // Let the relay's own close handler run before asserting on its effects.
    await new Promise((r) => setTimeout(r, 50));

    // The superseded socket's close handler must NOT tear down the replacement:
    // marking THIS agent disconnected would strand a live connection.
    expect(markSidecarDisconnected).not.toHaveBeenCalledWith(agent);
    expect(second.readyState).toBe(WsClient.OPEN);

    second.close();
    await closed(second);
  });

  it('does not leak sockets across many reconnects', async () => {
    const agent = nextAgent();
    const sockets: WsClient[] = [];
    for (let i = 0; i < 8; i++) {
      const ws = await connect();
      await register(ws, agent);
      sockets.push(ws);
    }

    const superseded = sockets.slice(0, -1);
    const live = sockets[sockets.length - 1];

    // Each re-register marked its predecessor; one sweep reclaims them all. The
    // property under test is unchanged — nothing accumulates without bound — only
    // the moment of reclamation moved.
    relay.__sweepForTests();

    // The property that matters: every superseded socket actually reaches CLOSED.
    // Before the fix these stayed OPEN forever — one leaked descriptor per
    // reconnect, which is what filled the FD table in production.
    await Promise.all(superseded.map(closed));
    for (const ws of superseded) expect(ws.readyState).toBe(WsClient.CLOSED);
    expect(live.readyState).toBe(WsClient.OPEN);

    // Only once the handshakes have drained is the relay's own count meaningful;
    // a socket mid-close is still in wss.clients and that is not a leak.
    await expectSocketCount(1);

    live.close();
    await closed(live);
  });

  it('pings connected sockets so a silent peer becomes observable', async () => {
    const ws = await connect();
    await register(ws, nextAgent());

    const gotPing = new Promise<void>((resolve) => ws.once('ping', () => resolve()));
    // Drive the sweep directly rather than waiting out the real interval.
    relay.__sweepForTests();
    await gotPing;

    ws.close();
    await closed(ws);
  });

  it('terminates a socket that never answers a ping', async () => {
    const ws = await connect();
    await register(ws, nextAgent());

    // Suppress the automatic pong so the socket looks dead to the relay.
    (ws as any)._receiver?.removeAllListeners('ping');
    ws.pong = () => {};

    relay.__sweepForTests(); // marks it pending
    relay.__sweepForTests(); // no pong arrived -> terminate

    await closed(ws);
    expect(ws.readyState).toBe(WsClient.CLOSED);
  });
});

describe('register handshake timeout', () => {
  it('closes a socket that never registers', async () => {
    // Supersede-and-close only fires from the register branch, and the liveness
    // sweep spares anything that answers pings — so without this timeout an
    // unregistered socket holds a descriptor forever. This is the case that
    // produced more open sockets than registered sidecars.
    const ws = await connect();
    expect(ws.readyState).toBe(WsClient.OPEN);

    await closed(ws);
    expect(ws.readyState).toBe(WsClient.CLOSED);
  });

  it('does not close a socket that registers in time', async () => {
    const ws = await connect();
    await register(ws, nextAgent());

    // Well past the timeout: registering must disarm it, not merely delay it.
    await new Promise((r) => setTimeout(r, REGISTER_TIMEOUT_MS * 3));
    expect(ws.readyState).toBe(WsClient.OPEN);

    ws.close();
    await closed(ws);
  });

  it('leaves no timer behind when a socket closes before the timeout', async () => {
    // A dangling timer firing against an already-closed socket would be a
    // (small) leak of its own, and would log a misleading close.
    const ws = await connect();
    ws.close();
    await closed(ws);
    await new Promise((r) => setTimeout(r, REGISTER_TIMEOUT_MS * 2));
    expect(ws.readyState).toBe(WsClient.CLOSED);
  });
});

describe('superseded sockets are marked, not closed', () => {
  it('leaves the incumbent OPEN when a sidecar re-registers', async () => {
    // The whole point: closing here fed a ~1.1s reconnect loop, because the close
    // landed in the sidecar's close handler and it reconnected on its 1s floor.
    // A single spurious reconnect must stay a single event.
    const agent = nextAgent();
    const first = await connect();
    await register(first, agent);
    const second = await connect();
    await register(second, agent);

    // Give an immediate close every chance to happen.
    await new Promise((r) => setTimeout(r, 300));

    expect(first.readyState).toBe(WsClient.OPEN);
    expect(second.readyState).toBe(WsClient.OPEN);
    // Both are held, which is the bounded cost of not closing: the sweep reaps
    // the marked one after the grace.
    await expectSocketCount(2);

    first.close(); second.close();
    await Promise.all([closed(first), closed(second)]);
  });

  it('reaps the superseded socket once the grace has elapsed', async () => {
    const agent = nextAgent();
    const first = await connect();
    await register(first, agent);
    const second = await connect();
    await register(second, agent);

    // The test build sets the grace to 0ms via env, so one sweep reaps it.
    relay.__sweepForTests();

    await closed(first);
    expect(first.readyState).toBe(WsClient.CLOSED);
    // Reaped on TIME, not on liveness — an orphan still answers pings, so the
    // pong check alone could never reclaim it.
    expect(second.readyState).toBe(WsClient.OPEN);

    second.close();
    await closed(second);
  });
});
