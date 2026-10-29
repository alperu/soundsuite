/**
 * Session auth of the fileSystemSideCar link (master side).
 *
 * Mirrors `crates/sidecar-link/src/auth.rs`: after `POST /v1/login` every
 * request carries `x-sidecar-token`, `x-sidecar-time` (Unix ms),
 * `x-sidecar-nonce` and `x-sidecar-signature` =
 * hex(HMAC-SHA256(session_key, "METHOD\npath?query\ntime\nnonce\nhex(sha256(body))")).
 * Requests outside the time window, replays and unknown tokens are refused.
 */
import crypto from 'crypto';

export const HDR_TOKEN = 'x-sidecar-token';
export const HDR_TIME = 'x-sidecar-time';
export const HDR_NONCE = 'x-sidecar-nonce';
export const HDR_SIG = 'x-sidecar-signature';

export interface AuthPolicy {
  windowMs: number;
  sessionTtlMs: number;
  requestsPerSec: number;
  /** Failed logins per (ip, user) before a lock. */
  maxFails: number;
  lockMs: number;
}

export const DEFAULT_POLICY: AuthPolicy = {
  windowMs: 300_000,
  sessionTtlMs: 3_600_000,
  requestsPerSec: 200,
  maxFails: 5,
  lockMs: 60_000,
};

export type AuthError = 'missing' | 'outside-window' | 'unknown-token' | 'expired' | 'bad-signature' | 'replay' | 'rate-limited';

export function stringToSign(method: string, path: string, timeMs: number, nonce: string, body: Uint8Array): string {
  const h = crypto.createHash('sha256').update(body).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${timeMs}\n${nonce}\n${h}`;
}

export function signature(key: Uint8Array, method: string, path: string, timeMs: number, nonce: string, body: Uint8Array): string {
  return crypto.createHmac('sha256', key).update(stringToSign(method, path, timeMs, nonce, body)).digest('hex');
}

/** Headers a client sends; used by tests to play the sidecar. */
export function signedHeaders(token: string, key: Uint8Array, method: string, path: string, body: Uint8Array): Record<string, string> {
  const t = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    [HDR_TOKEN]: token,
    [HDR_TIME]: String(t),
    [HDR_NONCE]: nonce,
    [HDR_SIG]: signature(key, method, path, t, nonce, body),
  };
}

export interface SignedParts {
  token: string;
  timeMs: number;
  nonce: string;
  signature: string;
}

type Headers = Record<string, string | string[] | undefined>;

export function partsFromHeaders(h: Headers): SignedParts | null {
  const get = (n: string) => {
    const v = h[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const token = get(HDR_TOKEN), time = get(HDR_TIME), nonce = get(HDR_NONCE), sig = get(HDR_SIG);
  if (!token || !time || !nonce || !sig || !/^-?\d+$/.test(time)) return null;
  return { token, timeMs: Number(time), nonce, signature: sig };
}

interface Session {
  sidecarId: string;
  key: Buffer;
  expires: number;
  nonces: Map<string, number>;
  secStart: number;
  secCount: number;
}

export class Sessions {
  private map = new Map<string, Session>();
  constructor(private policy: AuthPolicy = DEFAULT_POLICY) {}

  create(sidecarId: string): { token: string; key: Buffer } {
    const token = crypto.randomBytes(24).toString('hex');
    const key = crypto.randomBytes(32);
    const now = Date.now();
    for (const [t, s] of this.map) if (s.expires <= now) this.map.delete(t);
    this.map.set(token, { sidecarId, key, expires: now + this.policy.sessionTtlMs, nonces: new Map(), secStart: now, secCount: 0 });
    return { token, key };
  }

  /** Returns the sidecar id of the session, or the reason it is refused. */
  verify(p: SignedParts | null, method: string, path: string, body: Uint8Array): { ok: true; sidecarId: string } | { ok: false; error: AuthError } {
    if (!p) return { ok: false, error: 'missing' };
    const now = Date.now();
    const win = this.policy.windowMs;
    if (Math.abs(now - p.timeMs) > win) return { ok: false, error: 'outside-window' };
    if (!p.nonce || p.nonce.length > 64) return { ok: false, error: 'missing' };
    const s = this.map.get(p.token);
    if (!s) return { ok: false, error: 'unknown-token' };
    if (s.expires <= now) {
      this.map.delete(p.token);
      return { ok: false, error: 'expired' };
    }
    const want = Buffer.from(signature(s.key, method, path, p.timeMs, p.nonce, body), 'hex');
    const got = /^[0-9a-fA-F]*$/.test(p.signature) ? Buffer.from(p.signature, 'hex') : Buffer.alloc(0);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { ok: false, error: 'bad-signature' };
    for (const [n, t] of s.nonces) if (now - t > win) s.nonces.delete(n);
    if (s.nonces.has(p.nonce)) return { ok: false, error: 'replay' };
    s.nonces.set(p.nonce, p.timeMs);
    if (now - s.secStart >= 1000) {
      s.secStart = now;
      s.secCount = 0;
    }
    if (++s.secCount > this.policy.requestsPerSec) return { ok: false, error: 'rate-limited' };
    return { ok: true, sidecarId: s.sidecarId };
  }
}

/** Lock (ip, user) after too many failed logins. */
export class LoginGuard {
  private fails = new Map<string, { count: number; until: number }>();
  constructor(private policy: AuthPolicy = DEFAULT_POLICY) {}

  blocked(ip: string, user: string): boolean {
    const f = this.fails.get(`${ip}|${user}`);
    return !!f && f.until > Date.now();
  }
  failed(ip: string, user: string): void {
    const k = `${ip}|${user}`;
    const f = this.fails.get(k) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= this.policy.maxFails) {
      f.until = Date.now() + this.policy.lockMs;
      f.count = 0;
    }
    this.fails.set(k, f);
  }
  succeeded(ip: string, user: string): void {
    this.fails.delete(`${ip}|${user}`);
  }
}

/**
 * Check a password against a stored value. The stored value is either
 * `scrypt$<salt hex>$<hash hex>` (see `hashPassword`) or a plain password.
 */
export function checkPassword(stored: string, given: string): boolean {
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = stored.split('$');
    if (!saltHex || !hashHex) return false;
    const want = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(given, Buffer.from(saltHex, 'hex'), want.length);
    return crypto.timingSafeEqual(got, want);
  }
  const a = crypto.createHash('sha256').update(stored).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
