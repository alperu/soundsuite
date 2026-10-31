/**
 * Wire format of the fileSystemSideCar link (master side).
 *
 * Mirrors `crates/sidecar-link/src/codec.rs` in fileSystemSideCar:
 *  - one frame = one FlatBuffers `Envelope` (file identifier `SCAR`), or that
 *    envelope zstd-compressed (detected by the zstd magic bytes);
 *  - an HTTP body = frames packed as `u32 little-endian length + frame`, the
 *    whole body optionally zstd-compressed (`Content-Encoding: zstd`);
 *  - a WebSocket message = one frame.
 */
import zlib from 'zlib';
import * as flatbuffers from 'flatbuffers';
import { Envelope } from './proto/sidecar/envelope';
import { Message } from './proto/sidecar/message';
import { Ack } from './proto/sidecar/ack';
import { Ping } from './proto/sidecar/ping';
import { LoginReply } from './proto/sidecar/login-reply';

export const CONTENT_TYPE = 'application/x-sidecar-frames';
export const PROTOCOL_VERSION = 2;
/** Oldest sidecar protocol a login accepts (no backward compatibility). */
export const MIN_PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** Same threshold idea as the Rust `Limits::compress_over`. */
export const COMPRESS_OVER = 64 * 1024;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

type ZstdZlib = typeof zlib & {
  zstdCompressSync?: (b: Buffer) => Buffer;
  zstdDecompressSync?: (b: Buffer, o?: { maxOutputLength?: number }) => Buffer;
};
const z = zlib as ZstdZlib;

/** Node 22.15+ ships zstd in `zlib`. Older Node cannot read compressed frames. */
export const zstdSupported = typeof z.zstdDecompressSync === 'function';

export function isZstd(b: Uint8Array): boolean {
  return b.length >= 4 && ZSTD_MAGIC.every((m, i) => b[i] === m);
}

export function decompress(b: Uint8Array, max: number): Buffer {
  if (!z.zstdDecompressSync) throw new Error('zstd frame received but this Node has no zlib zstd');
  try {
    return z.zstdDecompressSync(Buffer.from(b), { maxOutputLength: max });
  } catch (e) {
    throw new Error(`zstd: ${(e as Error).message}`);
  }
}

function maybeCompress(b: Buffer): { body: Buffer; zstd: boolean } {
  if (z.zstdCompressSync && b.length >= COMPRESS_OVER) {
    const c = z.zstdCompressSync(b);
    if (c.length < b.length) return { body: c, zstd: true };
  }
  return { body: b, zstd: false };
}

/** Parse and check one envelope. Throws on a bad buffer. */
export function parseEnvelope(buf: Uint8Array): Envelope {
  if (buf.length < 8 || buf.length > MAX_FRAME_BYTES) throw new Error('bad envelope size');
  const bb = new flatbuffers.ByteBuffer(buf);
  if (!Envelope.bufferHasIdentifier(bb)) throw new Error('not a SCAR envelope');
  return Envelope.getRootAsEnvelope(bb);
}

/** A WS message or one packed frame -> plain envelope bytes. */
export function frameIn(b: Uint8Array): Uint8Array {
  const buf = isZstd(b) ? decompress(b, MAX_FRAME_BYTES) : b;
  parseEnvelope(buf);
  return buf;
}

export function frameOut(env: Uint8Array): Buffer {
  return maybeCompress(Buffer.from(env)).body;
}

export function pack(frames: Uint8Array[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of frames) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(f.length, 0);
    parts.push(len, Buffer.from(f));
  }
  return Buffer.concat(parts);
}

export function unpack(body: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  while (off < view.length) {
    if (view.length - off < 4) throw new Error('truncated frame length');
    const n = view.readUInt32LE(off);
    off += 4;
    if (n > view.length - off) throw new Error('truncated frame');
    out.push(frameIn(view.subarray(off, off + n)));
    off += n;
  }
  return out;
}

export function encodeBody(frames: Uint8Array[]): { body: Buffer; zstd: boolean } {
  return maybeCompress(pack(frames));
}

export function decodeBody(body: Uint8Array, zstd: boolean): Uint8Array[] {
  if (body.length > MAX_BODY_BYTES) throw new Error('body over the limit');
  return unpack(zstd ? decompress(body, MAX_BODY_BYTES) : body);
}

export function decodeSingle(body: Uint8Array, zstd: boolean, max: number): Envelope {
  if (body.length > max) throw new Error('body over the limit');
  return parseEnvelope(zstd ? decompress(body, max) : body);
}

// ------------------------------------------------------------------ builders

function envelope(b: flatbuffers.Builder, msgId: bigint, replyTo: bigint, type: Message, msg: flatbuffers.Offset): Uint8Array {
  const e = Envelope.createEnvelope(b, msgId, replyTo, 0, type, msg);
  Envelope.finishEnvelopeBuffer(b, e);
  return b.asUint8Array().slice();
}

export function encodeAck(msgId: bigint, seq: bigint): Uint8Array {
  const b = new flatbuffers.Builder(64);
  return envelope(b, msgId, BigInt(0), Message.Ack, Ack.createAck(b, seq));
}

export function encodePing(msgId: bigint, replyTo: bigint): Uint8Array {
  const b = new flatbuffers.Builder(64);
  return envelope(b, msgId, replyTo, Message.Ping, Ping.createPing(b, BigInt(Date.now())));
}

export function encodeLoginReply(r: {
  ok: boolean;
  token?: string;
  key?: Uint8Array;
  expiresIn?: number;
  serverVersion: string;
  error?: string;
}): Uint8Array {
  const b = new flatbuffers.Builder(256);
  const tok = r.token ? b.createString(r.token) : 0;
  const key = r.key ? LoginReply.createSessionKeyVector(b, r.key) : 0;
  const ver = b.createString(r.serverVersion);
  const err = r.error ? b.createString(r.error) : 0;
  LoginReply.startLoginReply(b);
  LoginReply.addOk(b, r.ok);
  if (tok) LoginReply.addSessionToken(b, tok);
  if (key) LoginReply.addSessionKey(b, key);
  LoginReply.addExpiresIn(b, r.expiresIn ?? 0);
  LoginReply.addServerVersion(b, ver);
  LoginReply.addProtocolVersion(b, PROTOCOL_VERSION);
  if (err) LoginReply.addError(b, err);
  const m = LoginReply.endLoginReply(b);
  return envelope(b, BigInt(0), BigInt(0), Message.LoginReply, m);
}
