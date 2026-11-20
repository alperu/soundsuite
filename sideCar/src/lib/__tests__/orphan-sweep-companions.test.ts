/**
 * The orphan sweep must never stop the sidecar's own NetBird and HTTPS (Caddy)
 * companions.
 *
 * The sweep stops every running `ss-*` container that is not in the role
 * registry. The companions are named after the sidecar's own container
 * (`<self>-netbird`, `<self>-caddy`) and are never in a master's registry, so
 * each config push from a master stopped them and the host fell off the VPN.
 * Observed on several hosts after the 2.7.10 update.
 */

jest.mock('../docker', () => {
  const actual = jest.requireActual('../docker');
  return {
    ...actual,
    listContainersByPrefix: jest.fn(),
    stopContainer: jest.fn(async () => undefined),
  };
});

import { state } from '../state';
import { stopOrphanContainers } from '../containers';
import * as docker from '../docker';

const list = docker.listContainersByPrefix as unknown as jest.Mock;
const stop = docker.stopContainer as unknown as jest.Mock;

const savedRegistry = { ...state.registry };
const savedOs = state.hostOs;

beforeEach(() => {
  list.mockReset();
  stop.mockClear();
  // A host that runs only the ocr role.
  for (const k of Object.keys(state.registry)) delete state.registry[k];
  state.registry['ocr'] = { ...savedRegistry['ocr'] };
  state.hostOs = 'linux';
});

afterAll(() => {
  for (const k of Object.keys(state.registry)) delete state.registry[k];
  Object.assign(state.registry, savedRegistry);
  state.hostOs = savedOs;
});

function running(name: string) {
  return { name, image: 'some/image:1', state: 'running' };
}

describe('orphan sweep and the NetBird / Caddy companions', () => {
  it('keeps ss-sidecar-netbird and ss-sidecar-caddy running', async () => {
    list.mockResolvedValue([
      running('ss-sidecar'),
      running('ss-sidecar-netbird'),
      running('ss-sidecar-caddy'),
      running(state.registry['ocr'].containerName),
    ]);
    const stopped = await stopOrphanContainers();
    expect(stopped).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  it('still stops a role container that is no longer assigned', async () => {
    list.mockResolvedValue([
      running('ss-sidecar-netbird'),
      running('ss-sidecar-caddy'),
      running('ss-old-role'),
    ]);
    const stopped = await stopOrphanContainers();
    expect(stopped.map((s) => s.name)).toEqual(['ss-old-role']);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('ss-old-role');
  });
});
