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

// eslint-disable-next-line @typescript-eslint/no-var-requires
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

beforeAll(() => { relay.startWsRelay(); });
afterAll(() => { relay.stopWsRelay(); });

describe('ws-relay socket accounting', () => {
  it('closes the superseded socket when a sidecar re-registers', async () => {
    const agent = nextAgent();
    const first = await connect();
    await register(first, agent);
    expect(relay.getRelaySocketCount()).toBe(1);

    // Same agentUrl, new socket — a forced reconnect.
    const second = await connect();
    await register(second, agent);

    // The previous socket must be closed, not merely dereferenced.
    await closed(first);
    expect(first.readyState).toBe(WsClient.CLOSED);
    expect(second.readyState).toBe(WsClient.OPEN);

    // And exactly one socket should remain — this is the count that used to
    // climb by one on every reconnect until the FD table was full.
    expect(relay.getRelaySocketCount()).toBe(1);

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

    // The property that matters: every superseded socket actually reaches CLOSED.
    // Before the fix these stayed OPEN forever — one leaked descriptor per
    // reconnect, which is what filled the FD table in production.
    await Promise.all(superseded.map(closed));
    for (const ws of superseded) expect(ws.readyState).toBe(WsClient.CLOSED);
    expect(live.readyState).toBe(WsClient.OPEN);

    // Only once the handshakes have drained is the relay's own count meaningful;
    // a socket mid-close is still in wss.clients and that is not a leak.
    expect(relay.getRelaySocketCount()).toBe(1);

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
