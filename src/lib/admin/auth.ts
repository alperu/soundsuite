import { randomBytes } from 'crypto';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import type { AdminRole } from '@/lib/admin/user-store';

/**
 * Cookie-based auth for the admin dashboard. A login creates an McpSession row
 * (source 'dashboard') whose sessionId is the random token stored in the
 * httpOnly cookie — so dashboard logins show up in the Sessions tab, and
 * revoking one there invalidates the cookie session.
 */

export const SESSION_COOKIE = 'ss_admin_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AuthUser {
  username: string;
  role: AdminRole;
}

export async function createDashboardSession(
  username: string,
  meta: { userAgent?: string | null; ipAddress?: string | null },
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await prisma.mcpSession.create({
    data: {
      sessionId: token,
      source: 'dashboard',
      clientName: 'admin-dashboard',
      userId: username,
      userAgent: meta.userAgent ?? null,
      ipAddress: meta.ipAddress ?? null,
    },
  });
  return token;
}

/**
 * Resolve a session token to its user. Returns null for unknown, revoked, or
 * expired sessions, and for users that were since disabled or deleted.
 * Bumps lastActivity on each successful check.
 */
export async function getSessionUser(token: string): Promise<AuthUser | null> {
  if (!token || token.length < 32) return null;

  const session = await prisma.mcpSession.findUnique({ where: { sessionId: token } });
  if (!session || session.revokedAt || session.source !== 'dashboard' || !session.userId) {
    return null;
  }
  if (Date.now() - session.lastActivity.getTime() > SESSION_MAX_AGE_SECONDS * 1000) {
    return null;
  }

  const user = await prisma.adminUser.findUnique({ where: { username: session.userId } });
  if (!user || !user.enabled) return null;

  await prisma.mcpSession.update({
    where: { id: session.id },
    data: { lastActivity: new Date() },
  });

  return { username: user.username, role: user.role === 'admin' ? 'admin' : 'viewer' };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await prisma.mcpSession.updateMany({
    where: { sessionId: token, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Auth gate for admin API routes. Returns the user, or null → caller sends 401. */
export async function requireAdminAuth(req: NextRequest): Promise<AuthUser | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSessionUser(token);
}
