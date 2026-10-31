/**
 * @jest-environment node
 *
 * fleet.source = follow (task 57 / 3.6): settings in Config, assignments read from
 * sidecarmaster, the system.db snapshot as fallback, local writes refused, no token in
 * any answer or audit row.
 */

const configRows: Array<{ key: string; value: string }> = [];
const configFindMany = jest.fn(async () => configRows);
const configUpsert = jest.fn(async (args: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
  const row = configRows.find((r) => r.key === args.where.key);
  if (row) row.value = args.update.value;
  else configRows.push({ key: args.create.key, value: args.create.value });
  return {};
});
const configDeleteMany = jest.fn(async (args: { where: { key: string } }) => {
  const i = configRows.findIndex((r) => r.key === args.where.key);
  if (i >= 0) configRows.splice(i, 1);
  return { count: i >= 0 ? 1 : 0 };
});
const actionLogCreate = jest.fn(async () => ({}));
let snapshotRow: Record<string, unknown> | null = null;
const snapshotUpsert = jest.fn(async (args: { update: Record<string, unknown> }) => {
  snapshotRow = { id: 'soundsuite', ...args.update };
  return {};
});
const snapshotFindUnique = jest.fn(async () => snapshotRow);

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    config: {
      findMany: (...a: unknown[]) => configFindMany(...(a as [])),
      upsert: (...a: unknown[]) => configUpsert(...(a as [never])),
      deleteMany: (...a: unknown[]) => configDeleteMany(...(a as [never])),
    },
    actionLog: { create: (...a: unknown[]) => actionLogCreate(...(a as [])) },
    fleetSnapshot: {
      upsert: (...a: unknown[]) => snapshotUpsert(...(a as [never])),
      findUnique: (...a: unknown[]) => snapshotFindUnique(...(a as [])),
    },
  },
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  FollowModeError,
  assertLocalWrites,
  fleetSourcePublic,
  followedAssignments,
  followedProvisioning,
  getFleetSourceSettings,
  getFleetSourceView,
  getFollowStatus,
  resetFleetSourceForTests,
  saveFleetSourceSettings,
  testMasterConnection,
} from '../fleet-source';
import { parseSseFrame, shouldRefreshOn } from '@/lib/gpu/fleet-follower';

const TOKEN = 'smk_synthetic_token_for_tests_1234';
const MASTER = 'http://sm.test:3010';

const fleetBody = () => ({
  appId: 'soundsuite',
  generatedAt: '2026-10-31T01:00:00.000Z',
  modes: [{ name: 'ss-ocr' }],
  hosts: [
    {
      hostId: 'h1', name: 'BASWS34', hostname: 'basws34', agentUrl: 'http://10.0.0.1:8098/',
      aliases: ['http://10.0.0.1:8098', 'http://100.64.0.1:8098'], os: 'windows-docker-wsl2', online: true,
      masterUrl: 'http://ss.test:3000', wsPortOverride: 3002,
      roles: [
        { mode: 'ss-ocr', enabled: true, minOnline: 1, idleTimeoutMin: 10, modelOverride: 'qwen2.5vl:7b', runtime: 'docker-gpu', running: true },
        { mode: 'ss-embedding', enabled: false, minOnline: 0, idleTimeoutMin: 5, modelOverride: null, runtime: 'host', running: false },
      ],
    },
  ],
});

const fetchMock = jest.fn();
const okJson = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  resetFleetSourceForTests();
  configRows.length = 0;
  snapshotRow = null;
  fetchMock.mockReset();
  actionLogCreate.mockClear();
  snapshotUpsert.mockClear();
  delete process.env.SS_FLEET_SOURCE;
  delete process.env.SM_URL;
  delete process.env.SM_TOKEN;
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('local mode (default)', () => {
  it('is local with no rows; nothing is managed; local writes pass', async () => {
    expect((await getFleetSourceSettings()).source).toBe('local');
    expect(await fleetSourcePublic()).toEqual({ fleetSource: 'local', managedBy: null });
    expect(await followedAssignments()).toBeNull();
    expect(await followedProvisioning()).toBeNull();
    await expect(assertLocalWrites()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses follow without a master URL and a token', async () => {
    await expect(saveFleetSourceSettings({ source: 'follow' })).rejects.toThrow(/master URL and an app token/);
    await expect(saveFleetSourceSettings({ masterUrl: 'ftp://x' })).rejects.toThrow(/http/);
  });
});

describe('saving the setting', () => {
  it('stores the token write-only: views and audit rows carry only the last 4', async () => {
    const view = await saveFleetSourceSettings({ masterUrl: `${MASTER}/`, token: TOKEN }, 'op');
    expect(view).toMatchObject({ source: 'local', following: false, masterUrl: MASTER, hasToken: true, tokenHint: '1234' });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(configRows.find((r) => r.key === 'fleet.master.token')?.value).toBe(TOKEN);
    expect(actionLogCreate).toHaveBeenCalledTimes(1);
    const audit = JSON.stringify(actionLogCreate.mock.calls[0]);
    expect(audit).toContain('fleet.source.save');
    const detail = JSON.parse((actionLogCreate.mock.calls[0] as unknown as [{ data: { detail: string } }])[0].data.detail);
    expect(detail).toMatchObject({ tokenHint: '1234', hasToken: true, by: 'op' });
    expect(audit).not.toContain(TOKEN);

    fetchMock.mockResolvedValue(okJson(fleetBody()));
    const on = await saveFleetSourceSettings({ source: 'follow' }, 'op');
    expect(on.following).toBe(true);
    expect(JSON.stringify(actionLogCreate.mock.calls[1])).toContain('fleet.source.follow');
    expect(JSON.stringify(await getFleetSourceView())).not.toContain(TOKEN);
  });

  it('clearToken removes the row and follow cannot stay on without it', async () => {
    await saveFleetSourceSettings({ masterUrl: MASTER, token: TOKEN });
    const v = await saveFleetSourceSettings({ clearToken: true });
    expect(v.hasToken).toBe(false);
    expect(configRows.some((r) => r.key === 'fleet.master.token')).toBe(false);
    await expect(saveFleetSourceSettings({ source: 'follow' })).rejects.toThrow(/app token/);
  });
});

describe('follow mode', () => {
  beforeEach(async () => {
    fetchMock.mockResolvedValue(okJson(fleetBody()));
    await saveFleetSourceSettings({ masterUrl: MASTER, token: TOKEN, source: 'follow' });
  });

  it('reads assignments from the master with the bearer token, one row per host URL', async () => {
    const rows = (await followedAssignments())!;
    expect(fetchMock).toHaveBeenCalledWith(`${MASTER}/api/v1/apps/soundsuite/fleet`, expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
    }));
    expect(rows.map((r) => [r.sidecarUrl, r.mode, r.enabled])).toEqual([
      ['http://10.0.0.1:8098', 'ss-ocr', true],
      ['http://10.0.0.1:8098', 'ss-embedding', false],
      ['http://100.64.0.1:8098', 'ss-ocr', true],
      ['http://100.64.0.1:8098', 'ss-embedding', false],
    ]);
    expect(rows[0]).toMatchObject({ minOnline: 1, idleTimeoutMin: 10, modelOverride: 'qwen2.5vl:7b', runtime: 'docker-gpu' });

    const prov = (await followedProvisioning())!;
    expect(prov.map((p) => p.sidecarUrl)).toEqual(['http://10.0.0.1:8098', 'http://100.64.0.1:8098']);
    expect(prov[0]).toMatchObject({ hostOsOverride: 'windows-docker-wsl2', masterUrlForHost: 'http://ss.test:3000', masterWsPortForHost: 3002 });
    // One fetch for both reads: the copy is cached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses local writes and names the master', async () => {
    await expect(assertLocalWrites('The role assignment')).rejects.toBeInstanceOf(FollowModeError);
    await expect(assertLocalWrites('The role assignment')).rejects.toThrow(`managed by sidecarmaster at ${MASTER}`);
    const pub = await fleetSourcePublic();
    expect(pub.fleetSource).toBe('follow');
    expect(pub.managedBy).toEqual({
      url: MASTER,
      pages: { gpu: `${MASTER}/gpu`, roletypes: `${MASTER}/roletypes`, roleassign: `${MASTER}/roleassign`, hostprov: `${MASTER}/hostprov` },
    });
  });

  it('reports connected and writes the snapshot to system.db', async () => {
    await followedAssignments();
    await flush();
    const status = await getFollowStatus();
    expect(status).toMatchObject({ following: true, connected: true, hostsSeen: 1, lastError: null, fromSnapshot: false });
    expect(status.lastSyncAt).not.toBeNull();
    expect(snapshotUpsert).toHaveBeenCalledTimes(1);
    expect(snapshotRow).toMatchObject({ masterUrl: MASTER, hostCount: 1 });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('master down: with no copy in memory the system.db snapshot is used', async () => {
    await followedAssignments();
    await flush();
    expect(snapshotRow).not.toBeNull();

    // New process: memory is empty, the master does not answer, the snapshot does.
    resetFleetSourceForTests();
    fetchMock.mockReset().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const rows = (await followedAssignments())!;
    expect(rows.map((r) => r.mode)).toEqual(['ss-ocr', 'ss-embedding', 'ss-ocr', 'ss-embedding']);
    const status = await getFollowStatus();
    expect(status).toMatchObject({ following: true, connected: false, fromSnapshot: true, hostsSeen: 1 });
    expect(status.lastError).toContain('ECONNREFUSED');
    expect(status.snapshotAt).not.toBeNull();
  });

  it('master down with a copy in memory keeps that copy', async () => {
    await followedAssignments();
    fetchMock.mockReset().mockResolvedValue(okJson({ error: 'nope' }, 503));
    const { invalidateFollowedFleet } = await import('../fleet-source');
    invalidateFollowedFleet();
    const rows = (await followedAssignments())!;
    expect(rows).toHaveLength(4);
    expect((await getFollowStatus()).lastError).toContain('503');
  });

  it('master down and no snapshot: callers fall back to the local table (null)', async () => {
    resetFleetSourceForTests();
    fetchMock.mockReset().mockRejectedValue(new Error('timeout'));
    expect(await followedAssignments()).toBeNull();
  });

  it('switching back to local forgets the copy', async () => {
    await followedAssignments();
    await saveFleetSourceSettings({ source: 'local' });
    expect(await followedAssignments()).toBeNull();
    expect((await fleetSourcePublic()).managedBy).toBeNull();
    expect(JSON.stringify(actionLogCreate.mock.calls.at(-1))).toContain('fleet.source.local');
  });
});

describe('test connection', () => {
  it('answers without the token and writes an audit row', async () => {
    fetchMock.mockResolvedValue(okJson(fleetBody()));
    const r = await testMasterConnection({ masterUrl: MASTER, token: TOKEN });
    expect(r).toMatchObject({ ok: true, status: 200, hosts: 1, modes: 1, masterUrl: MASTER, error: null });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const audit = JSON.stringify(actionLogCreate.mock.calls.at(-1));
    expect(audit).toContain('fleet.source.test');
    expect(audit).not.toContain(TOKEN);
  });

  it('reports a refused token', async () => {
    fetchMock.mockResolvedValue(okJson({ error: 'no' }, 401));
    const r = await testMasterConnection({ masterUrl: MASTER, token: TOKEN });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
  });

  it('needs a token', async () => {
    await expect(testMasterConnection({ masterUrl: MASTER })).rejects.toThrow(/token/);
  });
});

describe('follower SSE helpers', () => {
  it('parses a frame and knows which events change the desired fleet', () => {
    expect(parseSseFrame('event: role.set\ndata: {"appId":"soundsuite"}')).toEqual({ event: 'role.set', data: '{"appId":"soundsuite"}' });
    expect(parseSseFrame(': ping')).toBeNull();
    expect(shouldRefreshOn('role.set')).toBe(true);
    expect(shouldRefreshOn('control.push')).toBe(true);
    expect(shouldRefreshOn('host.heartbeat')).toBe(false);
  });
});
