/** @jest-environment node */
/**
 * sidecarmaster is the GPU authority (user decision 2026-11-20).
 *
 * Only sidecarmaster's role assignment opens the GPU start gate and changes GPU
 * roles. Other masters may connect, push their sandbox slot and acquire a role
 * sidecarmaster runs, but may not add, remove, start or stop GPU roles.
 * ss-cuda and the NetBird / Caddy companions are not GPU roles.
 *
 * Fakes only. All names are made up.
 */

const mockLogLines: string[] = [];
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: (msg: string) => { mockLogLines.push(msg); },
    warn: (msg: string) => { mockLogLines.push(msg); },
    error: (msg: string) => { mockLogLines.push(msg); },
    debug: () => {},
  }),
}));

// ─── Fake Docker: a set of created and running container names ─────────────
const mockDocker = {
  created: new Set<string>(),
  running: new Set<string>(),
  restartPolicy: new Map<string, string>(),
};
const mockStartContainer = jest.fn(async (name?: string) => {
  mockDocker.running.add(name as string);
  return 'started';
});
const mockStopContainer = jest.fn(async () => 'stopped');
const mockCreateContainer = jest.fn(async (role: string) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { state } = require('@/lib/state');
  mockDocker.created.add(state.registry[role].containerName);
  return { Id: 'fake-id' };
});
const mockClearRestartPolicy = jest.fn(async (name: string) => { mockDocker.restartPolicy.set(name, 'no'); });
jest.mock('@/lib/docker', () => ({
  getContainerState: jest.fn(async (name: string) => {
    if (!mockDocker.created.has(name)) return { exists: false, status: 'not_found', name };
    return {
      exists: true,
      name,
      status: mockDocker.running.has(name) ? 'running' : 'exited',
      restartPolicy: mockDocker.restartPolicy.get(name) ?? 'no',
    };
  }),
  startContainer: (name?: string) => mockStartContainer(name),
  stopContainer: () => mockStopContainer(),
  createContainer: (role: string) => mockCreateContainer(role),
  clearRestartPolicy: (name: string) => mockClearRestartPolicy(name),
  removeContainer: jest.fn(async () => {}),
  pullImage: jest.fn(async () => {}),
  dockerRequest: jest.fn(async () => ({ status: 200, body: '{}' })),
  getDockerHostName: jest.fn(() => 'fake-docker-host'),
  getDockerMode: jest.fn(() => 'socket'),
  isDockerAvailable: jest.fn(() => true),
  buildExpectedConfig: jest.fn(() => ({})),
  detectConfigDrift: jest.fn(() => ({ hasDrift: false, drifts: [] })),
  isPortConflict: jest.fn(() => false),
  findContainerOnPort: jest.fn(async () => null),
  listContainersByPrefix: jest.fn(async () => []),
  getImageId: jest.fn(async () => null),
}));

// ─── Fake Ollama ───────────────────────────────────────────────────────────
const mockOllamaLoad = jest.fn(async () => true);
const mockOllamaPs = jest.fn(async () => [] as unknown[]);
jest.mock('@/lib/ollama-api', () => ({
  ollamaList: jest.fn(async () => ['test-embed:1b', 'test-host:1b']),
  ollamaListCached: jest.fn(async () => ['test-embed:1b', 'test-host:1b']),
  ollamaPs: () => mockOllamaPs(),
  ollamaPsCached: () => mockOllamaPs(),
  ollamaPull: jest.fn(async () => {}),
  ollamaLoad: () => mockOllamaLoad(),
  ollamaUnload: jest.fn(async () => true),
  ollamaShow: jest.fn(async () => true),
  ollamaIsReady: jest.fn(async () => ({ ready: true })),
  waitForOllama: jest.fn(async () => {}),
}));

jest.mock('@/lib/gpu', () => ({ discoverGpus: jest.fn(async () => []) }));
jest.mock('@/lib/vram-accountant', () => ({ snapshotVram: jest.fn(async () => ({ freeMb: 100_000, roles: [] })) }));
jest.mock('@/lib/dmr-api', () => ({ dmrIsReady: jest.fn(async () => ({ ready: false })), dmrListModels: jest.fn(async () => []) }));
jest.mock('@/lib/config', () => ({ saveConfig: jest.fn(), getConfigPath: jest.fn(() => '/tmp/none') }));
jest.mock('@/lib/host-ollama-watchdog', () => ({ startHostOllamaWatchdog: jest.fn(), stopHostOllamaWatchdog: jest.fn() }));
jest.mock('@/lib/netbird-runtime', () => ({ netbirdSummary: jest.fn(() => ({})) }));
jest.mock('@/lib/self-update', () => ({
  checkForUpdate: jest.fn(async () => ({ available: false })),
  findUpdateSource: jest.fn(async () => null),
  orderForUpdates: jest.fn((x: unknown) => x),
  performUpdate: jest.fn(async () => false),
}));

import { state, ensureMaster, masterReady, gpuAuthorityOf, type MasterConnection } from '@/lib/state';
import {
  __testAutoProvision,
  __testExecuteCommand,
  __testHeldGpuStartsSettled,
  __testResetGpuGate,
  gpuCommandRefusal,
  authorityAssigned,
} from '@/lib/ws-client';


const SM_URL = 'http://sm.example.test:3010';
const OTHER_URL = 'http://other.example.test:3000';

function testRegistry() {
  return {
    embedding: {
      image: 'fake/ollama', model: 'test-embed:1b', port: 31434, vram: 1000,
      type: 'ollama', modes: ['indexing', 'searching'], containerName: 'ss-test-embedding', runtime: 'docker',
    },
  } as unknown as typeof state.registry;
}

function connect(url: string): MasterConnection {
  const m = ensureMaster(url);
  m.connectionMode = 'websocket';
  m.ws = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as MasterConnection['ws'];
  return m;
}

const claim = (url: string) => ({ authority: { name: 'sidecarmaster', canonicalUrl: url } });

async function config(m: MasterConnection, payload: Record<string, unknown>) {
  const r = await __testExecuteCommand(m, { id: 'cfg', action: 'config', payload });
  await __testHeldGpuStartsSettled();
  return r;
}

beforeEach(() => {
  mockDocker.created.clear();
  mockDocker.running.clear();
  mockStartContainer.mockClear();
  mockStopContainer.mockClear();
  mockOllamaLoad.mockClear();
  mockLogLines.length = 0;
  state.masters.clear();
  state.registry = testRegistry();
  state.hostOs = 'linux';
  state.minOnline = {};
  state.idleTimeouts = {};
  delete process.env.SS_GPU_AUTHORITY;
  __testResetGpuGate();
});

describe('who is the GPU authority', () => {
  it('a config that claims the URL this master announced is the authority', () => {
    const m = connect(SM_URL);
    m.announcedCanonicalUrl = 'https://sm.example.test';
    expect(gpuAuthorityOf(m, claim('https://sm.example.test/'))).toBe(true);
  });

  it('a master cannot claim another master\'s identity', () => {
    const m = connect(OTHER_URL);
    m.announcedCanonicalUrl = 'https://other.example.test';
    expect(gpuAuthorityOf(m, claim('https://sm.example.test'))).toBe(false);
  });

  it('no claim, or a claim with another name, is not the authority', () => {
    const m = connect(SM_URL);
    expect(gpuAuthorityOf(m, {})).toBe(false);
    expect(gpuAuthorityOf(m, { authority: { name: 'soundsuite', canonicalUrl: SM_URL } })).toBe(false);
  });

  it('SS_GPU_AUTHORITY pins the authority URL', () => {
    const m = connect(SM_URL);
    process.env.SS_GPU_AUTHORITY = 'https://pinned.example.test';
    expect(gpuAuthorityOf(m, claim(SM_URL))).toBe(false);
    expect(gpuAuthorityOf(m, claim('https://pinned.example.test/'))).toBe(true);
  });
});

describe('configs', () => {
  it('a config from another master does not open the gate and does not change GPU roles', async () => {
    const other = connect(OTHER_URL);
    await config(other, { enabledModes: ['ss-reranker'], minOnline: { embedding: 0 }, idleTimeouts: { embedding: 1 } });

    expect(masterReady()).toBe(false);
    expect(Object.keys(state.registry)).toEqual(['embedding']);
    expect(state.minOnline.embedding).toBeUndefined();
    expect(state.idleTimeouts.embedding).toBeUndefined();
    expect(mockStartContainer).not.toHaveBeenCalled();
    expect(mockLogLines.some((l) => l.includes('not the GPU authority'))).toBe(true);
  });

  it('sidecarmaster\'s config opens the gate', async () => {
    const sm = connect(SM_URL);
    await config(sm, { idleTimeouts: {}, ...claim(SM_URL) });
    expect(sm.gpuAuthority).toBe(true);
    expect(masterReady()).toBe(true);
  });

  it('a config from another master keeps its sandbox slot and is not refused', async () => {
    const other = connect(OTHER_URL);
    const r = await config(other, { openrouter: null });
    expect(r.error).toBeUndefined();
  });
});

describe('commands', () => {
  async function smReady() {
    const sm = connect(SM_URL);
    await config(sm, { idleTimeouts: {}, ...claim(SM_URL) });
    return sm;
  }

  it('another master may acquire a role sidecarmaster assigned', async () => {
    await smReady();
    const other = connect(OTHER_URL);
    expect(gpuCommandRefusal(other, 'acquire', 'embedding')).toBeNull();
  });

  it('another master may not acquire a role sidecarmaster did not assign', async () => {
    await smReady();
    const other = connect(OTHER_URL);
    expect(gpuCommandRefusal(other, 'acquire', 'reranker')).toContain('not assigned');
  });

  it('another master may not start, stop, provision or load', async () => {
    await smReady();
    const other = connect(OTHER_URL);
    for (const action of ['start', 'stop', 'mode', 'provision', 'loadModel', 'pullModel']) {
      const r = await __testExecuteCommand(other, { id: action, action, payload: { role: 'embedding' } });
      expect(String(r.error)).toContain('sidecarmaster');
    }
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('read-only commands from another master still work', async () => {
    const other = connect(OTHER_URL);
    for (const action of ['status', 'health', 'release']) expect(gpuCommandRefusal(other, action, 'embedding')).toBeNull();
  });

  it('no role is assigned before sidecarmaster sent its config', () => {
    expect(authorityAssigned('embedding')).toBe(false);
  });
});
