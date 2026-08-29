/**
 * @jest-environment node
 */
jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    adminUser: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    mcpSession: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  createDashboardSession,
  getSessionUser,
  revokeSessionByToken,
  requireAdminAuth,
  SESSION_COOKIE,
} from '../auth';

const adminUser = prisma.adminUser as unknown as Record<string, jest.Mock>;
const mcpSession = prisma.mcpSession as unknown as Record<string, jest.Mock>;

const TOKEN = 'a'.repeat(64);

const mockSessionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'sess-1',
  sessionId: TOKEN,
  source: 'dashboard',
  clientName: 'admin-dashboard',
  userId: 'testadmin',
  createdAt: new Date(),
  lastActivity: new Date(),
  userAgent: 'jest',
  ipAddress: '127.0.0.1',
  revokedAt: null,
  toolCallCount: 0,
  ...overrides,
});

const mockUserRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  username: 'testadmin',
  passwordHash: 'irrelevant',
  role: 'admin',
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastLoginAt: null,
  ...overrides,
});

const fakeRequest = (cookieValue?: string): NextRequest =>
  ({
    cookies: {
      get: (name: string) =>
        name === SESSION_COOKIE && cookieValue ? { name, value: cookieValue } : undefined,
    },
  }) as unknown as NextRequest;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createDashboardSession', () => {
  it('stores a random token as a dashboard McpSession and returns it', async () => {
    mcpSession.create.mockImplementation(async ({ data }: any) => mockSessionRow(data));
    const token = await createDashboardSession('testadmin', { userAgent: 'jest', ipAddress: '::1' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const created = mcpSession.create.mock.calls[0][0].data;
    expect(created.source).toBe('dashboard');
    expect(created.userId).toBe('testadmin');
    expect(created.sessionId).toBe(token);
  });
});

describe('getSessionUser', () => {
  it('returns the user for a valid session and bumps lastActivity', async () => {
    mcpSession.findUnique.mockResolvedValue(mockSessionRow());
    adminUser.findUnique.mockResolvedValue(mockUserRow());
    mcpSession.update.mockResolvedValue(mockSessionRow());

    const user = await getSessionUser(TOKEN);
    expect(user).toEqual({ username: 'testadmin', role: 'admin' });
    expect(mcpSession.update).toHaveBeenCalled();
  });

  it('returns null for a revoked session', async () => {
    mcpSession.findUnique.mockResolvedValue(mockSessionRow({ revokedAt: new Date() }));
    expect(await getSessionUser(TOKEN)).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    mcpSession.findUnique.mockResolvedValue(mockSessionRow({ lastActivity: old }));
    expect(await getSessionUser(TOKEN)).toBeNull();
  });

  it('returns null when the user was disabled after login', async () => {
    mcpSession.findUnique.mockResolvedValue(mockSessionRow());
    adminUser.findUnique.mockResolvedValue(mockUserRow({ enabled: false }));
    expect(await getSessionUser(TOKEN)).toBeNull();
  });

  it('returns null for a non-dashboard session', async () => {
    mcpSession.findUnique.mockResolvedValue(mockSessionRow({ source: 'mcp' }));
    expect(await getSessionUser(TOKEN)).toBeNull();
  });

  it('returns null for a short/empty token without querying', async () => {
    expect(await getSessionUser('')).toBeNull();
    expect(await getSessionUser('short')).toBeNull();
    expect(mcpSession.findUnique).not.toHaveBeenCalled();
  });
});

describe('revokeSessionByToken', () => {
  it('revokes only the un-revoked session with that token', async () => {
    mcpSession.updateMany.mockResolvedValue({ count: 1 });
    await revokeSessionByToken(TOKEN);
    expect(mcpSession.updateMany).toHaveBeenCalledWith({
      where: { sessionId: TOKEN, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe('requireAdminAuth (API gate)', () => {
  it('returns null when no cookie is present', async () => {
    expect(await requireAdminAuth(fakeRequest())).toBeNull();
    expect(mcpSession.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an invalid token', async () => {
    mcpSession.findUnique.mockResolvedValue(null);
    expect(await requireAdminAuth(fakeRequest(TOKEN))).toBeNull();
  });

  it('returns the user for a valid cookie session', async () => {
    mcpSession.findUnique.mockResolvedValue(mockSessionRow());
    adminUser.findUnique.mockResolvedValue(mockUserRow());
    mcpSession.update.mockResolvedValue(mockSessionRow());
    expect(await requireAdminAuth(fakeRequest(TOKEN))).toEqual({
      username: 'testadmin',
      role: 'admin',
    });
  });
});
