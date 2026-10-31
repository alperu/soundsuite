import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/db/prisma';
import {
  ReceiverAdmin,
  ReceiverError,
  receiverSettings,
  sameRoots,
  type ReceiverAccount,
} from '@/lib/admin/receiver-admin';
import { toPublic, validateUsername, type AdminUserPublic } from '@/lib/admin/user-store';

/**
 * "Sidecar sync login" for SoundSuite users (Users page). One user list: the
 * AdminUser table. The sidecar-receiver keeps the sync password (Argon2 hash);
 * SoundSuite keeps only on/off, the allowed roots (empty = all roots) and the
 * last login, and keeps the receiver in step through its admin API. The
 * receiver enforces the allowed roots per account.
 */

const MIN_SYNC_PASSWORD = 8;
const ROOT_RE = /^[^/\\\0]{1,128}$/;

export class SyncLoginError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface SyncSettingsView {
  receiverUrl: 'set' | 'not set';
  receiverToken: 'set' | 'not set';
}

export interface SyncAccountView {
  id: string;
  username: string;
  roots: string[];
  /** Roots this account may use; empty = all roots. */
  allowedRoots: string[];
  lastLoginMs: number | null;
  connected: boolean;
  userId: string | null;
}

export interface SyncView {
  configured: boolean;
  settings: SyncSettingsView;
  accounts: SyncAccountView[];
  /** Every root name the receiver knows (choices for allowed roots). */
  roots: string[];
  /** Users linked from receiver accounts in this call. */
  linked: string[];
  error: string | null;
}

export interface SyncDeps {
  receiver?: ReceiverAdmin | null;
  env?: NodeJS.ProcessEnv;
}

function getReceiver(deps: SyncDeps): ReceiverAdmin | null {
  return deps.receiver !== undefined ? deps.receiver : ReceiverAdmin.fromEnv(deps.env ?? process.env);
}

function settingsView(env: NodeJS.ProcessEnv): SyncSettingsView {
  return {
    receiverUrl: env.SIDECAR_RECEIVER_URL?.trim() ? 'set' : 'not set',
    receiverToken: env.SIDECAR_RECEIVER_TOKEN?.trim() ? 'set' : 'not set',
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function cleanRoots(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!arr) throw new SyncLoginError('roots must be a list of root names');
  const out = [...new Set(arr.map((r) => String(r).trim()).filter(Boolean))];
  for (const r of out) {
    if (!ROOT_RE.test(r) || r === '.' || r === '..') throw new SyncLoginError(`Bad root name: ${r.slice(0, 40)}`);
  }
  return out;
}

/**
 * Link receiver accounts to users by username. No user → create a viewer
 * with dashboard login off. Never changes a password (receiver or dashboard).
 */
export async function linkAccounts(accounts: ReceiverAccount[]): Promise<string[]> {
  const linked: string[] = [];
  for (const a of accounts) {
    const username = a.username.trim().toLowerCase();
    try {
      validateUsername(username);
    } catch {
      continue; // cannot be a SoundSuite username; list it unlinked
    }
    const lastLogin = a.lastLoginMs ? new Date(a.lastLoginMs) : null;
    const user = await prisma.adminUser.findUnique({ where: { username } });
    if (!user) {
      // Random dashboard password nobody knows; dashboard login is off anyway.
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10);
      await prisma.adminUser.create({
        data: {
          username,
          passwordHash,
          role: 'viewer',
          dashboardLogin: false,
          syncEnabled: true,
          syncRoots: JSON.stringify(a.allowedRoots),
          syncLastLoginAt: lastLogin,
        },
      });
      linked.push(username);
      continue;
    }
    const data: Record<string, unknown> = {};
    if (!user.syncEnabled) {
      data.syncEnabled = true;
      linked.push(username);
    }
    // Mirror the receiver's allowed roots (it enforces them).
    const roots = JSON.stringify(a.allowedRoots);
    if (user.syncRoots !== roots) data.syncRoots = roots;
    if (lastLogin && user.syncLastLoginAt?.getTime() !== lastLogin.getTime()) data.syncLastLoginAt = lastLogin;
    if (Object.keys(data).length) await prisma.adminUser.update({ where: { id: user.id }, data });
  }
  return linked;
}

/** Receiver accounts (read only) + link step. Errors are shown, never thrown. */
export async function syncView(deps: SyncDeps = {}, opts: { link?: boolean } = {}): Promise<SyncView> {
  const env = deps.env ?? process.env;
  const settings = settingsView(env);
  const rx = getReceiver(deps);
  if (!rx) return { configured: false, settings, accounts: [], roots: [], linked: [], error: null };
  try {
    const { accounts, roots } = await rx.listing();
    const linked = opts.link ? await linkAccounts(accounts) : [];
    const users = await prisma.adminUser.findMany({ select: { id: true, username: true } });
    const byName = new Map(users.map((u) => [u.username, u.id]));
    return {
      configured: true,
      settings,
      linked,
      error: null,
      roots,
      accounts: accounts.map((a) => ({ ...a, userId: byName.get(a.username.toLowerCase()) ?? null })),
    };
  } catch (e) {
    return { configured: true, settings, accounts: [], roots: [], linked: [], error: errMsg(e) };
  }
}

/**
 * Turn a user's sync login on/off, set its password (write only) and its
 * allowed roots (empty = all). No `roots` field keeps the receiver's roots.
 * The receiver changes first; the database follows only on success. Roots are
 * sent only when they differ from the receiver's (order ignored); the password
 * only when typed.
 */
export async function setSyncLogin(
  userId: string,
  input: { enabled?: unknown; password?: unknown; roots?: unknown },
  deps: SyncDeps = {},
): Promise<AdminUserPublic> {
  const user = await prisma.adminUser.findUnique({ where: { id: userId } });
  if (!user) throw new SyncLoginError('User not found', 404);
  const rx = getReceiver(deps);
  if (!rx) throw new SyncLoginError('Receiver not set up (SIDECAR_RECEIVER_URL, SIDECAR_RECEIVER_TOKEN)', 409);

  const enabled = input.enabled === undefined ? user.syncEnabled : input.enabled === true;
  const password = input.password === undefined || input.password === '' ? undefined : input.password;
  if (password !== undefined && (typeof password !== 'string' || password.length < MIN_SYNC_PASSWORD)) {
    throw new SyncLoginError(`Sync password must be at least ${MIN_SYNC_PASSWORD} characters`);
  }
  if (!enabled && password !== undefined) throw new SyncLoginError('Turn the sync login on to set its password');
  // No `roots` field: keep the receiver's allowed roots (a new account gets all).
  const wanted = input.roots === undefined ? null : cleanRoots(input.roots);

  const name = user.username;
  let roots: string[] | null = null;
  try {
    const existing = (await rx.list()).find((a) => a.username.toLowerCase() === name);
    if (!enabled) {
      if (existing) await rx.remove(existing.username);
    } else if (!existing) {
      if (password === undefined) throw new SyncLoginError('Set a sync password to turn the sync login on');
      roots = wanted ?? [];
      await rx.add({ username: name, password: password as string, roots });
    } else {
      if (password !== undefined) await rx.setPassword(existing.username, password as string);
      if (wanted && !sameRoots(wanted, existing.allowedRoots)) await rx.setRoots(existing.username, wanted);
      roots = wanted ?? existing.allowedRoots;
    }
  } catch (e) {
    if (e instanceof SyncLoginError) throw e;
    if (e instanceof ReceiverError) throw new SyncLoginError(e.message, e.status === 400 || e.status === 409 ? e.status : 502);
    throw e;
  }

  const data: Record<string, unknown> = { syncEnabled: enabled };
  if (roots) data.syncRoots = JSON.stringify(roots);
  const updated = await prisma.adminUser.update({ where: { id: user.id }, data });
  return toPublic(updated);
}

/** Before a user is deleted: drop its receiver account. */
export async function removeSyncLoginFor(userId: string, deps: SyncDeps = {}): Promise<void> {
  const user = await prisma.adminUser.findUnique({ where: { id: userId } });
  if (!user?.syncEnabled) return;
  const rx = getReceiver(deps);
  if (!rx) throw new SyncLoginError('Receiver not set up: cannot remove the sync login first', 409);
  try {
    const existing = (await rx.list()).find((a) => a.username.toLowerCase() === user.username);
    if (existing) await rx.remove(existing.username);
  } catch (e) {
    throw new SyncLoginError(errMsg(e), e instanceof ReceiverError && e.status === 409 ? 409 : 502);
  }
}

export function receiverConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return receiverSettings(env) !== null;
}
