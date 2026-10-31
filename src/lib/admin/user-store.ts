import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';

/**
 * Admin user store — CRUD + credential verification for the dashboard Users tab.
 * Passwords are bcrypt-hashed; the hash never leaves this module.
 */

export type AdminRole = 'admin' | 'viewer';

export interface AdminUserPublic {
  id: string;
  username: string;
  role: AdminRole;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  /** false = sync-only user: no dashboard sign-in. */
  dashboardLogin: boolean;
  /** "Sidecar sync login" (the password lives only in the sidecar-receiver). */
  syncEnabled: boolean;
  /** Allowed root names; [] = every root the receiver maps. */
  syncRoots: string[];
  syncLastLoginAt: Date | null;
}

export interface AdminUserRow {
  id: string;
  username: string;
  role: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  dashboardLogin?: boolean | null;
  syncEnabled?: boolean | null;
  syncRoots?: string | null;
  syncLastLoginAt?: Date | null;
}

export function parseRoots(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const BCRYPT_ROUNDS = 10;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MIN_PASSWORD_LENGTH = 8;

export function toPublic(user: AdminUserRow): AdminUserPublic {
  return {
    id: user.id,
    username: user.username,
    role: user.role === 'admin' ? 'admin' : 'viewer',
    enabled: user.enabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    dashboardLogin: user.dashboardLogin !== false,
    syncEnabled: user.syncEnabled === true,
    syncRoots: parseRoots(user.syncRoots),
    syncLastLoginAt: user.syncLastLoginAt ?? null,
  };
}

export function validateUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new Error('Username must be 3-32 characters (letters, digits, _ or -)');
  }
}

function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

function validateRole(role: string): asserts role is AdminRole {
  if (role !== 'admin' && role !== 'viewer') {
    throw new Error("Role must be 'admin' or 'viewer'");
  }
}

/**
 * First-run bootstrap: create the initial admin account when no users exist yet.
 * The credential comes from SS_ADMIN_BOOTSTRAP_PASSWORD in local env config (never
 * source), so a fresh install can sign in immediately. Idempotent — a non-empty
 * AdminUser table is left untouched. The operator should change the password
 * right after first login (Users tab -> Reset Password).
 */
export async function ensureDefaultAdmin(): Promise<boolean> {
  const bootstrapPassword = process.env.SS_ADMIN_BOOTSTRAP_PASSWORD;
  if (!bootstrapPassword) return false;

  const count = await prisma.adminUser.count();
  if (count > 0) return false;

  const passwordHash = await bcrypt.hash(bootstrapPassword, BCRYPT_ROUNDS);
  await prisma.adminUser.create({
    data: { username: 'admin', passwordHash, role: 'admin' },
  });
  console.warn(
    '[admin/user-store] Seeded bootstrap admin account from SS_ADMIN_BOOTSTRAP_PASSWORD — change its password after first login.',
  );
  return true;
}

export async function listUsers(): Promise<AdminUserPublic[]> {
  const users = await prisma.adminUser.findMany({ orderBy: { username: 'asc' } });
  return users.map(toPublic);
}

export async function getUser(id: string): Promise<AdminUserPublic | null> {
  const user = await prisma.adminUser.findUnique({ where: { id } });
  return user ? toPublic(user) : null;
}

export async function createUser(input: {
  username: string;
  password: string;
  role?: AdminRole;
}): Promise<AdminUserPublic> {
  const username = input.username.trim().toLowerCase();
  const role = input.role ?? 'viewer';
  validateUsername(username);
  validatePassword(input.password);
  validateRole(role);

  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    throw new Error('User already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await prisma.adminUser.create({
    data: { username, passwordHash, role },
  });
  return toPublic(user);
}

export async function updateUser(
  id: string,
  patch: { password?: string; role?: AdminRole; enabled?: boolean; dashboardLogin?: boolean },
): Promise<AdminUserPublic> {
  const data: { passwordHash?: string; role?: string; enabled?: boolean; dashboardLogin?: boolean } = {};

  if (patch.password !== undefined) {
    validatePassword(patch.password);
    data.passwordHash = await bcrypt.hash(patch.password, BCRYPT_ROUNDS);
  }
  if (patch.role !== undefined) {
    validateRole(patch.role);
    data.role = patch.role;
  }
  if (patch.enabled !== undefined) {
    data.enabled = patch.enabled;
  }
  if (patch.dashboardLogin !== undefined) {
    data.dashboardLogin = patch.dashboardLogin === true;
  }
  if (Object.keys(data).length === 0) {
    throw new Error('Nothing to update');
  }

  const user = await prisma.adminUser.update({ where: { id }, data });
  return toPublic(user);
}

export async function deleteUser(id: string): Promise<void> {
  await prisma.adminUser.delete({ where: { id } });
}

/**
 * Verify credentials. Returns the public user on success (bumping lastLoginAt),
 * null on unknown user, wrong password, or disabled account.
 */
export async function verifyPassword(
  username: string,
  password: string,
): Promise<AdminUserPublic | null> {
  const user = await prisma.adminUser.findUnique({
    where: { username: username.trim().toLowerCase() },
  });
  if (!user || !user.enabled || user.dashboardLogin === false) return null;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  const updated = await prisma.adminUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  return toPublic(updated);
}
