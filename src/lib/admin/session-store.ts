import { createHash } from 'crypto';
import { prisma } from '@/lib/db/prisma';

/**
 * MCP/dashboard session store — records client activity for the Sessions tab.
 * Sessions are keyed by an opaque sessionId (the mcp-session-id header when the
 * client supplies one, otherwise a hash of IP + user-agent).
 */

export type SessionSource = 'mcp' | 'dashboard';
export type SessionStatusFilter = 'active' | 'revoked' | 'all';

export interface SessionRecord {
  id: string;
  sessionId: string;
  source: string;
  clientName: string | null;
  userId: string | null;
  createdAt: Date;
  lastActivity: Date;
  userAgent: string | null;
  ipAddress: string | null;
  revokedAt: Date | null;
  toolCallCount: number;
}

export const STALE_SESSION_DAYS = 30;

/** Stable session identity for clients that don't send an mcp-session-id. */
export function deriveSessionId(ipAddress: string, userAgent: string): string {
  return createHash('sha256').update(`${ipAddress}|${userAgent}`).digest('hex').slice(0, 32);
}

/**
 * Upsert a session and bump lastActivity + toolCallCount in one call.
 * Returns the record so callers can check revokedAt.
 */
export async function recordActivity(input: {
  sessionId: string;
  source?: SessionSource;
  clientName?: string | null;
  userId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<SessionRecord> {
  return prisma.mcpSession.upsert({
    where: { sessionId: input.sessionId },
    create: {
      sessionId: input.sessionId,
      source: input.source ?? 'mcp',
      clientName: input.clientName ?? null,
      userId: input.userId ?? null,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      toolCallCount: 1,
    },
    update: {
      lastActivity: new Date(),
      toolCallCount: { increment: 1 },
      ...(input.clientName ? { clientName: input.clientName } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
  });
}

export async function listSessions(filter?: {
  status?: SessionStatusFilter;
  source?: SessionSource;
}): Promise<SessionRecord[]> {
  const where: { revokedAt?: null | { not: null }; source?: string } = {};
  if (filter?.status === 'active') where.revokedAt = null;
  if (filter?.status === 'revoked') where.revokedAt = { not: null };
  if (filter?.source) where.source = filter.source;

  return prisma.mcpSession.findMany({
    where,
    orderBy: { lastActivity: 'desc' },
  });
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  return prisma.mcpSession.findUnique({ where: { id } });
}

/** Mark a session revoked. Idempotent — an already-revoked session keeps its original revokedAt. */
export async function revokeSession(id: string): Promise<SessionRecord> {
  const existing = await prisma.mcpSession.findUnique({ where: { id } });
  if (!existing) throw new Error('Session not found');
  if (existing.revokedAt) return existing;

  return prisma.mcpSession.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
}

/** Delete sessions with no activity for more than `days` days. Returns the count removed. */
export async function pruneStaleSessions(days: number = STALE_SESSION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.mcpSession.deleteMany({
    where: { lastActivity: { lt: cutoff } },
  });
  return result.count;
}
