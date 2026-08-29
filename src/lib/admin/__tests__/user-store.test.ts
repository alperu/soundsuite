/**
 * @jest-environment node
 */
import bcrypt from 'bcryptjs';

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    adminUser: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/prisma';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  verifyPassword,
  ensureDefaultAdmin,
} from '../user-store';

const mockUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  username: 'testadmin',
  passwordHash: bcrypt.hashSync('hunter2secret', 4),
  role: 'admin',
  enabled: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  lastLoginAt: null,
  ...overrides,
});

const adminUser = prisma.adminUser as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('listUsers', () => {
  it('returns users without passwordHash', async () => {
    adminUser.findMany.mockResolvedValue([mockUser()]);
    const users = await listUsers();
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('testadmin');
    expect(users[0]).not.toHaveProperty('passwordHash');
  });
});

describe('createUser', () => {
  it('hashes the password and lowercases the username', async () => {
    adminUser.findUnique.mockResolvedValue(null);
    adminUser.create.mockImplementation(async ({ data }: any) =>
      mockUser({ id: 'user-2', username: data.username, passwordHash: data.passwordHash, role: data.role }),
    );

    const user = await createUser({ username: 'NewUser', password: 'longenough1', role: 'viewer' });
    expect(user.username).toBe('newuser');
    expect(user.role).toBe('viewer');
    expect(user).not.toHaveProperty('passwordHash');

    const createdWith = adminUser.create.mock.calls[0][0].data;
    expect(createdWith.passwordHash).not.toBe('longenough1');
    expect(bcrypt.compareSync('longenough1', createdWith.passwordHash)).toBe(true);
  });

  it('rejects duplicate usernames', async () => {
    adminUser.findUnique.mockResolvedValue(mockUser());
    await expect(createUser({ username: 'testadmin', password: 'longenough1' })).rejects.toThrow(
      'User already exists',
    );
  });

  it('rejects short passwords', async () => {
    await expect(createUser({ username: 'validname', password: 'short' })).rejects.toThrow(
      /at least 8/,
    );
  });

  it('rejects invalid usernames', async () => {
    await expect(createUser({ username: 'a b!', password: 'longenough1' })).rejects.toThrow(
      /Username/,
    );
  });
});

describe('updateUser', () => {
  it('rehashes password on reset', async () => {
    adminUser.update.mockImplementation(async ({ data }: any) => mockUser({ passwordHash: data.passwordHash }));
    await updateUser('user-1', { password: 'newpassword9' });
    const updatedWith = adminUser.update.mock.calls[0][0].data;
    expect(bcrypt.compareSync('newpassword9', updatedWith.passwordHash)).toBe(true);
  });

  it('toggles enabled', async () => {
    adminUser.update.mockResolvedValue(mockUser({ enabled: false }));
    const user = await updateUser('user-1', { enabled: false });
    expect(user.enabled).toBe(false);
    expect(adminUser.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { enabled: false } });
  });

  it('rejects an empty patch', async () => {
    await expect(updateUser('user-1', {})).rejects.toThrow('Nothing to update');
  });
});

describe('deleteUser', () => {
  it('deletes by id', async () => {
    adminUser.delete.mockResolvedValue(mockUser());
    await deleteUser('user-1');
    expect(adminUser.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
  });
});

describe('ensureDefaultAdmin', () => {
  const ENV_KEY = 'SS_ADMIN_BOOTSTRAP_PASSWORD';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('seeds an enabled admin account when the table is empty', async () => {
    process.env[ENV_KEY] = 'synthetic-bootstrap';
    adminUser.count.mockResolvedValue(0);
    adminUser.create.mockImplementation(async ({ data }: any) => mockUser(data));

    expect(await ensureDefaultAdmin()).toBe(true);
    const created = adminUser.create.mock.calls[0][0].data;
    expect(created.username).toBe('admin');
    expect(created.role).toBe('admin');
    expect(bcrypt.compareSync('synthetic-bootstrap', created.passwordHash)).toBe(true);
  });

  it('is idempotent — does nothing when users already exist', async () => {
    process.env[ENV_KEY] = 'synthetic-bootstrap';
    adminUser.count.mockResolvedValue(1);
    expect(await ensureDefaultAdmin()).toBe(false);
    expect(adminUser.create).not.toHaveBeenCalled();
  });

  it('does nothing when the bootstrap env var is unset', async () => {
    delete process.env[ENV_KEY];
    expect(await ensureDefaultAdmin()).toBe(false);
    expect(adminUser.count).not.toHaveBeenCalled();
    expect(adminUser.create).not.toHaveBeenCalled();
  });
});

describe('verifyPassword', () => {
  it('returns the user and bumps lastLoginAt on success', async () => {
    adminUser.findUnique.mockResolvedValue(mockUser());
    adminUser.update.mockResolvedValue(mockUser({ lastLoginAt: new Date() }));
    const user = await verifyPassword('testadmin', 'hunter2secret');
    expect(user?.username).toBe('testadmin');
    expect(adminUser.update).toHaveBeenCalled();
  });

  it('returns null for a wrong password', async () => {
    adminUser.findUnique.mockResolvedValue(mockUser());
    expect(await verifyPassword('testadmin', 'wrongpassword')).toBeNull();
  });

  it('returns null for a disabled account even with the right password', async () => {
    adminUser.findUnique.mockResolvedValue(mockUser({ enabled: false }));
    expect(await verifyPassword('testadmin', 'hunter2secret')).toBeNull();
  });

  it('returns null for an unknown user', async () => {
    adminUser.findUnique.mockResolvedValue(null);
    expect(await verifyPassword('ghost', 'whatever123')).toBeNull();
  });
});
