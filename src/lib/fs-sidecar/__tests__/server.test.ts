/**
 * @jest-environment node
 */
import * as flatbuffers from 'flatbuffers';
import WebSocket from 'ws';
import { startFsSidecarLink, type FsLinkServer } from '../server';
import { encodeBody, decodeBody, parseEnvelope, CONTENT_TYPE } from '../codec';
import { signedHeaders, hashPassword } from '../auth';
import { Envelope } from '../proto/sidecar/envelope';
import { Message } from '../proto/sidecar/message';
import { Login } from '../proto/sidecar/login';
import { LoginReply } from '../proto/sidecar/login-reply';
import { FolderStat } from '../proto/sidecar/folder-stat';
import { FolderStatBatch } from '../proto/sidecar/folder-stat-batch';
import { Ack } from '../proto/sidecar/ack';
import { Ping } from '../proto/sidecar/ping';
import type { FolderStatRow, FolderStatStore } from '../folder-store';
import { __resetFsSidecarsForTests, getFsSidecar, getFsSidecarStatuses } from '../status';

const B = (n: number) => BigInt(n);

function env(type: Message, build: (b: flatbuffers.Builder) => flatbuffers.Offset, msgId = 1): Uint8Array {
  const b = new flatbuffers.Builder(256);
  const m = build(b);
  Envelope.finishEnvelopeBuffer(b, Envelope.createEnvelope(b, B(msgId), B(0), 0, type, m));
  return b.asUint8Array().slice();
}

const login = (user: string, pass: string, id = 'mac-1', proto = 2) =>
  env(Message.Login, (b) => Login.createLogin(b, proto, b.createString(user), b.createString(pass), b.createString(id)));

const ping = (id: number) => env(Message.Ping, (b) => Ping.createPing(b, B(Date.now())), id);

function batch(seq: number, stats: Array<{ path: string; files: number; bytes: number; deleted?: boolean }>, id = 10): Uint8Array {
  return env(
    Message.FolderStatBatch,
    (b) => {
      const offs = stats.map((s) =>
        FolderStat.createFolderStat(b, b.createString('music'), b.createString(s.path), B(s.files), B(s.bytes), B(5_000_000), B(0), !!s.deleted, B(s.files), B(s.bytes), B(5_000_000)),
      );
      return FolderStatBatch.createFolderStatBatch(b, B(seq), FolderStatBatch.createStatsVector(b, offs));
    },
    id,
  );
}

class MemStore implements FolderStatStore {
  rows = new Map<string, FolderStatRow>();
  fail = false;
  async applyBatch(_id: string, stats: FolderStatRow[]) {
    if (this.fail) throw new Error('db down');
    for (const s of stats) {
      if (s.deleted) this.rows.delete(s.path);
      else this.rows.set(s.path, s);
    }
  }
}

let srv: FsLinkServer;
let store: MemStore;
const base = () => `http://127.0.0.1:${srv.port}`;

async function doLogin(user = 'mac', pass = 'pw', proto = 2) {
  const r = await fetch(`${base()}/v1/login`, { method: 'POST', headers: { 'content-type': CONTENT_TYPE }, body: Buffer.from(login(user, pass, 'mac-1', proto)) });
  const e = parseEnvelope(new Uint8Array(await r.arrayBuffer()));
  const lr = e.message(new LoginReply()) as LoginReply;
  return { status: r.status, ok: lr.ok(), token: lr.sessionToken() ?? '', key: lr.sessionKeyArray() ?? new Uint8Array(0), error: lr.error() };
}

beforeEach(async () => {
  __resetFsSidecarsForTests();
  store = new MemStore();
  srv = await startFsSidecarLink({
    port: 0,
    host: '127.0.0.1',
    credentials: { mac: hashPassword('pw') },
    store,
    serverVersion: 'test-1',
    pollWaitMs: 200,
  });
});
afterEach(() => srv.close());

describe('fs-sidecar link (master side)', () => {
  test('login refuses a bad password and accepts the right one', async () => {
    const bad = await doLogin('mac', 'nope');
    expect(bad.status).toBe(401);
    expect(bad.ok).toBe(false);
    const good = await doLogin();
    expect(good.status).toBe(200);
    expect(good.ok).toBe(true);
    expect(good.key.length).toBe(32);
  });

  test('login with protocol 1 is refused with 426 and a clear error', async () => {
    const old = await doLogin('mac', 'pw', 1);
    expect(old.status).toBe(426);
    expect(old.ok).toBe(false);
    expect(old.error).toBe('protocol 1 is too old (need 2): update the sidecar/receiver');
  });

  test('HTTP send: FolderStatBatch is stored and acked by seq; mode = http', async () => {
    const s = await doLogin();
    const { body } = encodeBody([batch(7, [{ path: '', files: 3, bytes: 30 }, { path: 'a', files: 2, bytes: 20 }])]);
    const r = await fetch(`${base()}/v1/send`, {
      method: 'POST',
      headers: { 'content-type': CONTENT_TYPE, ...signedHeaders(s.token, s.key, 'POST', '/v1/send', body) },
      body: new Uint8Array(body),
    });
    expect(r.status).toBe(200);
    const replies = decodeBody(new Uint8Array(await r.arrayBuffer()), false).map(parseEnvelope);
    expect(replies).toHaveLength(1);
    expect(replies[0].messageType()).toBe(Message.Ack);
    expect((replies[0].message(new Ack()) as Ack).seq()).toBe(B(7));
    // Protocol 2 Ack: no failed files, no walk bundle.
    expect((replies[0].message(new Ack()) as Ack).failedLength()).toBe(0);
    expect((replies[0].message(new Ack()) as Ack).bundleId()).toBe(B(0));
    expect(store.rows.get('a')?.recFileCount).toBe(2);
    expect(getFsSidecar('mac-1')).toMatchObject({ connectionMode: 'http', confirmedSeq: 7 });
  });

  test('a bad signature and a replayed nonce are refused', async () => {
    const s = await doLogin();
    const { body } = encodeBody([ping(1)]);
    const h = signedHeaders(s.token, s.key, 'POST', '/v1/send', body);
    const bad = await fetch(`${base()}/v1/send`, { method: 'POST', headers: { ...h, 'x-sidecar-signature': '00'.repeat(32) }, body: new Uint8Array(body) });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base()}/v1/send`, { method: 'POST', headers: h, body: new Uint8Array(body) });
    expect(ok.status).toBe(200);
    const again = await fetch(`${base()}/v1/send`, { method: 'POST', headers: h, body: new Uint8Array(body) });
    expect(again.status).toBe(401);
  });

  test('no Ack when the store fails (sidecar resends)', async () => {
    const s = await doLogin();
    store.fail = true;
    const { body } = encodeBody([batch(1, [{ path: 'x', files: 1, bytes: 1 }])]);
    const r = await fetch(`${base()}/v1/send`, { method: 'POST', headers: signedHeaders(s.token, s.key, 'POST', '/v1/send', body), body: new Uint8Array(body) });
    expect(decodeBody(new Uint8Array(await r.arrayBuffer()), false)).toHaveLength(0);
  });

  test('poll returns an empty body after the wait', async () => {
    const s = await doLogin();
    const r = await fetch(`${base()}/v1/poll`, { headers: signedHeaders(s.token, s.key, 'GET', '/v1/poll', new Uint8Array(0)) });
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });

  test('WebSocket: Hello first, Ping answered, batch acked, heartbeat and mode recorded', async () => {
    const s = await doLogin();
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/v1/ws`, { headers: signedHeaders(s.token, s.key, 'GET', '/v1/ws', new Uint8Array(0)) });
    const got: Envelope[] = [];
    const next = (n: number) =>
      new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`waited for ${n} frames, got ${got.length}`)), 3000);
        const check = () => (got.length >= n ? (clearTimeout(t), res()) : setTimeout(check, 10));
        check();
      });
    ws.on('message', (d: Buffer) => got.push(parseEnvelope(new Uint8Array(d))));
    await new Promise((r) => ws.once('open', r));
    await next(1);
    expect(got[0].messageType()).toBe(Message.Hello);
    ws.send(Buffer.from(ping(2)));
    await next(2);
    expect(got[1].messageType()).toBe(Message.Ping);
    expect(got[1].replyTo()).toBe(B(2));
    ws.send(Buffer.from(batch(3, [{ path: 'b', files: 5, bytes: 50 }])));
    await next(3);
    expect((got[2].message(new Ack()) as Ack).seq()).toBe(B(3));
    expect(store.rows.get('b')?.recTotalBytes).toBe(B(50));
    const st = getFsSidecarStatuses()[0];
    expect(st.connectionMode).toBe('websocket');
    expect(st.lastHeartbeatAt).toBeGreaterThan(0);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(getFsSidecar('mac-1')?.connectionMode).toBe('disconnected');
  });

  test('WS upgrade without a valid signature is refused', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/v1/ws`);
    const err = await new Promise<Error>((r) => ws.once('error', r));
    expect(String(err.message)).toMatch(/401/);
  });
});
