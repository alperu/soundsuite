/**
 * @jest-environment node
 *
 * fleet.source = follow (task 57 / 3.6): every admin write that sidecarmaster owns answers
 * 409 with a string `error` and `managedBy`; the GET routes keep answering and say who manages
 * the fleet; the sidecar build routes answer 404.
 */
import { NextRequest } from 'next/server';

let source: 'local' | 'follow' = 'local';
const MASTER = 'http://sm.test:3010';
const settings = () => ({ source, masterUrl: MASTER, linkUrl: '', token: source === 'follow' ? 'smk_x' : '' });

jest.mock('@/lib/db/fleet-source', () => {
  const actual = jest.requireActual('@/lib/db/fleet-source');
  return {
    ...actual,
    getFleetSourceSettings: jest.fn(async () => settings()),
    isFollowMode: jest.fn(async () => source === 'follow'),
    fleetSourcePublic: jest.fn(async () => ({ fleetSource: source, managedBy: actual.managedByFor(settings()) })),
    followedProvisioning: jest.fn(async () => (source === 'follow'
      ? [{ sidecarUrl: 'http://10.0.0.1:8098', hostOsOverride: 'linux', masterUrlForHost: null, masterWsPortForHost: null, notes: 'sm' }]
      : null)),
    getFollowedFleet: jest.fn(async () => (source === 'follow' ? { appId: 'soundsuite', hosts: [{ hostId: 'h1', name: 'n', agentUrl: 'http://10.0.0.1:8098', roles: [] }] } : null)),
    getFollowStatus: jest.fn(async () => ({ following: source === 'follow', connected: true, hostsSeen: 1 })),
  };
});
jest.mock('@/lib/admin/auth', () => ({ getSessionUser: jest.fn(async () => null), requireAdminAuth: jest.fn(async () => null) }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  getGpuLogs: () => [],
}));
jest.mock('@/lib/db/prisma', () => ({ prisma: { config: { findUnique: jest.fn(async () => null) } } }));
jest.mock('@/lib/db/config', () => ({
  getConfig: jest.fn(async () => ({ gpuSidecars: '[]' })),
  setConfigValue: jest.fn(),
  getAllSidecarIdleTimeouts: jest.fn(async () => ({})),
  setSidecarIdleTimeouts: jest.fn(),
  clearSidecarIdleTimeouts: jest.fn(),
}));
const controlContainer = jest.fn(async () => ({ ok: true }));
const pushModelRegistry = jest.fn(async () => ({ ok: true }));
jest.mock('@/lib/gpu/fleet-router', () => ({
  getFleetStatus: jest.fn(async () => ({ sidecars: [], wsRelayPort: 3002, connectedViaWs: 0 })),
  addSidecar: jest.fn(async () => ({ ok: true })), removeSidecar: jest.fn(), updateSidecarNote: jest.fn(),
  testSidecar: jest.fn(async () => ({ ok: true })), controlContainer: (...a: unknown[]) => controlContainer(...(a as [])),
  pushIdleTimeouts: jest.fn(), pushModelRegistry: (...a: unknown[]) => pushModelRegistry(...(a as [])),
  getSidecarGpus: jest.fn(), switchSidecarMode: jest.fn(), provisionSidecar: jest.fn(),
  getSidecarContainers: jest.fn(), sendToSidecar: jest.fn(),
}));
jest.mock('@/lib/gpu/status-cache', () => ({ getAggregatedPeakDemand: () => ({}), clearSidecarRole: jest.fn(), getSidecarStatus: jest.fn(() => null) }));
jest.mock('@/lib/fs-sidecar/status', () => ({ getFsSidecarStatuses: () => [] }));
const setAssignment = jest.fn(async () => ({}));
const removeAssignment = jest.fn(async () => ({}));
jest.mock('@/lib/db/role-registry', () => ({
  listAssignmentsForHost: jest.fn(async () => []),
  listAllAssignments: jest.fn(async () => [{ id: 'r1', sidecarUrl: 'http://10.0.0.1:8098', mode: 'ss-ocr' }]),
  setAssignment: (...a: unknown[]) => setAssignment(...(a as [])),
  removeAssignment: (...a: unknown[]) => removeAssignment(...(a as [])),
}));
jest.mock('@/lib/gpu/mode-catalog', () => ({ resolveModelFromConfig: jest.fn() }));
jest.mock('@/lib/gpu/ocr-model-caps', () => ({ ocrModelCaps: jest.fn() }));
const upsertProvisioning = jest.fn(async () => ({}));
jest.mock('@/lib/db/host-provisioning', () => ({
  deleteProvisioning: jest.fn(), isValidHostOs: () => true, isValidWsPort: () => true,
  listProvisioning: jest.fn(async () => [{ sidecarUrl: 'http://10.0.0.1:8098', hostOsOverride: null, masterUrlForHost: null, masterWsPortForHost: null, notes: 'local' }]),
  normalizeMasterUrl: (u: string) => u, normalizeSidecarUrl: (u: string) => u.replace(/\/+$/, ''),
  upsertProvisioning: (...a: unknown[]) => upsertProvisioning(...(a as [])),
}));
jest.mock('@/lib/gpu/provisioning-address-move', () => ({ moveProvisioningAddress: jest.fn() }));

import { GET as fleetGET, POST as fleetPOST } from '@/app/api/admin/gpu-fleet/route';
import { GET as raGET, POST as raPOST, DELETE as raDELETE } from '@/app/api/admin/role-assignments/route';
import { POST as syncPOST } from '@/app/api/admin/role-assignments/sync/route';
import { GET as hpGET, PUT as hpPUT, DELETE as hpDELETE } from '@/app/api/admin/host-provisioning/route';
import { GET as versionGET } from '@/app/api/admin/gpu/sidecars/version/route';

// Loopback origin: the admin guard lets the dashboard through with no credential.
const req = (url: string, method = 'GET', body?: unknown) => new NextRequest(new Request(`http://127.0.0.1:3000${url}`, {
  method,
  headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  body: body === undefined ? undefined : JSON.stringify(body),
}));

beforeEach(() => {
  controlContainer.mockClear(); pushModelRegistry.mockClear(); setAssignment.mockClear(); removeAssignment.mockClear(); upsertProvisioning.mockClear();
});

describe('local mode: writes go through', () => {
  beforeAll(() => { source = 'local'; });

  it('gpu-fleet start, role-assignments POST, host-provisioning PUT', async () => {
    expect((await fleetPOST(req('/api/admin/gpu-fleet', 'POST', { action: 'start', url: 'http://10.0.0.1:8098', role: 'ocr' }))).status).toBe(200);
    expect(controlContainer).toHaveBeenCalledTimes(1);
    expect((await raPOST(req('/api/admin/role-assignments', 'POST', { sidecarUrl: 'http://10.0.0.1:8098', mode: 'ss-ocr', enabled: true }))).status).toBe(200);
    expect(setAssignment).toHaveBeenCalledTimes(1);
    expect((await hpPUT(req('/api/admin/host-provisioning', 'PUT', { sidecarUrl: 'http://10.0.0.1:8098', hostOsOverride: 'linux' }))).status).toBe(200);
    expect(upsertProvisioning).toHaveBeenCalledTimes(1);
  });

  it('GET answers say local and nothing is managed', async () => {
    const body = await (await fleetGET(req('/api/admin/gpu-fleet'))).json();
    expect(body).toMatchObject({ fleetSource: 'local', managedBy: null, master: null });
    const hp = await (await hpGET(req('/api/admin/host-provisioning'))).json();
    expect(hp.provisioning[0].notes).toBe('local');
  });
});

describe('follow mode: sidecarmaster owns every write', () => {
  beforeAll(() => { source = 'follow'; });

  const expect409 = async (res: Response) => {
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain(`managed by sidecarmaster at ${MASTER}`);
    expect(body.code).toBe('FOLLOWING_SIDECARMASTER');
    expect(body.managedBy.url).toBe(MASTER);
  };

  it.each([
    ['start', { action: 'start', url: 'http://10.0.0.1:8098', role: 'ocr' }],
    ['stop', { action: 'stop', url: 'http://10.0.0.1:8098', role: 'ocr' }],
    ['add', { action: 'add', url: 'http://10.0.0.9:8098' }],
    ['remove', { action: 'remove', url: 'http://10.0.0.1:8098' }],
    ['config', { action: 'config', url: 'http://10.0.0.1:8098' }],
    ['syncModels', { action: 'syncModels', url: 'http://10.0.0.1:8098' }],
    ['saveMinOnline', { action: 'saveMinOnline', gpuMinOcr: 1 }],
    ['saveTimeouts', { action: 'saveTimeouts' }],
    ['mode', { action: 'mode', url: 'http://10.0.0.1:8098', mode: 'indexing' }],
    ['provision', { action: 'provision', url: 'http://10.0.0.1:8098' }],
    ['saveMasterUrl', { action: 'saveMasterUrl', masterUrl: 'http://x' }],
    ['updateImage', { action: 'updateImage', url: 'http://10.0.0.1:8098' }],
    ['update', { action: 'update', url: 'http://10.0.0.1:8098' }],
    ['pullModel', { action: 'pullModel', url: 'http://10.0.0.1:8098', model: 'm' }],
  ])('gpu-fleet action %s → 409, nothing reaches the sidecar', async (_name, body) => {
    await expect409(await fleetPOST(req('/api/admin/gpu-fleet', 'POST', body)));
    expect(controlContainer).not.toHaveBeenCalled();
    expect(pushModelRegistry).not.toHaveBeenCalled();
  });

  it('gpu-fleet read-only actions still answer (test, logs)', async () => {
    expect((await fleetPOST(req('/api/admin/gpu-fleet', 'POST', { action: 'test', url: 'http://10.0.0.1:8098' }))).status).toBe(200);
    expect((await fleetPOST(req('/api/admin/gpu-fleet', 'POST', { action: 'logs' }))).status).toBe(200);
  });

  it('role-assignments POST, DELETE and sync → 409', async () => {
    await expect409(await raPOST(req('/api/admin/role-assignments', 'POST', { sidecarUrl: 'http://10.0.0.1:8098', mode: 'ss-ocr', enabled: true })));
    await expect409(await raDELETE(req('/api/admin/role-assignments?sidecarUrl=http://10.0.0.1:8098&mode=ss-ocr', 'DELETE')));
    await expect409(await syncPOST(req('/api/admin/role-assignments/sync?sidecarUrl=http://10.0.0.1:8098', 'POST')));
    expect(setAssignment).not.toHaveBeenCalled();
    expect(removeAssignment).not.toHaveBeenCalled();
    expect(pushModelRegistry).not.toHaveBeenCalled();
  });

  it('host-provisioning PUT and DELETE → 409', async () => {
    await expect409(await hpPUT(req('/api/admin/host-provisioning', 'PUT', { sidecarUrl: 'http://10.0.0.1:8098', hostOsOverride: 'linux' })));
    await expect409(await hpDELETE(req('/api/admin/host-provisioning?sidecarUrl=http://10.0.0.1:8098', 'DELETE')));
    expect(upsertProvisioning).not.toHaveBeenCalled();
  });

  it('GET answers keep working and carry managedBy with the four page links', async () => {
    const fleet = await (await fleetGET(req('/api/admin/gpu-fleet'))).json();
    expect(fleet.fleetSource).toBe('follow');
    expect(fleet.managedBy).toEqual({
      url: MASTER,
      pages: { gpu: `${MASTER}/gpu`, roletypes: `${MASTER}/roletypes`, roleassign: `${MASTER}/roleassign`, hostprov: `${MASTER}/hostprov` },
    });
    expect(fleet.master.hosts).toHaveLength(1);
    expect(fleet.master.status.following).toBe(true);

    const ra = await (await raGET(req('/api/admin/role-assignments'))).json();
    expect(ra.managedBy.url).toBe(MASTER);
    expect(ra.assignments).toHaveLength(1);

    const hp = await (await hpGET(req('/api/admin/host-provisioning'))).json();
    expect(hp.managedBy.url).toBe(MASTER);
    expect(hp.provisioning[0].notes).toBe('sm');
  });

  it('sidecar build routes answer 404: sidecarmaster ships the builds', async () => {
    expect((await versionGET()).status).toBe(404);
  });
});
