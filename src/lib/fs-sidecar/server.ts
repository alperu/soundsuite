/**
 * Master side of the fileSystemSideCar link (direction (b): the sidecar
 * connects to SoundSuite). Mirrors `crates/sidecar-link/src/server.rs`:
 *
 *   POST /v1/login   Login envelope -> LoginReply (session token + key)
 *   GET  /v1/ws      signed upgrade; one FlatBuffers envelope per WS message
 *   POST /v1/send    signed; packed frames in, reply frames out (HTTP fallback)
 *   GET  /v1/poll    signed; long poll for master -> sidecar frames
 *   GET  /v1/health  JSON
 *
 * The sidecar uses the `folder-status` profile: each `FolderStatBatch` is
 * stored, then confirmed with `Ack { seq }`. Pings are answered and recorded
 * as heartbeats. A plain Node HTTP server (like `gpu/ws-relay.ts`), because
 * Next route handlers cannot take a WebSocket upgrade.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import * as flatbuffers from 'flatbuffers';
import {
  CONTENT_TYPE,
  MAX_BODY_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  decodeBody,
  decodeSingle,
  encodeAck,
  encodeBody,
  encodeLoginReply,
  encodePing,
  frameIn,
  frameOut,
  parseEnvelope,
} from './codec';
import { AuthPolicy, DEFAULT_POLICY, LoginGuard, Sessions, checkPassword, partsFromHeaders } from './auth';
import { Message } from './proto/sidecar/message';
import { Login } from './proto/sidecar/login';
import { Hello } from './proto/sidecar/hello';
import { Status } from './proto/sidecar/status';
import { FolderStatBatch } from './proto/sidecar/folder-stat-batch';
import { Envelope } from './proto/sidecar/envelope';
import { Profile } from './proto/sidecar/profile';
import type { FolderStatRow, FolderStatStore } from './folder-store';
import { getFsSidecar, upsertFsSidecar } from './status';

export interface FsLinkOptions {
  port?: number;
  host?: string;
  /** username -> password (plain or `scrypt$salt$hash`, see `hashPassword`). */
  credentials: Record<string, string>;
  store: FolderStatStore;
  serverVersion?: string;
  policy?: AuthPolicy;
  pingEveryMs?: number;
  deadAfterMs?: number;
  pollWaitMs?: number;
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}

export interface FsLinkServer {
  port: number;
  close(): Promise<void>;
}

const MAX_LOGIN_BODY = 64 * 1024;
const PROFILE_NAMES: Record<number, string> = {
  [Profile.Metadata]: 'metadata',
  [Profile.FolderStatus]: 'folder-status',
  [Profile.Content]: 'content',
  [Profile.Mirror]: 'mirror',
};

interface Link {
  sidecarId: string;
  username: string;
  ws?: WebSocket;
  queue: Uint8Array[];
  waiters: Array<() => void>;
  /** Frames of one link are handled in order, so Acks stay in seq order. */
  chain: Promise<unknown>;
}

function encodeHello(msgId: bigint, version: string): Uint8Array {
  const b = new flatbuffers.Builder(128);
  const id = b.createString('soundsuite');
  const v = b.createString(version);
  const os = b.createString(process.platform);
  const profiles = Hello.createProfilesVector(b, [Profile.FolderStatus]);
  const h = Hello.createHello(b, PROTOCOL_VERSION, id, v, os, profiles);
  const e = Envelope.createEnvelope(b, msgId, BigInt(0), 0, Message.Hello, h);
  Envelope.finishEnvelopeBuffer(b, e);
  return b.asUint8Array().slice();
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new Error('body over the limit'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const isZstd = (req: http.IncomingMessage) => String(req.headers['content-encoding'] || '').toLowerCase() === 'zstd';

function reply(res: http.ServerResponse, code: number, body: Uint8Array, zstd = false): void {
  const h: Record<string, string | number> = { 'content-type': CONTENT_TYPE, 'content-length': body.length };
  if (zstd) h['content-encoding'] = 'zstd';
  res.writeHead(code, h);
  res.end(Buffer.from(body));
}

function text(res: http.ServerResponse, code: number, msg: string): void {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(msg);
}

export function startFsSidecarLink(opts: FsLinkOptions): Promise<FsLinkServer> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const sessions = new Sessions(policy);
  const guard = new LoginGuard(policy);
  const version = opts.serverVersion ?? 'soundsuite';
  const pingEvery = opts.pingEveryMs ?? 30_000;
  const deadAfter = opts.deadAfterMs ?? 90_000;
  const pollWait = opts.pollWaitMs ?? 25_000;
  const log = opts.log ?? (() => {});
  const links = new Map<string, Link>();
  let nextId = BigInt(1);
  const msgId = () => nextId++;

  const linkFor = (sidecarId: string, username: string): Link => {
    let l = links.get(sidecarId);
    if (!l) {
      l = { sidecarId, username, queue: [], waiters: [], chain: Promise.resolve() };
      links.set(sidecarId, l);
    }
    return l;
  };

  /** Master -> sidecar frame: on the WS when it is open, else queued for /v1/poll. */
  const deliver = (l: Link, env: Uint8Array) => {
    if (l.ws && l.ws.readyState === WebSocket.OPEN) {
      l.ws.send(frameOut(env));
      return;
    }
    l.queue.push(env);
    for (const w of l.waiters.splice(0)) w();
  };

  /** One envelope from the sidecar -> reply envelopes. */
  async function handle(l: Link, env: Uint8Array): Promise<Uint8Array[]> {
    let e: Envelope;
    try {
      e = parseEnvelope(env);
    } catch (err) {
      log('warn', 'fs-sidecar: bad envelope', { sidecarId: l.sidecarId, error: (err as Error).message });
      return [];
    }
    const now = Date.now();
    upsertFsSidecar(l.sidecarId, { username: l.username, lastSeenAt: now });
    switch (e.messageType()) {
      case Message.Ping:
        upsertFsSidecar(l.sidecarId, { username: l.username, lastHeartbeatAt: now });
        return e.replyTo() === BigInt(0) ? [encodePing(msgId(), e.msgId())] : [];
      case Message.Hello: {
        const h = e.message(new Hello()) as Hello | null;
        if (h) {
          const profiles: string[] = [];
          for (let i = 0; i < h.profilesLength(); i++) {
            const p = h.profiles(i);
            if (p !== null) profiles.push(PROFILE_NAMES[p] ?? String(p));
          }
          upsertFsSidecar(l.sidecarId, { username: l.username, version: h.version() ?? undefined, os: h.os() ?? undefined, profiles });
        }
        return [];
      }
      case Message.Status: {
        const s = e.message(new Status()) as Status | null;
        if (s) upsertFsSidecar(l.sidecarId, { username: l.username, queueLen: s.queueLen(), version: s.version() ?? getFsSidecar(l.sidecarId)?.version });
        return [];
      }
      case Message.FolderStatBatch: {
        const b = e.message(new FolderStatBatch()) as FolderStatBatch | null;
        if (!b) return [];
        const rows: FolderStatRow[] = [];
        for (let i = 0; i < b.statsLength(); i++) {
          const s = b.stats(i);
          if (!s) continue;
          rows.push({
            root: s.root() ?? '',
            path: s.path() ?? '',
            fileCount: Number(s.fileCount()),
            totalBytes: s.totalBytes(),
            latestMtimeNs: s.latestMtimeNs(),
            dirCount: Number(s.dirCount()),
            recFileCount: Number(s.recFileCount()),
            recTotalBytes: s.recTotalBytes(),
            recLatestMtimeNs: s.recLatestMtimeNs(),
            deleted: s.deleted(),
          });
        }
        try {
          await opts.store.applyBatch(l.sidecarId, rows);
        } catch (err) {
          // No Ack: the sidecar keeps the batch and sends it again.
          log('warn', 'fs-sidecar: store failed', { sidecarId: l.sidecarId, error: (err as Error).message });
          return [];
        }
        const seq = b.seq();
        const cur = getFsSidecar(l.sidecarId)?.confirmedSeq ?? 0;
        upsertFsSidecar(l.sidecarId, { username: l.username, confirmedSeq: Math.max(cur, Number(seq)) });
        return [encodeAck(msgId(), seq)];
      }
      default:
        return [];
    }
  }

  const handleInOrder = (l: Link, env: Uint8Array): Promise<Uint8Array[]> => {
    const p = l.chain.then(() => handle(l, env));
    l.chain = p.catch(() => undefined);
    return p;
  };

  function verify(req: http.IncomingMessage, body: Uint8Array): Link | { code: number; msg: string } {
    const r = sessions.verify(partsFromHeaders(req.headers), req.method || 'GET', req.url || '/', body);
    if (!r.ok) return { code: r.error === 'rate-limited' ? 429 : 401, msg: r.error };
    const l = links.get(r.sidecarId);
    return l ?? { code: 401, msg: 'unknown sidecar' };
  }

  const markHttp = (l: Link) => {
    const ws = l.ws && l.ws.readyState === WebSocket.OPEN;
    upsertFsSidecar(l.sidecarId, { username: l.username, lastSeenAt: Date.now(), ...(ws ? {} : { connectionMode: 'http' as const }) });
  };

  async function login(req: http.IncomingMessage, res: http.ServerResponse) {
    const fail = (code: number, error: string) => reply(res, code, encodeLoginReply({ ok: false, serverVersion: version, error }));
    let user = '', pass = '', sidecarId = '';
    try {
      const env = decodeSingle(await readBody(req, MAX_LOGIN_BODY), isZstd(req), MAX_LOGIN_BODY);
      const l = env.messageType() === Message.Login ? (env.message(new Login()) as Login | null) : null;
      if (!l) return text(res, 400, 'expected Login');
      user = l.username() ?? '';
      pass = l.password() ?? '';
      sidecarId = l.sidecarId() || user;
    } catch (err) {
      return text(res, 400, (err as Error).message);
    }
    const ip = req.socket.remoteAddress || '';
    if (guard.blocked(ip, user)) return fail(423, 'locked');
    const stored = opts.credentials[user];
    if (stored === undefined || !checkPassword(stored, pass)) {
      guard.failed(ip, user);
      log('warn', 'fs-sidecar: bad login', { ip, user });
      return fail(401, 'bad username or password');
    }
    guard.succeeded(ip, user);
    const { token, key } = sessions.create(sidecarId);
    const l = linkFor(sidecarId, user);
    l.username = user;
    upsertFsSidecar(sidecarId, { username: user, lastSeenAt: Date.now(), peer: ip });
    log('info', 'fs-sidecar: login', { ip, user, sidecarId });
    reply(res, 200, encodeLoginReply({ ok: true, token, key, expiresIn: Math.floor(policy.sessionTtlMs / 1000), serverVersion: version }));
  }

  async function send(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: Buffer;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      return text(res, 413, (err as Error).message);
    }
    const l = verify(req, body);
    if ('code' in l) return text(res, l.code, l.msg);
    let frames: Uint8Array[];
    try {
      frames = decodeBody(body, isZstd(req));
    } catch (err) {
      return text(res, 400, (err as Error).message);
    }
    markHttp(l);
    const out: Uint8Array[] = [];
    for (const f of frames) out.push(...(await handleInOrder(l, f)));
    const enc = encodeBody(out);
    reply(res, 200, enc.body, enc.zstd);
  }

  async function poll(req: http.IncomingMessage, res: http.ServerResponse) {
    const v = verify(req, new Uint8Array(0));
    if ('code' in v) return text(res, v.code, v.msg);
    const l: Link = v;
    markHttp(l);
    if (!l.queue.length) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, pollWait);
        function done() {
          clearTimeout(t);
          l.waiters = l.waiters.filter((w) => w !== done);
          resolve();
        }
        l.waiters.push(done);
        res.on('close', done);
      });
    }
    const enc = encodeBody(l.queue.splice(0));
    if (!res.destroyed) reply(res, 200, enc.body, enc.zstd);
  }

  const server = http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const run = (f: () => Promise<void>) =>
      f().catch((err) => {
        log('warn', 'fs-sidecar: request failed', { path, error: (err as Error).message });
        if (!res.headersSent) text(res, 500, 'internal error');
      });
    if (req.method === 'POST' && path === '/v1/login') return run(() => login(req, res));
    if (req.method === 'POST' && path === '/v1/send') return run(() => send(req, res));
    if (req.method === 'GET' && path === '/v1/poll') return run(() => poll(req, res));
    if (req.method === 'GET' && path === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version, protocol: PROTOCOL_VERSION }));
    }
    text(res, 404, 'not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES + 1024 });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '/').split('?')[0];
    const l = path === '/v1/ws' ? verify(req, new Uint8Array(0)) : { code: 404, msg: 'not found' };
    if ('code' in l) {
      socket.end(`HTTP/1.1 ${l.code} ${l.code === 404 ? 'Not Found' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // A new WS for the same sidecar replaces the old one.
      const old = l.ws;
      l.ws = ws;
      if (old && old.readyState === WebSocket.OPEN) old.close(1000, 'replaced');
      upsertFsSidecar(l.sidecarId, { username: l.username, connectionMode: 'websocket', connectedAt: Date.now(), lastSeenAt: Date.now() });
      ws.send(frameOut(encodeHello(msgId(), version)));
      for (const f of l.queue.splice(0)) ws.send(frameOut(f));
      const timer = setInterval(() => {
        const s = getFsSidecar(l.sidecarId);
        if (s && Date.now() - s.lastSeenAt > deadAfter) {
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(frameOut(encodePing(msgId(), BigInt(0))));
      }, pingEvery);
      ws.on('message', (data: RawData) => {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        let env: Uint8Array;
        try {
          env = frameIn(buf);
        } catch (err) {
          log('warn', 'fs-sidecar: bad frame', { sidecarId: l.sidecarId, error: (err as Error).message });
          return;
        }
        handleInOrder(l, env)
          .then((out) => {
            for (const r of out) if (ws.readyState === WebSocket.OPEN) ws.send(frameOut(r));
          })
          .catch(() => undefined);
      });
      ws.on('close', () => {
        clearInterval(timer);
        if (l.ws === ws) {
          l.ws = undefined;
          upsertFsSidecar(l.sidecarId, { username: l.username, connectionMode: 'disconnected' });
        }
      });
      ws.on('error', () => undefined);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', () => {
      const port = (server.address() as AddressInfo).port;
      log('info', `fs-sidecar link listening on port ${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const l of links.values()) {
              l.ws?.terminate();
              for (const w of l.waiters.splice(0)) w();
            }
            wss.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
