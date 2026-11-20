/** @jest-environment node */
/**
 * ss-cuda (gpu.ts) is created with the same compose labels as the role
 * containers. Docker calls are mocked; nothing is sent to a daemon.
 */
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const creates: Array<{ path: string; body: Record<string, unknown> }> = [];
jest.mock('@/lib/docker', () => ({
  getContainerState: jest.fn(async () => ({ exists: false, status: 'missing' })),
  dockerRequest: jest.fn(async (method: string) => ({ status: method === 'GET' ? 200 : 204, body: '' })),
  dockerRequestWithBody: jest.fn(async (_m: string, path: string, body: Record<string, unknown>) => {
    creates.push({ path, body });
    return { status: 201, body: '{"Id":"0123abcd"}' };
  }),
  pullImage: jest.fn(),
  execInContainer: jest.fn(async () => ({ exitCode: 0, output: '0, Made Up GPU, 24576, 1024, 23552, 40\n' })),
}));

import { state } from '@/lib/state';
import { discoverGpus } from '@/lib/gpu';

const saved = process.env.SS_COMPOSE_PROJECT;
afterAll(() => { if (saved === undefined) delete process.env.SS_COMPOSE_PROJECT; else process.env.SS_COMPOSE_PROJECT = saved; });

function freshLinuxHost() {
  state.hostOs = 'linux';
  state.hostOllamaEnabled = false;
  state.cudaUnavailable = false;
  state.cudaRetried = false;
  state.gpuCache = null;
  state.gpuCacheTime = 0;
  (state as { hostStats: unknown }).hostStats = null;
  creates.length = 0;
}

describe('ss-cuda create', () => {
  it('sends the labels with the default project', async () => {
    delete process.env.SS_COMPOSE_PROJECT;
    freshLinuxHost();
    await discoverGpus();
    expect(creates).toHaveLength(1);
    expect(creates[0].path).toContain('name=ss-cuda');
    expect(creates[0].body.Labels).toEqual({
      'com.docker.compose.project': 'sidecar',
      'com.docker.compose.service': 'cuda',
      'com.docker.compose.oneoff': 'False',
      'com.docker.compose.container-number': '1',
    });
  });

  it('sends the project from SS_COMPOSE_PROJECT', async () => {
    process.env.SS_COMPOSE_PROJECT = 'made-up-stack';
    freshLinuxHost();
    await discoverGpus();
    expect((creates[0].body.Labels as Record<string, string>)['com.docker.compose.project']).toBe('made-up-stack');
  });
});
