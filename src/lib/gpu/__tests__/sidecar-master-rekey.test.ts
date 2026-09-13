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
import http from 'http';
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

const { state, ensureMaster: rawEnsureMaster } = stateMod;

/**
 * Every MasterConnection this suite creates, so afterEach can retire ALL of them
 * — not just the ones still in `state.masters`. An orphan dropped from the map
 * keeps its own reconnect timer, and this suite's fake masters bind ephemeral
 * ports: a stale slot whose 60s reconnect fires after the OS has handed its port
 * to a later test's server would register on the wrong master and consume that
 * test's registration waiter. That is a test-harness leak, not a product bug, but
 * it makes the suite order-dependent.
 */
const created: MasterConnection[] = [];
function ensureMaster(url: string, opts?: { authToken?: string; wsPort?: number }): MasterConnection {
  const m: MasterConnection = rawEnsureMaster(url, opts);
  if (!created.includes(m)) created.push(m);
  return m;
}

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

  /** Mirror what the real master actually does on every register
   *  (`src/lib/gpu/ws-relay.ts:418-521`): close the superseded socket, ack, then
   *  push TWO frames — a `master-identity` carrying `canonicalUrl`, and an
   *  auto-`/config` carrying `serverUrl`. Task 42 named only the config push.
   *  `canonicalUrl = null` reproduces the master's
   *  "Skipped master-identity push: canonical URL unknown" branch. */
  pushIdentityAndConfig = false;
  canonicalUrl: string | null = null;

  readonly server: http.Server;

  private constructor(wss: WebSocketServer, server: http.Server) {
    this.wss = wss;
    this.server = server;
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
          if (this.pushIdentityAndConfig) {
            if (this.canonicalUrl) {
              sock.send(JSON.stringify({
                type: 'master-identity',
                canonicalUrl: this.canonicalUrl,
                wsPort: this.wsPort,
                pushedAt: Date.now(),
              }));
            }
            // What `pushFullConfig` actually sends, not just serverUrl: the
            // registry-rebuilding branch is the expensive one and the only one
            // that can populate modelChangedRoles and fire handleAcquire.
            sock.send(JSON.stringify({
              type: 'command',
              action: 'config',
              id: `auto-cfg-${Date.now()}`,
              serverUrl: this.canonicalUrl ?? undefined,
              idleTimeouts: { embedding: 5, completion: 5, ocr: 5, reranker: 5 },
              minOnline: { embedding: 1, completion: 0 },
              enabledModes: ['ss-embedding', 'ss-ocr'],
              modelOverrides: { 'ss-embedding': 'test-embed:1b' },
              runtimes: { 'ss-ocr': 'docker-ollama' },
            }));
          }
          const waiters = this.onRegister;
          this.onRegister = [];
          for (const w of waiters) w();
        }
      });
    });
  }

  /** When set, every HTTP response carries `X-Sound-Suite-Master-Url`, exactly as
   *  the real master does on heartbeat / poll / result replies. This is the header
   *  `absorbMasterUrlHeader` consumes. */
  headerUrl: string | null = null;
  httpHits = 0;

  static async start(port = 0): Promise<FakeMaster> {
    // Own http server so the sidecar's HTTP-gossip path has something to talk to:
    // a bare WebSocketServer answers 400 to every plain request, which makes the
    // heartbeat path untestable.
    const server = http.createServer();
    const self = { current: null as FakeMaster | null };
    server.on('request', (req, res) => {
      const fm = self.current;
      if (fm) {
        fm.httpHits++;
        if (fm.headerUrl) res.setHeader('X-Sound-Suite-Master-Url', fm.headerUrl);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, commands: [] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const wss = new WebSocketServer({ server, path: '/sidecar' });
    const fm = new FakeMaster(wss, server);
    self.current = fm;
    return fm;
  }

  get wsPort(): number {
    return (this.server.address() as { port: number }).port;
  }

  nextRegistration(): Promise<void> {
    return new Promise((r) => this.onRegister.push(r));
  }

  /**
   * Wait until at least `n` registrations have landed, by polling.
   *
   * Not a one-shot event: under parallel Jest workers the WS handshake can miss
   * `connectMaster`'s 5s connect timeout, which terminates the socket and falls
   * back to HTTP gossip before retrying. Registration then arrives a couple of
   * backoff steps later, and an awaited single event looks like a hang. Polling a
   * counter is indifferent to how many attempts it took.
   */
  async waitForRegistrations(n: number, timeoutMs = 25_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.registrations >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`only ${this.registrations} of ${n} registrations arrived`);
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
    await new Promise<void>((r) => this.server.close(() => r()));
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

// Several tests deliberately observe a multi-second backoff window, and the
// connect path can need a retry under parallel workers.
jest.setTimeout(90_000);

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
    try { wsClient.retireMaster(m); } catch { /* ignore */ }
  }
  for (const m of created) {
    try { wsClient.retireMaster(m); } catch { /* ignore */ }
  }
  created.length = 0;
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
  wsClient.connectMaster(mA);
  wsClient.connectMaster(mB);
  await Promise.all([masterA.waitForRegistrations(1), masterB.waitForRegistrations(1)]);
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
    await masterA.waitForRegistrations(1);
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

  it('does not ping-pong when both duplicate slots are started in the same tick', async () => {
    // `connectAllMasters()` walks every disconnected slot synchronously, so at
    // boot — with duplicates already in the persisted config — neither slot has
    // an open socket when the other is started. The endpoint claim has to be
    // taken before the socket opens for this to be caught.
    masterA.supersedeOnRegister = true;
    const m1: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    const m2: MasterConnection = ensureMaster(`${urlA}/alias`, { wsPort: masterA.wsPort });

    wsClient.connectMaster(m1);
    wsClient.connectMaster(m2);
    await sleep(5000);

    expect(masterA.registrations).toBe(1);
    // Exactly one of the two holds the socket; the other stood down.
    expect([m1.ws, m2.ws].filter((w) => w !== null)).toHaveLength(1);
  });

  it('a master-identity push does not create a second slot for itself', async () => {
    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);
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

describe('the live incident: the master\'s real two-frame push', () => {
  // Reproduces what `logs/dashboard.log` showed at 18:08 — register, close
  // superseded, push master-identity, auto-push /config, register again, several
  // cycles per second — starting from ONE configured slot, and explaining a
  // master count that sits FLAT (the operator's later log shows masters=2 not
  // dropping). The clobber is not the trigger; the identity push adding a second
  // slot is, and 1 → 2 → flat is exactly what that looks like.
  const CANON = 'http://master-canonical.invalid:3000';

  it('one configured slot stays one slot, and registers once', async () => {
    masterA.supersedeOnRegister = true;
    masterA.pushIdentityAndConfig = true;
    masterA.canonicalUrl = CANON;

    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);

    // Stand in for the 30s watchdog, which is what picks up a slot that was
    // added but never connected.
    for (let i = 0; i < 5; i++) {
      wsClient.connectAllMasters();
      await sleep(700);
    }

    expect(state.masters.size).toBe(1);
    expect(masterA.registrations).toBe(1);
    expect(mA.ws).not.toBeNull();
  });

  it('keeps the key that is working when the pushed serverUrl is unverified', async () => {
    masterA.supersedeOnRegister = true;
    masterA.pushIdentityAndConfig = true;
    masterA.canonicalUrl = CANON;

    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);
    await sleep(600);

    // The canonical URL the master pushes can come from the Host header of
    // whatever most recently hit it (src/lib/gpu/master-identity.ts), so it is
    // not a verified route to the master. Adopting it for a slot whose socket is
    // up trades a working address for an unverified one, and a wrong address
    // takes the host dark.
    expect(mA.serverUrl).toBe(urlA);
    expect(state.masters.has(CANON)).toBe(false);
    expect(mA.ws).not.toBeNull();
  });

  it('keeps the key that is working on the HTTP-gossip path too', async () => {
    // A slot in HTTP fallback has `ws === null` and is still connected on its
    // current key. `pollForCommands` routes `config` through the same handler, so
    // a gate that looked only at the socket would move exactly the host that is
    // already degraded and least able to recover.
    masterA.supersedeOnRegister = true;
    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);
    await sleep(200);

    const sock = [...masterA.sockets][0];
    mA.ws = null;
    mA.connectionMode = 'http';
    sock.send(JSON.stringify({
      type: 'command', action: 'config', id: 'http-cfg', serverUrl: CANON,
    }));
    await sleep(600);

    expect(mA.serverUrl).toBe(urlA);
    expect(state.masters.has(CANON)).toBe(false);
  });

  it('survives the master pushing no canonical URL at all', async () => {
    // The "Skipped master-identity push: canonical URL unknown" branch appeared
    // in the same burst as pushes that DID carry a URL.
    masterA.supersedeOnRegister = true;
    masterA.pushIdentityAndConfig = true;
    masterA.canonicalUrl = null;

    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);
    await sleep(2500);

    expect(state.masters.size).toBe(1);
    expect(masterA.registrations).toBe(1);
    expect(mA.serverUrl).toBe(urlA);
  });
});

describe('two masters on one host, one with no wsPort yet', () => {
  // The live fleet's shape: Sound Suite :3000/ws3002 and Fantom :3848/ws3003 on
  // ONE host. `serverHost` is identical for both slots, so the ws PORT is the only
  // thing separating their endpoints — and `m.wsPort ?? 3002` silently defaults a
  // slot with no wsPort onto Sound Suite's relay. wsPort arrives only in the
  // master-identity frame, so at first boot (or whenever a master cannot identify
  // itself) it is undefined for the whole connect window.
  // The decisive case: a master actually listening on the DEFAULT ws port, so a
  // slot with no wsPort lands on it. Skipped rather than failed if 3002 is busy —
  // a port conflict is not a verdict about the product.
  it('a slot with no wsPort is not dialled onto the default-port master', async () => {
    let defaultPortMaster: FakeMaster;
    try {
      defaultPortMaster = await FakeMaster.start(3002);
    } catch {
      console.warn('port 3002 unavailable — skipping the default-port collision test');
      return;
    }
    try {
      defaultPortMaster.supersedeOnRegister = true;
      // Slot 1 is the master on the default ws port (Sound Suite's relay).
      const onDefault: MasterConnection = ensureMaster('http://127.0.0.1:3000', { wsPort: 3002 });
      // Slot 2 is a DIFFERENT master on the SAME host whose wsPort is not known
      // yet — wsPort only ever arrives in a master-identity frame.
      const noPort: MasterConnection = ensureMaster('http://127.0.0.1:3848');
      expect(noPort.wsPort).toBeUndefined();

      wsClient.connectMaster(onDefault);
      wsClient.connectMaster(noPort);
      await sleep(4000);

      // `m.wsPort ?? 3002` makes these two slots compute the SAME wsUrl whenever
      // the masters share a host. Whichever slot loses that race ends up either
      // silent-but-"connected" or permanently stood down, and the master attributes
      // the survivor's heartbeats to the wrong master.
      expect(noPort.wsUrl).not.toBe(onDefault.wsUrl);
      // Nobody may report websocket without an armed heartbeat timer.
      for (const m of [onDefault, noPort]) {
        if (m.connectionMode === 'websocket') expect(m.heartbeatTimer).not.toBeNull();
      }
      expect(defaultPortMaster.registrations).toBeLessThanOrEqual(1);
    } finally {
      await defaultPortMaster.stop();
    }
  });

  it('a slot with no wsPort must not hijack a port another master holds', async () => {
    masterA.supersedeOnRegister = true;

    // masterA is reachable at an explicit wsPort. A SECOND master on the same host
    // has no wsPort yet, and `m.wsPort ?? 3002` would resolve it onto whichever
    // relay happens to sit on the default. Pin masterA's explicit port as the
    // default's stand-in by keying the no-port slot to the same host.
    const withPort: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(withPort);
    await masterA.waitForRegistrations(1);

    // Now a second master on the same host whose identity frame never arrived.
    const noPort: MasterConnection = ensureMaster(`http://127.0.0.1:${masterB.wsPort}`);
    expect(noPort.wsPort).toBeUndefined();
    // Make the default collide deterministically without binding the real 3002:
    // give the owner the port the no-port slot will compute.
    withPort.wsPort = 3002;
    withPort.wsUrl = 'ws://127.0.0.1:3002/sidecar';

    wsClient.connectMaster(noPort);
    await sleep(500);

    // It must refuse rather than dial another master's relay, and must say why.
    expect(noPort.wsUrl).toBeUndefined();
    expect(noPort.connectionMode).not.toBe('websocket');
    expect(noPort.connectionStatus).toContain('Needs wsPort');
    // And it keeps retrying — an absent wsPort is not a permanent condition; the
    // identity frame that supplies it may arrive at any time.
    expect(noPort.wsReconnectTimer).not.toBeNull();
    expect(noPort.retired).not.toBe(true);
  });
});

describe('the master self-identifying over HTTP', () => {
  // `absorbMasterUrlHeader` consumes `X-Sound-Suite-Master-Url` from EVERY
  // heartbeat / poll / result reply and calls `ensureMaster(normalized, {})` when
  // that URL is not already a key. The master has always sent that header, on every
  // version — so this path is alive on 2.3.77, .78 and .79 alike, and it is a fifth
  // instance of the same defect class as `rekeyMaster` and `master-identity`:
  // one master, more than one slot.
  //
  // The slot it adds has NO wsPort, so `m.wsPort ?? 3002` dials it at the default —
  // the same endpoint the original slot uses whenever the master is Sound Suite.
  const CANON = 'http://master-canonical.invalid:3000';

  it('does not add a second slot for a master it is already connected to', async () => {
    masterA.supersedeOnRegister = true;
    masterA.pushIdentityAndConfig = true;
    masterA.canonicalUrl = null;      // identity frame absent, as in the field
    masterA.headerUrl = CANON;        // but the HTTP header still self-identifies

    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);

    // Drive the HTTP path the header rides on.
    await wsClient.__testSendHttpHeartbeat(mA);
    await sleep(300);

    expect(masterA.httpHits).toBeGreaterThan(0);
    expect(state.masters.size).toBe(1);
    expect(state.masters.has(CANON)).toBe(false);
  });

  it('one master stays one register across the auto-push + supersede pair', async () => {
    // The pair the team lead asked to isolate: `Auto-pushed config on register` is
    // original, `Closing superseded sidecar socket` is one day old. Neither alone
    // nor together may sustain re-registration.
    masterA.supersedeOnRegister = true;
    masterA.pushIdentityAndConfig = true;
    masterA.canonicalUrl = CANON;
    masterA.headerUrl = CANON;

    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);

    for (let i = 0; i < 4; i++) {
      await wsClient.__testSendHttpHeartbeat(mA);
      wsClient.connectAllMasters();
      await sleep(1200);
    }

    expect(state.masters.size).toBe(1);
    expect(masterA.registrations).toBe(1);
  });

  it('sends a heartbeat as soon as it registers, so lastHeartbeatAt is never null', async () => {
    // The operator's visible symptom: `connectionMode: 'websocket'`,
    // `lastHeartbeatAt: None`, `consecutiveFailures: 0` — all three simultaneously
    // "true". The heartbeat timer IS armed in the open handler, but it is a 5s
    // interval that every new socket RESETS, so a connection that is superseded
    // more often than every 5s never fires it once. Registering and then saying
    // nothing is worse than reporting disconnected, because the master believes
    // the host is live. Heartbeat immediately on register.
    masterA.supersedeOnRegister = true;
    const mA: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(mA);
    await masterA.waitForRegistrations(1);
    await sleep(900);

    expect(mA.connectionMode).toBe('websocket');
    expect(mA.lastHeartbeatAt).toBeTruthy();
  });
});

describe('a multi-homed master reached at two different addresses', () => {
  // The fleet's real shape: masters answer on a LAN address AND a Tailscale
  // address. `discoverMasters()` (config.ts) probes candidates and keys a slot by
  // exact URL string for each one that answers, and `POST /api/masters` (the
  // master's own reverse-poll channel) does the same — so ONE master becomes TWO
  // slots whose dialled endpoints differ by HOSTNAME. No string comparison of
  // endpoints can catch that; only the master's own `canonicalUrl` can.
  it('retires the duplicate once both slots hear the same canonical URL', async () => {
    masterA.supersedeOnRegister = true;
    masterA.pushIdentityAndConfig = true;
    masterA.canonicalUrl = 'http://master-canonical.invalid:3000';

    // Two keys for one listener, reached by two different host spellings.
    const viaLan: MasterConnection = ensureMaster(`http://127.0.0.1:${masterA.wsPort}`, { wsPort: masterA.wsPort });
    const viaVpn: MasterConnection = ensureMaster(`http://localhost:${masterA.wsPort}`, { wsPort: masterA.wsPort });
    // Different dial endpoints — the endpoint guard cannot see these as one master.
    expect(new URL(viaLan.serverUrl).hostname).not.toBe(new URL(viaVpn.serverUrl).hostname);

    wsClient.connectMaster(viaLan);
    await masterA.waitForRegistrations(1);
    wsClient.connectMaster(viaVpn);
    await sleep(3000);

    // Exactly one slot survives, and it is not churning.
    const live = [viaLan, viaVpn].filter((x) => !x.retired && state.masters.get(x.serverUrl) === x);
    expect(live).toHaveLength(1);
    expect(live[0].ws).not.toBeNull();
    const settled = masterA.registrations;
    await sleep(2500);
    expect(masterA.registrations).toBe(settled);
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

describe('one master, one socket', () => {
  it('connectMaster on an already-connected slot does not open a second socket', async () => {
    // The root defect behind the fleet-wide reconnect loop. connectMaster checked
    // only `m.retired`, so any caller could open a second socket, and the open
    // handler's `m.ws = ws` then discarded the only reference to the first. That
    // orphan could be closed by nobody but the master — which is why masters grew
    // a supersede close, why closing it fed a ~1.1s loop, and why 10,196 sockets
    // once accumulated from a single host.
    const m: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(m);
    await masterA.waitForRegistrations(1);
    const firstSocket = m.ws;

    // Call it again, repeatedly, exactly as scheduleReconnect would.
    wsClient.connectMaster(m);
    wsClient.connectMaster(m);
    wsClient.connectMaster(m);
    await sleep(600);

    // One registration total, and the same socket object throughout: no second
    // socket was created, so there is no orphan for anyone to clean up.
    expect(masterA.registrations).toBe(1);
    expect(m.ws).toBe(firstSocket);
    expect(m.ws?.readyState).toBe(1); // OPEN
  });

  it('still reconnects after the socket genuinely closes', async () => {
    // The guard must not wedge the slot shut — a dead socket has to be replaceable,
    // or a host never recovers from a real disconnect.
    const m: MasterConnection = ensureMaster(urlA, { wsPort: masterA.wsPort });
    wsClient.connectMaster(m);
    await masterA.waitForRegistrations(1);

    m.ws?.close();
    await settle(() => masterA.registrations >= 2, 'reconnect after a real close', 8000);
    expect(masterA.registrations).toBeGreaterThanOrEqual(2);
  });
});
