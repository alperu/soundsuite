/** @jest-environment node */
/**
 * GPU roles wait for a master (bug 2026-11-19).
 *
 * A sidecar that restarted with no master connected started every GPU role
 * by itself: autoProvision started the active roles and loaded their models,
 * and the heartbeat auto-load put models into VRAM. The rule now: anything
 * that uses the GPU waits for masterReady() (state.ts) — a master is connected
 * AND has sent its config at least once since boot. Explicit master commands
 * still work. When all masters drop, nothing running is stopped and nothing
 * new starts.
 *
 * Fakes only: Docker, Ollama and the GPU probe are mocked at the module
 * boundary. Nothing here reaches a real host, Docker or Ollama.
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

import { state, ensureMaster, ensureSet, masterReady, type MasterConnection } from '@/lib/state';
import {
  __testAutoProvision,
  __testExecuteCommand,
  __testHeldGpuStartsSettled,
  __testResetGpuGate,
} from '@/lib/ws-client';
import { getAllContainerStates } from '@/lib/containers';
import { __resetTasksForTest } from '@/lib/task-tracker';

const MASTER_URL = 'http://master.example.test:3000';

/** Two GPU roles plus one host-runtime (native Ollama) role. Made-up names. */
function testRegistry() {
  return {
    embedding: {
      image: 'fake/ollama', model: 'test-embed:1b', port: 31434, vram: 1000,
      type: 'ollama', modes: ['indexing', 'searching'], containerName: 'ss-test-embedding', runtime: 'docker',
    },
    reranker: {
      image: 'fake/vllm', model: 'test-rerank', port: 31801, vram: 2000,
      type: 'vllm', modes: ['indexing', 'searching'], containerName: 'ss-test-reranker', runtime: 'docker',
    },
  } as unknown as typeof state.registry;
}

function hostRuntimeRole() {
  return {
    image: '', model: 'test-host:1b', port: 31435, vram: 1000,
    type: 'ollama', modes: ['indexing', 'searching'], containerName: 'ss-test-host', runtime: 'host',
  } as unknown as typeof state.registry[string];
}

function connectMaster(): MasterConnection {
  const m = ensureMaster(MASTER_URL);
  m.connectionMode = 'websocket';
  m.ws = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as MasterConnection['ws'];
  return m;
}

function dropMaster(m: MasterConnection): void {
  m.connectionMode = 'disconnected';
  m.ws = null;
}

async function sendConfig(m: MasterConnection): Promise<void> {
  await __testExecuteCommand(m, { id: 'cfg-1', action: 'config', payload: { idleTimeouts: {}, authority: { name: 'sidecarmaster', canonicalUrl: m.serverUrl } } });
  await __testHeldGpuStartsSettled();
}

beforeEach(() => {
  mockDocker.created.clear();
  mockDocker.running.clear();
  mockDocker.restartPolicy.clear();
  mockStartContainer.mockClear();
  mockStopContainer.mockClear();
  mockCreateContainer.mockClear();
  mockClearRestartPolicy.mockClear();
  mockOllamaLoad.mockClear();
  mockOllamaPs.mockReset();
  mockOllamaPs.mockResolvedValue([]);
  mockLogLines.length = 0;
  const gate = (globalThis as unknown as Record<string, { heldLogged?: boolean } | undefined>)['__ss_sidecar__gpu-gate'];
  if (gate) gate.heldLogged = false;

  state.masters.clear();
  state.registry = testRegistry();
  state.hostOs = 'linux';
  state.minOnline = {};
  state.lastModelAttempt = {};
  state.pullFailCount = {};
  ensureSet('modelLoading').clear();
  ensureSet('userStopped').clear();
  __resetTasksForTest();
  __testResetGpuGate();
});

describe('boot with no master', () => {
  it('creates the containers but starts no GPU container and loads no model', async () => {
    await __testAutoProvision();

    expect(mockCreateContainer).toHaveBeenCalledTimes(2);
    expect(mockStartContainer).not.toHaveBeenCalled();
    expect(mockOllamaLoad).not.toHaveBeenCalled();
    expect(masterReady()).toBe(false);
  });

  it('logs one clear line that GPU starts are held', async () => {
    await __testAutoProvision();
    await __testAutoProvision();

    const held = mockLogLines.filter((l) => l.startsWith('Waiting for sidecarmaster before starting GPU roles'));
    expect(held).toHaveLength(1);
  });

  it('a connected master that has not sent its config yet does not open the gate', async () => {
    connectMaster();
    await __testAutoProvision();

    expect(masterReady()).toBe(false);
    expect(mockStartContainer).not.toHaveBeenCalled();
  });

  it('sets an old unless-stopped role container to restart policy no', async () => {
    mockDocker.created.add('ss-test-embedding');
    mockDocker.restartPolicy.set('ss-test-embedding', 'unless-stopped');

    await __testAutoProvision();

    expect(mockClearRestartPolicy).toHaveBeenCalledWith('ss-test-embedding');
    expect(mockStartContainer).not.toHaveBeenCalled();
  });
});

describe('first master connect plus config', () => {
  it('starts the held active roles and loads the model', async () => {
    await __testAutoProvision();
    expect(mockStartContainer).not.toHaveBeenCalled();

    const m = connectMaster();
    await sendConfig(m);

    expect(masterReady()).toBe(true);
    expect(mockStartContainer).toHaveBeenCalledWith('ss-test-embedding');
    expect(mockStartContainer).toHaveBeenCalledWith('ss-test-reranker');
    expect(mockOllamaLoad).toHaveBeenCalledTimes(1);
  });

  it('a later config does not start the roles again', async () => {
    await __testAutoProvision();
    const m = connectMaster();
    await sendConfig(m);
    mockStartContainer.mockClear();

    await sendConfig(m);

    expect(mockStartContainer).not.toHaveBeenCalled();
  });
});

describe('heartbeat model auto-load', () => {
  beforeEach(() => {
    // The container is up but its model is not in VRAM.
    mockDocker.created.add('ss-test-embedding');
    mockDocker.running.add('ss-test-embedding');
  });

  it('loads nothing when no master is connected', async () => {
    await getAllContainerStates();

    expect(mockOllamaLoad).not.toHaveBeenCalled();
  });

  it('loads the model once a master is connected and has sent its config', async () => {
    const m = connectMaster();
    await sendConfig(m);
    mockOllamaLoad.mockClear();

    await getAllContainerStates();

    expect(mockOllamaLoad).toHaveBeenCalledTimes(1);
  });
});

describe('a host-runtime (native Ollama) role also waits', () => {
  beforeEach(() => {
    state.registry = { 'host-embed': hostRuntimeRole() } as typeof state.registry;
  });

  it('boot loads nothing into the host Ollama', async () => {
    await __testAutoProvision();

    expect(mockOllamaLoad).not.toHaveBeenCalled();
    expect(mockStartContainer).not.toHaveBeenCalled();
  });

  it('heartbeat loads nothing into the host Ollama without a master', async () => {
    await getAllContainerStates();

    expect(mockOllamaLoad).not.toHaveBeenCalled();
  });

  it('heartbeat loads the host model once a master is ready', async () => {
    const m = connectMaster();
    await sendConfig(m);
    mockOllamaLoad.mockClear();

    await getAllContainerStates();

    expect(mockOllamaLoad).toHaveBeenCalledTimes(1);
  });
});

describe('an explicit start', () => {
  it('from sidecarmaster works, even before the gate opened on its config', async () => {
    mockDocker.created.add('ss-test-reranker');
    const m = connectMaster();
    m.gpuAuthority = true;

    const result = await __testExecuteCommand(m, { id: 'cmd-1', action: 'start', payload: { role: 'reranker' } });

    expect(result.error).toBeUndefined();
    expect(mockStartContainer).toHaveBeenCalledWith('ss-test-reranker');
  });

  it('from a master that is not the GPU authority is refused', async () => {
    mockDocker.created.add('ss-test-reranker');
    const m = connectMaster();

    const result = await __testExecuteCommand(m, { id: 'cmd-1', action: 'start', payload: { role: 'reranker' } });

    expect(String(result.error)).toContain('sidecarmaster');
    expect(mockStartContainer).not.toHaveBeenCalled();
  });
});

describe('all masters drop', () => {
  it('stops nothing that runs and starts nothing new', async () => {
    await __testAutoProvision();
    const m = connectMaster();
    await sendConfig(m);
    expect(mockDocker.running.has('ss-test-embedding')).toBe(true);

    dropMaster(m);
    expect(masterReady()).toBe(false);

    // A new role arrives from saved state; boot-style provision and heartbeat
    // both run while no master is connected.
    mockStartContainer.mockClear();
    mockOllamaLoad.mockClear();
    mockDocker.running.delete('ss-test-reranker');
    await __testAutoProvision();
    await getAllContainerStates();

    expect(mockStartContainer).not.toHaveBeenCalled();
    expect(mockOllamaLoad).not.toHaveBeenCalled();
    expect(mockStopContainer).not.toHaveBeenCalled();
    expect(mockDocker.running.has('ss-test-embedding')).toBe(true);
  });
});

describe('opted-out role (minOnline=0) with an old restart policy', () => {
  it('sets the policy to no and starts nothing', async () => {
    state.minOnline = { embedding: 0 };
    mockDocker.created.add('ss-test-embedding');
    mockDocker.restartPolicy.set('ss-test-embedding', 'unless-stopped');

    await __testAutoProvision();

    expect(mockClearRestartPolicy).toHaveBeenCalledWith('ss-test-embedding');
    expect(mockStartContainer).not.toHaveBeenCalledWith('ss-test-embedding');
  });
});

describe('several masters', () => {
  it('opens when one master is connected and has sent its config', async () => {
    const a = ensureMaster('http://master-a.example.test:3000');
    a.connectionMode = 'disconnected';
    a.configReceivedAt = Date.now(); // sent config earlier, now gone
    const b = ensureMaster('http://master-b.example.test:3000');
    b.connectionMode = 'websocket';
    b.ws = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as MasterConnection['ws'];

    // b is connected but sent no config; a sent config but is gone.
    expect(masterReady()).toBe(false);

    await sendConfig(b);
    expect(masterReady()).toBe(true);
  });
});

describe('reconnect after all masters drop', () => {
  it('a held start runs when the master comes back and sends config', async () => {
    const m = connectMaster();
    await sendConfig(m);
    dropMaster(m);

    // A new role shows up while no master is there: created, not started.
    mockStartContainer.mockClear();
    await __testAutoProvision();
    expect(mockStartContainer).not.toHaveBeenCalled();

    m.connectionMode = 'websocket';
    m.ws = { readyState: 1, send: jest.fn(), close: jest.fn() } as unknown as MasterConnection['ws'];
    await sendConfig(m);

    expect(mockStartContainer).toHaveBeenCalledWith('ss-test-embedding');
  });
});

describe('HTTP gossip master', () => {
  it('counts as connected only with a good heartbeat', async () => {
    const m = ensureMaster(MASTER_URL);
    m.connectionMode = 'http';
    m.httpHeartbeatFailCount = 0;
    m.lastHeartbeatAt = Date.now();
    await sendConfig(m);
    expect(masterReady()).toBe(true);

    m.httpHeartbeatFailCount = 2;
    expect(masterReady()).toBe(false);
  });
});

describe('a sandbox-slot-only push does not open the gate', () => {
  it('a follow-mode master that sends only {openrouter} is not ready', async () => {
    await __testAutoProvision();
    const m = connectMaster();
    await __testExecuteCommand(m, { id: 'sb-1', action: 'config', payload: { openrouter: null } });
    await __testHeldGpuStartsSettled();

    expect(masterReady()).toBe(false);
    expect(mockStartContainer).not.toHaveBeenCalled();
  });
});

describe('gpuOnly remediation reload waits for a master', () => {
  beforeEach(() => {
    state.registry = {
      embedding: { ...testRegistry().embedding, gpuOnly: true },
    } as unknown as typeof state.registry;
    mockDocker.created.add('ss-test-embedding');
    mockDocker.running.add('ss-test-embedding');
    // Model is loaded but entirely on CPU.
    mockOllamaPs.mockResolvedValue([{ name: 'test-embed:1b', size: 1e9, sizeVram: 0, processor: '100% CPU' }]);
  });

  it('does not reload into VRAM with no master', async () => {
    await getAllContainerStates();
    await new Promise((r) => setTimeout(r, 1_700));
    expect(mockOllamaLoad).not.toHaveBeenCalled();
  });

  it('reloads into VRAM once a master is ready', async () => {
    const m = connectMaster();
    await sendConfig(m);
    mockOllamaLoad.mockClear();
    await getAllContainerStates();
    await new Promise((r) => setTimeout(r, 1_700));
    expect(mockOllamaLoad).toHaveBeenCalled();
  });
});
