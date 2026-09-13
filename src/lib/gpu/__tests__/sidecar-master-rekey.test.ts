/**
 * @jest-environment node
 *
 * Task 42 — a config-push rekey clobbers a master slot.
 *
 * This suite drives the REAL sidecar gossip client (`sideCar/src/lib/ws-client.ts`)
 * against two fake masters and makes one of them push a `serverUrl` equal to the
 * other's map key. It exists to establish the mechanism before anything is fixed:
 * which object is orphaned, whether its socket survives, and what re-arms the
 * reconnect.
 *
 * It deliberately does NOT use `src/lib/gpu/ws-relay.ts` — the master here is a
 * bare `ws.Server`, so the relay's `globalThis` cache is untouched and this suite
 * cannot collide with the other relay suites in this directory. Socket-count
 * style assertions still poll rather than sampling instantaneously (`settle()`),
 * because a client-side `close` lands before the server drops the connection.
 *
 * Addresses are loopback only; hostnames are invented. Nothing here is written
 * into `sideCar/`, which is published publicly.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';

// Both are read at module scope by sideCar/src/lib/config.ts — set before import.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-rekey-'));
process.env.CONFIG_PATH = path.join(TMP, 'config.json');
process.env.RECENT_MASTERS_PATH = path.join(TMP, 'recent-masters.json');
// Pin the advertised address so getAgentUrl() never walks real interfaces.
process.env.AGENT_URL = 'http://sidecar-host.invalid:8098';

/* eslint-disable @typescript-eslint/no-var-requires */
const stateMod = require('../../../../sideCar/src/lib/state');
const wsClient = require('../../../../sideCar/src/lib/ws-client');
/* eslint-enable @typescript-eslint/no-var-requires */

type MasterConnection = import('../../../../sideCar/src/lib/state').MasterConnection;

const { state, ensureMaster } = stateMod;

/** A fake master: a WS server that acks `register` and can push commands. */
class FakeMaster {
  readonly wss: WebSocketServer;
  readonly sockets = new Set<WsServerSocket>();
  registrations = 0;
  private onRegister: (() => void)[] = [];

  /** Mirror `src/lib/gpu/ws-relay.ts:418-421`: a re-register closes the socket
   *  the previous registration was using (close code 1012). Off by default so
   *  the collision tests above measure the sidecar alone. */
  supersedeOnRegister = false;
  private registered: WsServerSocket | null = null;

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on('connection', (sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      sock.on('message', (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'register') {
          this.registrations++;
          if (this.supersedeOnRegister && this.registered && this.registered !== sock) {
            try { this.registered.close(1012, 'superseded-by-new-registration'); } catch { /* ignore */ }
          }
          this.registered = sock;
          sock.send(JSON.stringify({ type: 'registered', serverVersion: '0.0.0-test' }));
          const waiters = this.onRegister;
          this.onRegister = [];
          for (const w of waiters) w();
        }
      });
    });
  }

  static async start(): Promise<FakeMaster> {
    const wss = new WebSocketServer({ port: 0, path: '/sidecar' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    return new FakeMaster(wss);
  }

  get wsPort(): number {
    return (this.wss.address() as { port: number }).port;
  }

  nextRegistration(): Promise<void> {
    return new Promise((r) => this.onRegister.push(r));
  }

  /** Push a `config` command down the first live socket. */
  pushConfig(payload: Record<string, unknown>): void {
    const sock = [...this.sockets][0];
    if (!sock) throw new Error('fake master has no live socket');
    sock.send(JSON.stringify({ type: 'command', action: 'config', id: `cfg-${Date.now()}`, ...payload }));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) { try { s.terminate(); } catch { /* ignore */ } }
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

/** Poll until `fn` is true, or throw. Never assert a connection count instantly. */
async function settle(fn: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition never settled: ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let masterA: FakeMaster;
let masterB: FakeMaster;
let urlA: string;
let urlB: string;

beforeEach(async () => {
  masterA = await FakeMaster.start();
  masterB = await FakeMaster.start();
  // Distinct map keys; the WS port is what actually routes.
  urlA = `http://127.0.0.1:${masterA.wsPort}`;
  urlB = `http://127.0.0.1:${masterB.wsPort}`;
  state.masters.clear();
});

afterEach(async () => {
  for (const m of [...state.masters.values()] as MasterConnection[]) {
    try { wsClient.disconnectMaster(m); } catch { /* ignore */ }
  }
  state.masters.clear();
  await masterA.stop();
  await masterB.stop();
  await sleep(50);
});

afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function connectBoth(): Promise<{ mA: MasterConnection; mB: MasterConnection }> {
  const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
  const mB: MasterConnection = ensureMaster(urlB, { wsPort: masterB.wsPort });
  const regA = masterA.nextRegistration();
  const regB = masterB.nextRegistration();
  wsClient.connectMaster(mA);
  wsClient.connectMaster(mB);
  await Promise.all([regA, regB]);
  return { mA, mB };
}

describe('config-push rekey onto an occupied slot', () => {
  it('does not silently drop the master that already held the destination URL', async () => {
    const { mA, mB } = await connectBoth();
    expect(state.masters.size).toBe(2);

    // Master A pushes a serverUrl that is already master B's key.
    masterA.pushConfig({ serverUrl: urlB });
    await sleep(400);

    // The whole point: no slot may vanish without an operator action.
    expect(state.masters.size).toBe(2);
    // And B's live connection must still be the object reachable at B's key.
    expect(state.masters.get(urlB)).toBe(mB);
    expect(mB.ws).not.toBeNull();
    expect(mA.serverUrl).toBe(urlA);
  });

  it('leaves no MasterConnection outside the map with a live socket or timers', async () => {
    const { mA, mB } = await connectBoth();
    masterA.pushConfig({ serverUrl: urlB });
    await sleep(400);

    for (const m of [mA, mB]) {
      const inMap = state.masters.get(m.serverUrl) === m;
      if (inMap) continue;
      // An orphan is only acceptable if it is fully torn down.
      expect(m.ws).toBeNull();
      expect(m.heartbeatTimer).toBeNull();
      expect(m.pollTimer).toBeNull();
      expect(m.wsReconnectTimer).toBeNull();
    }
  });

  it('does not put the sidecar into a reconnect loop against the destination master', async () => {
    const { mB } = await connectBoth();
    const registrationsBefore = masterB.registrations;

    masterA.pushConfig({ serverUrl: urlB });
    // Reconnect backoff starts at 1s; two seconds covers at least one cycle.
    await sleep(2200);

    // A healthy fleet stays up: one config push must not re-register anybody.
    expect(masterB.registrations).toBe(registrationsBefore);
    expect(mB.ws).not.toBeNull();
  });
});

describe('the reconnect loop', () => {
  // The task doc infers the loop from the rekey collision alone. The Fantom
  // master's own source records the opposite: 221 reconnects / 90 s measured
  // with EXACTLY ONE master entry per sidecar, where no collision is possible
  // (see FANTOM_SIDECAR_SUPERSEDED_GRACE_MS). These two tests separate the
  // claims: does a single master that supersedes on re-register loop on its
  // own, and does the collision loop once the master closes the loser?
  it('a single master that closes superseded sockets does not loop on its own', async () => {
    masterA.supersedeOnRegister = true;
    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    const reg = masterA.nextRegistration();
    wsClient.connectMaster(mA);
    await reg;

    await sleep(3000);
    // One connect = one register. Anything more is a reconnect cycle.
    expect(masterA.registrations).toBe(1);
  });

  it('the collision does not drive repeated re-registration once the loser is closed', async () => {
    masterB.supersedeOnRegister = true;
    const { mA, mB } = await connectBoth();
    void mA; void mB;
    const before = masterB.registrations;

    masterA.pushConfig({ serverUrl: urlB });
    // Backoff starts at 1s and doubles; 4s covers two cycles if it loops.
    await sleep(4000);

    expect(masterB.registrations).toBe(before);
  });
});

describe('two slots that are aliases of one master', () => {
  // The realistic shape behind `masters=3`: the same master reachable under two
  // keys (a LAN address and a canonical name), so BOTH slots register on it.
  // The master supersedes per agentUrl, not per slot, so each slot's register
  // closes the other's socket — and each close schedules its own reconnect.
  it('does not ping-pong supersede between the two slots', async () => {
    masterA.supersedeOnRegister = true;
    // Two distinct keys, one listener: `/alias` differs as a key but resolves to
    // the same host, and both carry the same wsPort.
    const mCanon: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    const mAlias: MasterConnection = ensureMaster(`${urlA}/alias`, { wsPort: masterA.wsPort });

    wsClient.connectMaster(mCanon);
    await masterA.nextRegistration();
    expect(masterA.registrations).toBe(1);

    // The alias must not open a second socket to a master we are already
    // connected to: the master supersedes per agentUrl, so the two slots would
    // close each other's sockets and each close would schedule its own
    // reconnect. Before the fix this measured 6 registrations in 5 s.
    wsClient.connectMaster(mAlias);
    await sleep(5000);
    expect(masterA.registrations).toBe(1);
    expect(mAlias.ws).toBeNull();
    expect(mCanon.ws).not.toBeNull();
    expect(mAlias.connectionStatus).toContain('Duplicate of');
  });

  it('a master-identity push does not create a second slot for itself', async () => {
    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.nextRegistration();
    expect(state.masters.size).toBe(1);

    // The canonical URL differs from the slot key by more than a trailing
    // slash, which is the only case the current rekey branch handles.
    const sock = [...masterA.sockets][0];
    sock.send(JSON.stringify({
      type: 'master-identity',
      canonicalUrl: 'http://master-canonical.invalid:3000',
      wsPort: masterA.wsPort,
    }));
    await sleep(400);

    // One master announcing itself must never become two slots — that is the
    // duplicate that drives the supersede ping-pong above.
    expect(state.masters.size).toBe(1);
  });
});

describe('disconnectMaster', () => {
  it('does not re-arm a reconnect for the master it just disconnected', async () => {
    const { mA } = await connectBoth();
    const before = masterA.registrations;

    wsClient.disconnectMaster(mA);
    state.masters.delete(mA.serverUrl);

    // The close event from disconnectMaster's own ws.close() is async; the
    // handler runs after m.ws has already been nulled.
    await sleep(1500);
    expect(mA.wsReconnectTimer).toBeNull();
    expect(mA.pollTimer).toBeNull();
    expect(masterA.registrations).toBe(before);
  });
});

describe('reconnect ownership', () => {
  it('a scheduled reconnect for an object no longer holding its key does nothing', async () => {
    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    const reg = masterA.nextRegistration();
    wsClient.connectMaster(mA);
    await reg;

    // Simulate the post-collision shape directly: a second object now owns
    // mA's key, and mA is referenced by nothing.
    const impostor: MasterConnection = { ...mA, ws: null, heartbeatTimer: null, pollTimer: null, wsReconnectTimer: null };
    state.masters.set(mA.serverUrl, impostor);

    const before = masterA.registrations;
    mA.wsReconnectDelay = 100;
    wsClient.scheduleReconnect(mA);
    await sleep(600);

    // The guard in scheduleReconnect is `state.masters.has(m.serverUrl)` — a
    // KEY check. Identity is what matters: mA is not the map's entry.
    expect(masterA.registrations).toBe(before);

    try { wsClient.disconnectMaster(impostor); } catch { /* ignore */ }
    try { wsClient.disconnectMaster(mA); } catch { /* ignore */ }
    await settle(() => mA.ws === null, 'orphan socket closed');
  });
});
