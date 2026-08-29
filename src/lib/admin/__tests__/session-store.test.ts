/**
 * @jest-environment node
 */
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    mcpSession: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/prisma';
import {
  deriveSessionId,
  recordActivity,
  listSessions,
  revokeSession,
  pruneStaleSessions,
} from '../session-store';

const mockSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-1',
  sessionId: 'abc123',
  source: 'mcp',
  clientName: 'test-client',
  userId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastActivity: new Date('2026-01-01T00:00:00Z'),
  userAgent: 'jest',
  ipAddress: '127.0.0.1',
  revokedAt: null,
  toolCallCount: 1,
  ...overrides,
});

const mcpSession = prisma.mcpSession as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('deriveSessionId', () => {
  it('is deterministic for the same IP + user-agent', () => {
    expect(deriveSessionId('10.0.0.1', 'agent-a')).toBe(deriveSessionId('10.0.0.1', 'agent-a'));
  });

  it('differs for different inputs', () => {
    expect(deriveSessionId('10.0.0.1', 'agent-a')).not.toBe(deriveSessionId('10.0.0.2', 'agent-a'));
  });
});

describe('recordActivity', () => {
  it('upserts keyed on sessionId and increments toolCallCount', async () => {
    mcpSession.upsert.mockResolvedValue(mockSession());
    const session = await recordActivity({ sessionId: 'abc123', source: 'mcp' });
    expect(session.sessionId).toBe('abc123');

    const args = mcpSession.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ sessionId: 'abc123' });
    expect(args.create.toolCallCount).toBe(1);
    expect(args.update.toolCallCount).toEqual({ increment: 1 });
    expect(args.update.lastActivity).toBeInstanceOf(Date);
  });
});

describe('listSessions', () => {
  it('filters active sessions by revokedAt null', async () => {
    mcpSession.findMany.mockResolvedValue([mockSession()]);
    await listSessions({ status: 'active' });
    expect(mcpSession.findMany).toHaveBeenCalledWith({
      where: { revokedAt: null },
      orderBy: { lastActivity: 'desc' },
    });
  });

  it('filters revoked sessions and source', async () => {
    mcpSession.findMany.mockResolvedValue([]);
    await listSessions({ status: 'revoked', source: 'dashboard' });
    expect(mcpSession.findMany).toHaveBeenCalledWith({
      where: { revokedAt: { not: null }, source: 'dashboard' },
      orderBy: { lastActivity: 'desc' },
    });
  });

  it('applies no filter for status all', async () => {
    mcpSession.findMany.mockResolvedValue([]);
    await listSessions({ status: 'all' });
    expect(mcpSession.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { lastActivity: 'desc' },
    });
  });
});

describe('revokeSession', () => {
  it('sets revokedAt on an active session', async () => {
    mcpSession.findUnique.mockResolvedValue(mockSession());
    mcpSession.update.mockResolvedValue(mockSession({ revokedAt: new Date() }));
    const session = await revokeSession('sess-1');
    expect(session.revokedAt).not.toBeNull();
    expect(mcpSession.update).toHaveBeenCalledWith({
      where: { id: 'sess-1' },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('is idempotent for an already-revoked session', async () => {
    const revokedAt = new Date('2026-02-01T00:00:00Z');
    mcpSession.findUnique.mockResolvedValue(mockSession({ revokedAt }));
    const session = await revokeSession('sess-1');
    expect(session.revokedAt).toBe(revokedAt);
    expect(mcpSession.update).not.toHaveBeenCalled();
  });

  it('throws for an unknown session', async () => {
    mcpSession.findUnique.mockResolvedValue(null);
    await expect(revokeSession('nope')).rejects.toThrow('Session not found');
  });
});

describe('pruneStaleSessions', () => {
  it('deletes sessions idle beyond the cutoff and returns the count', async () => {
    mcpSession.deleteMany.mockResolvedValue({ count: 3 });
    const count = await pruneStaleSessions(30);
    expect(count).toBe(3);

    const cutoff = mcpSession.deleteMany.mock.calls[0][0].where.lastActivity.lt as Date;
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5000);
  });
});
