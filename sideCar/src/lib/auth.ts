/**
 * Sidecar login: one admin account and a signed session cookie.
 *
 *   <secret dir>/admin.json  { v, user, salt, hash, gen }  hash = scrypt(password)
 *
 * The first admin comes from SIDECAR_ADMIN_USER / SIDECAR_ADMIN_PASSWORD (env), or
 * from the first-run form on /login. A password change bumps `gen`, which ends
 * every older session.
 *
 * Session cookie: base64url({u, g, exp}) + "." + HMAC-SHA256, keyed by a key derived
 * from the install's data key (secret-box.ts), so it never needs its own file.
 *
 * requireAdmin() guards the endpoints that change settings or hold secrets. It
 * accepts a session cookie, or `Authorization: Bearer $SIDECAR_ADMIN_TOKEN` for scripts.
 * Machine endpoints that masters call (status, acquire, chat, ...) stay open.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { purposeKey, secretDir, writeFileAtomic } from './secret-box';

export const SESSION_COOKIE = 'sidecar_session';
export const SESSION_HOURS = 12;
const ADMIN_FILE = 'admin.json';
const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;
export const MIN_PASSWORD = 10;

interface AdminFile { v: 1; user: string; salt: string; hash: string; gen: number; updatedAt: string }

export class AuthInputError extends Error {}

const adminPath = (dir: string) => path.join(dir, ADMIN_FILE);

function readAdmin(dir: string): AdminFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(adminPath(dir), 'utf8')) as AdminFile;
    return j && j.v === 1 && j.user && j.salt && j.hash ? j : null;
  } catch {
    return null;
  }
}

const hashPassword = (password: string, salt: Buffer) =>
  crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });

/** Make the admin account from env if none exists yet. */
export function seedAdminFromEnv(dir: string = secretDir(), env: NodeJS.ProcessEnv = process.env): void {
  const pw = env.SIDECAR_ADMIN_PASSWORD;
  if (!pw || readAdmin(dir)) return;
  try { setAdmin(env.SIDECAR_ADMIN_USER?.trim() || 'admin', pw, dir); } catch { /* bad env value: first-run form */ }
}

export function adminExists(dir: string = secretDir()): boolean {
  seedAdminFromEnv(dir);
  return !!readAdmin(dir);
}

export function setAdmin(user: string, password: string, dir: string = secretDir()): void {
  if (!USER_RE.test(user)) throw new AuthInputError('User name: letters, digits, . _ @ -, up to 64 characters.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AuthInputError(`Password must have at least ${MIN_PASSWORD} characters.`);
  }
  const old = readAdmin(dir);
  const salt = crypto.randomBytes(16);
  const rec: AdminFile = {
    v: 1, user, salt: salt.toString('base64'), hash: hashPassword(password, salt).toString('base64'),
    gen: (old?.gen ?? 0) + 1, updatedAt: new Date().toISOString(),
  };
  writeFileAtomic(adminPath(dir), JSON.stringify(rec, null, 2) + '\n', 0o600);
}

export function checkPassword(user: string, password: string, dir: string = secretDir()): boolean {
  const a = readAdmin(dir);
  if (!a || typeof password !== 'string') return false;
  const got = hashPassword(password, Buffer.from(a.salt, 'base64'));
  const want = Buffer.from(a.hash, 'base64');
  const userOk = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(user)).digest(),
    crypto.createHash('sha256').update(a.user).digest(),
  );
  return got.length === want.length && crypto.timingSafeEqual(got, want) && userOk;
}

const b64u = (b: Buffer) => b.toString('base64url');
const sign = (payload: string, dir: string) =>
  b64u(crypto.createHmac('sha256', purposeKey('session', dir)).update(payload).digest());

export function createSession(user: string, dir: string = secretDir(), now = Date.now()): string {
  const a = readAdmin(dir);
  const payload = b64u(Buffer.from(JSON.stringify({ u: user, g: a?.gen ?? 0, exp: now + SESSION_HOURS * 3600_000 })));
  return `${payload}.${sign(payload, dir)}`;
}

/** The user name of a valid session, else null. */
export function sessionUser(token: string | undefined | null, dir: string = secretDir(), now = Date.now()): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const want = Buffer.from(sign(payload, dir));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u: string; g: number; exp: number };
    const a = readAdmin(dir);
    if (!a || j.u !== a.user || j.g !== a.gen || !(j.exp > now)) return null;
    return j.u;
  } catch {
    return null;
  }
}

export function cookieValue(req: Request, name = SESSION_COOKIE): string | null {
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function bearerOk(req: Request, env: NodeJS.ProcessEnv): boolean {
  const token = env.SIDECAR_ADMIN_TOKEN?.trim();
  if (!token) return false;
  const got = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!got) return false;
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Null when the caller is the signed-in admin (or has the admin token); else a 401 response. */
export function requireAdmin(req: Request, env: NodeJS.ProcessEnv = process.env, dir: string = secretDir()): NextResponse | null {
  if (bearerOk(req, env)) return null;
  try {
    if (sessionUser(cookieValue(req), dir)) return null;
  } catch { /* key problem: treat as signed out */ }
  return NextResponse.json({ error: 'Sign in required.', login: '/login' }, { status: 401 });
}

export function sessionCookie(req: Request, value: string, maxAgeSec: number): string {
  const https = req.headers.get('x-forwarded-proto') === 'https' || new URL(req.url).protocol === 'https:';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

/** Failed-login limit: 5 per IP per 5 minutes. */
/** Also 30 per 5 minutes in total, because the client IP header can be faked. */
const fails = new Map<string, number[]>();
const recent = (k: string, now: number) => {
  const list = (fails.get(k) || []).filter((t) => now - t < 300_000);
  fails.set(k, list);
  return list;
};
export function loginBlocked(ip: string, now = Date.now()): boolean {
  return recent(ip, now).length >= 5 || recent('*', now).length >= 30;
}
export function noteLoginFail(ip: string, now = Date.now()): void {
  for (const k of [ip, '*']) fails.set(k, [...recent(k, now), now]);
}
export function _resetLoginFails(): void { fails.clear(); }
export function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
}
