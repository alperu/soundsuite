/** @jest-environment node */
/**
 * "Update Ollama" guards and recreate flow. Docker, containers and leases are
 * mocked at the module boundary — no real daemon is touched.
 */

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const docker = {
  getContainerState: jest.fn(),
  getImageId: jest.fn(),
  pullImage: jest.fn(),
  removeContainer: jest.fn(),
  startContainer: jest.fn(),
  isDockerAvailable: jest.fn(),
};
jest.mock('@/lib/docker', () => docker);

const ensureContainerForRole = jest.fn();
jest.mock('@/lib/containers', () => ({ ensureContainerForRole: (...a: unknown[]) => ensureContainerForRole(...a) }));

const leaseSummary = jest.fn();
jest.mock('@/lib/leases', () => ({ leaseSummary: () => leaseSummary() }));

import { state } from '@/lib/state';
import { handleUpdateImage, __resetImageUpdateForTest } from '@/lib/ollama-image-update';
import { tasks, __resetTasksForTest } from '@/lib/task-tracker';

const ROLE = 'test-ollama';
const NAME = 'ss-test-ollama';

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetImageUpdateForTest();
  __resetTasksForTest();
  (state.registry as Record<string, unknown>)[ROLE] = {
    type: 'ollama', runtime: 'docker', image: 'ollama/ollama', containerName: NAME, port: 11499, model: 'm', vram: 0,
  };
  state.perRole[ROLE] = { activeRequests: 0, idleTimer: null, lastAcquire: null, lastRelease: null };
  docker.isDockerAvailable.mockReturnValue(true);
  docker.pullImage.mockResolvedValue(true);
  docker.getImageId.mockResolvedValue('sha256:new');
  docker.getContainerState.mockResolvedValue({ exists: true, name: NAME, status: 'running', imageId: 'sha256:old' });
  leaseSummary.mockReturnValue({ total: 0, ttlMs: 0, byRole: {} });
});

afterAll(() => {
  delete (state.registry as Record<string, unknown>)[ROLE];
  delete state.perRole[ROLE];
});

describe('handleUpdateImage guards', () => {
  it('rejects host-ollama roles', async () => {
    (state.registry[ROLE] as { runtime: string }).runtime = 'host';
    expect((await handleUpdateImage(ROLE)).error).toMatch(/not a docker-ollama role/);
  });

  it('rejects vLLM roles', async () => {
    (state.registry[ROLE] as { type: string }).type = 'vllm';
    expect((await handleUpdateImage(ROLE)).error).toMatch(/not a docker-ollama role/);
  });

  it('rejects a role with active requests', async () => {
    state.perRole[ROLE].activeRequests = 1;
    expect((await handleUpdateImage(ROLE)).error).toMatch(/serving requests/);
    expect(docker.pullImage).not.toHaveBeenCalled();
  });

  it('rejects a role with open leases', async () => {
    leaseSummary.mockReturnValue({ total: 1, ttlMs: 0, byRole: { [ROLE]: { open: 1, oldestAgeMs: 0 } } });
    expect((await handleUpdateImage(ROLE)).error).toMatch(/serving requests/);
  });

  it('rejects a second update while one runs', async () => {
    docker.pullImage.mockReturnValue(new Promise(() => {}));
    expect((await handleUpdateImage(ROLE)).ok).toBe(true);
    expect((await handleUpdateImage(ROLE)).error).toMatch(/already in progress/);
  });
});

describe('handleUpdateImage flow', () => {
  it('force-pulls, recreates and restarts a running container on a new image', async () => {
    expect((await handleUpdateImage(ROLE)).ok).toBe(true);
    await settle();
    expect(docker.pullImage).toHaveBeenCalledWith('ollama/ollama', expect.objectContaining({ force: true }));
    expect(docker.removeContainer).toHaveBeenCalledWith(NAME);
    expect(ensureContainerForRole).toHaveBeenCalledWith(ROLE);
    expect(docker.startContainer).toHaveBeenCalledWith(NAME);
    expect(tasks.getAll()[0].status).toBe('completed');
  });

  it('does not start a container that was stopped', async () => {
    docker.getContainerState.mockResolvedValue({ exists: true, name: NAME, status: 'exited', imageId: 'sha256:old' });
    await handleUpdateImage(ROLE);
    await settle();
    expect(docker.removeContainer).toHaveBeenCalled();
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('skips the recreate when already on the newest image', async () => {
    docker.getImageId.mockResolvedValue('sha256:old');
    await handleUpdateImage(ROLE);
    await settle();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(tasks.getAll()[0].status).toBe('completed');
  });

  it('skips the recreate when the role became busy during the pull', async () => {
    docker.pullImage.mockImplementation(async () => { state.perRole[ROLE].activeRequests = 1; return true; });
    await handleUpdateImage(ROLE);
    await settle();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(tasks.getAll()[0].status).toBe('failed');
  });
});
