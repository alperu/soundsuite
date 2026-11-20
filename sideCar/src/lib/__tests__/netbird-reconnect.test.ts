/**
 * After the NetBird companion (re)starts, the sidecar reconnects master
 * sockets so they move onto the NetBird address. It used to drop EVERY socket
 * on EVERY helper start. Each master then registered again and pushed its
 * config again, which ran the orphan sweep again: a loop once a minute.
 *
 * Now: a new or changed NetBird IP drops every socket. The same IP drops only
 * the sockets opened while NetBird was down.
 */

jest.mock('../netbird-companion', () => {
  const actual = jest.requireActual('../netbird-companion');
  return { ...actual, reconcile: jest.fn(), readNetbirdStatus: jest.fn() };
});

import { state, ensureMaster } from '../state';
import { runReconcile } from '../netbird-runtime';
import * as companion from '../netbird-companion';

const reconcile = companion.reconcile as unknown as jest.Mock;
const readStatus = companion.readNetbirdStatus as unknown as jest.Mock;

const NB = 'ss-demo-netbird';
let ip = '100.64.0.10';
const terminated: string[] = [];

function report(st: string) {
  return { supported: true, reason: null, fqdn: 'demo.nb.example.com', netbird: { name: NB, state: st, error: null }, caddy: null };
}

function status() {
  return { connected: true, fqdn: 'demo.nb.example.com', ip, managementConnected: true, peersConnected: 1, peersTotal: 1, peers: [] };
}

/** An open master socket, opened now, with its local address if known. */
function open(url: string, localAddress?: string) {
  const m = ensureMaster(url);
  m.ws = { terminate: () => { terminated.push(url); m.ws = null; }, readyState: 1 } as never;
  m.wsOpenedAt = Date.now();
  m.wsLocalAddress = localAddress;
}

/** One reconcile with the helper in `st`, then the 5 s wait for the tunnel. */
async function tick(st: string) {
  reconcile.mockResolvedValueOnce(report(st));
  await runReconcile();
  await jest.advanceTimersByTimeAsync(5_000);
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(Date.parse('2026-01-01T10:00:00Z'));
  const G = (globalThis as Record<string, unknown>).__ss_sidecar__netbird as Record<string, unknown>;
  Object.assign(G, { lastIp: null, lastUpAt: null, reconnectPending: false, running: null, status: null, last: null });
  for (const url of [...state.masters.keys()]) state.masters.delete(url);
  terminated.length = 0;
  ip = '100.64.0.10';
  readStatus.mockReset();
  readStatus.mockImplementation(async () => status());
  reconcile.mockReset();
});

afterEach(() => { jest.useRealTimers(); });

describe('master sockets after a NetBird (re)start', () => {
  it('first start drops every socket', async () => {
    open('http://master-a.example:3000');
    open('http://master-b.example:3000');
    await tick('created');
    expect(terminated.sort()).toEqual(['http://master-a.example:3000', 'http://master-b.example:3000']);
  });

  it('a restart with the same IP keeps sockets already on the tunnel', async () => {
    open('http://master-a.example:3000');
    open('http://master-b.example:3000');
    await tick('created');
    // Both reconnect over the tunnel.
    open('http://master-a.example:3000');
    open('http://master-b.example:3000');
    terminated.length = 0;
    await jest.advanceTimersByTimeAsync(60_000);
    await tick('running');
    await jest.advanceTimersByTimeAsync(60_000);

    // The helper was stopped and started again; NetBird keeps its IP.
    await tick('started');
    expect(terminated).toEqual([]);
  });

  it('a restart with the same IP drops only sockets opened while NetBird was down', async () => {
    open('http://master-a.example:3000');
    await tick('created');
    open('http://master-a.example:3000');
    await jest.advanceTimersByTimeAsync(60_000);
    await tick('running');
    await jest.advanceTimersByTimeAsync(30_000);
    // NetBird goes down; a socket to a new master opens on the bridge address.
    open('http://master-b.example:3000');
    terminated.length = 0;
    await tick('restarted');
    expect(terminated).toEqual(['http://master-b.example:3000']);
  });

  it('two starts in a row keep sockets that reopened over the tunnel', async () => {
    open('http://master-a.example:3000');
    open('http://master-b.example:3000');
    await tick('created');
    // The sockets reopen about 1 s after the tunnel is confirmed up, over it.
    await jest.advanceTimersByTimeAsync(1_000);
    open('http://master-a.example:3000', ip);
    open('http://master-b.example:3000', `::ffff:${ip}`);
    terminated.length = 0;
    // The helper stops again before any reconcile sees it running.
    await jest.advanceTimersByTimeAsync(55_000);
    await tick('started');
    expect(terminated).toEqual([]);
  });

  it('two starts in a row still drop a socket opened off the tunnel', async () => {
    open('http://master-a.example:3000');
    await tick('created');
    await jest.advanceTimersByTimeAsync(1_000);
    open('http://master-a.example:3000', ip);
    await jest.advanceTimersByTimeAsync(30_000);
    // NetBird is down; this socket gets the Docker bridge address.
    open('http://master-b.example:3000', '172.17.0.5');
    terminated.length = 0;
    await jest.advanceTimersByTimeAsync(25_000);
    await tick('started');
    expect(terminated).toEqual(['http://master-b.example:3000']);
  });

  it('a new NetBird IP drops every socket', async () => {
    open('http://master-a.example:3000');
    await tick('created');
    open('http://master-a.example:3000');
    open('http://master-b.example:3000');
    await jest.advanceTimersByTimeAsync(60_000);
    await tick('running');
    terminated.length = 0;
    ip = '100.64.0.11';
    await tick('started');
    expect(terminated.sort()).toEqual(['http://master-a.example:3000', 'http://master-b.example:3000']);
  });

  it('no status after the wait drops every socket, as before', async () => {
    open('http://master-a.example:3000');
    await tick('created');
    open('http://master-a.example:3000');
    await jest.advanceTimersByTimeAsync(60_000);
    await tick('running');
    terminated.length = 0;
    readStatus.mockImplementation(async () => null);
    reconcile.mockResolvedValueOnce(report('started'));
    await runReconcile();
    await jest.advanceTimersByTimeAsync(24 * 5_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(terminated).toEqual(['http://master-a.example:3000']);
  });
});
