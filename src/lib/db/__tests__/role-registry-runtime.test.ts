/**
 * @jest-environment node
 *
 * Runtime resolution for HostRoleAssignment rows.
 *
 * Two defects motivate this file, and both were silent — neither threw, neither
 * logged, both just pushed a runtime the operator never chose:
 *
 *   1. RUNTIME_VALUES omitted 'docker-model-runner' although the type and the
 *      doc comment both listed it, so isRuntimeChoice() rejected every stored
 *      DMR row and getRuntimesForHost() substituted defaultRuntimeFor() — for
 *      ss-rlm on a Mac, 'host', which the sidecar refuses outright.
 *   2. ss-rlm-sandbox has exactly one valid runtime ('docker-cpu'), but rows
 *      predating that value carry whatever the OS default was. Honoring the
 *      stored column keeps those rows permanently unresolvable.
 */

const findMany = jest.fn();
const findUnique = jest.fn();
const upsert = jest.fn();

jest.mock('../prisma', () => ({
  prisma: {
    hostRoleAssignment: {
      findMany: (...a: unknown[]) => findMany(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
      upsert: (...a: unknown[]) => upsert(...a),
    },
  },
}));
// Server-only module; role-registry re-exports from it but these tests never
// reach those paths.
jest.mock('@/lib/gpu/mode-catalog-server', () => ({
  getModeCatalog: jest.fn(),
  defaultModelForAsync: jest.fn(),
}));

import {
  isRuntimeChoice,
  defaultRuntimeFor,
  getRuntimesForHost,
  getEffectiveMinOnline,
  getEffectiveIdleTimeoutsMs,
  setAssignment,
  type RuntimeChoice,
} from '../role-registry';

const row = (mode: string, runtime: string | null) => ({
  id: mode, sidecarUrl: 'http://192.0.2.10:8098', mode,
  enabled: true, minOnline: 1, idleTimeoutMin: 5, modelOverride: null, runtime,
  createdAt: new Date(), updatedAt: new Date(),
});

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset().mockResolvedValue(null);
  upsert.mockReset().mockResolvedValue({});
});

describe('isRuntimeChoice', () => {
  it('accepts every member of the union', () => {
    const all: RuntimeChoice[] = [
      'host', 'docker-ollama', 'docker-vllm', 'docker-model-runner', 'docker-cpu',
    ];
    for (const v of all) expect(isRuntimeChoice(v)).toBe(true);
  });

  it('accepts docker-model-runner — the value that was in the type but not the array', () => {
    expect(isRuntimeChoice('docker-model-runner')).toBe(true);
  });

  it('rejects non-members and non-strings', () => {
    expect(isRuntimeChoice('docker')).toBe(false); // the RoleRuntime value, not a choice
    expect(isRuntimeChoice('')).toBe(false);
    expect(isRuntimeChoice(null)).toBe(false);
    expect(isRuntimeChoice(undefined)).toBe(false);
    expect(isRuntimeChoice(3)).toBe(false);
  });
});

describe('defaultRuntimeFor', () => {
  it('keeps the existing per-OS behaviour for unpinned modes', () => {
    expect(defaultRuntimeFor('ss-embedding', 'linux')).toBe('docker-ollama');
    expect(defaultRuntimeFor('ss-embedding', 'mac-docker-ollama')).toBe('host');
    expect(defaultRuntimeFor('ss-reranker', 'linux')).toBe('docker-vllm');
    expect(defaultRuntimeFor('ss-reranker', 'mac-docker-ollama')).toBe('host');
  });

  it('pins ss-rlm-sandbox to docker-cpu on every OS', () => {
    for (const os of ['linux', 'mac-docker-ollama', 'windows-docker-wsl2', 'unknown'] as const) {
      expect(defaultRuntimeFor('ss-rlm-sandbox', os)).toBe('docker-cpu');
    }
  });
});

describe('getRuntimesForHost', () => {
  it('round-trips a stored docker-model-runner row instead of rewriting it', async () => {
    findMany.mockResolvedValue([row('ss-rlm', 'docker-model-runner')]);
    const out = await getRuntimesForHost('http://192.0.2.10:8098', 'mac-docker-ollama');
    // Before the fix this was 'host' — a runtime mode-templates refuses for
    // ss-rlm, so the role was dropped on a host that can actually serve it.
    expect(out['ss-rlm']).toBe('docker-model-runner');
  });

  it('overrides a stale ss-rlm-sandbox row rather than pushing an unresolvable runtime', async () => {
    findMany.mockResolvedValue([
      row('ss-rlm-sandbox', 'host'),            // saved on a Mac pre-fix
      row('ss-rlm-sandbox', 'docker-ollama'),   // saved on Linux pre-fix
    ].slice(0, 1));
    const mac = await getRuntimesForHost('http://192.0.2.10:8098', 'mac-docker-ollama');
    expect(mac['ss-rlm-sandbox']).toBe('docker-cpu');

    findMany.mockResolvedValue([row('ss-rlm-sandbox', 'docker-ollama')]);
    const linux = await getRuntimesForHost('http://192.0.2.10:8098', 'linux');
    expect(linux['ss-rlm-sandbox']).toBe('docker-cpu');
  });

  it('still falls back to the OS default when the column is null', async () => {
    findMany.mockResolvedValue([row('ss-embedding', null)]);
    const out = await getRuntimesForHost('http://192.0.2.10:8098', 'mac-docker-ollama');
    expect(out['ss-embedding']).toBe('host');
  });

  it('skips disabled rows', async () => {
    findMany.mockResolvedValue([{ ...row('ss-embedding', 'host'), enabled: false }]);
    const out = await getRuntimesForHost('http://192.0.2.10:8098', 'linux');
    expect(out).toEqual({});
  });
});

/**
 * These two functions build the minOnline / idleTimeouts maps that ride on the
 * /config push, and ws-client Object.assign's them OVER the sidecar's own
 * state.ts defaults. So a stale stored column does not merely fail to help —
 * it actively overwrites the correct sidecar default on the first push. That
 * makes this the load-bearing place for the sandbox's residency policy.
 */
describe('pinned residency policy survives a stale row', () => {
  const stale = { ...row('ss-rlm-sandbox', 'host'), minOnline: 0, idleTimeoutMin: 5 };

  it('pushes minOnline 1 even when the stored column says 0', async () => {
    findMany.mockResolvedValue([stale]);
    const out = await getEffectiveMinOnline('http://192.0.2.10:8098');
    // 0 would be a HARD never-auto-start gate on the sidecar, so the master
    // could never find a running sandbox to route to.
    expect(out['rlm-sandbox']).toBe(1);
  });

  it('pushes a disabled idle timer even when the stored column says 5 minutes', async () => {
    findMany.mockResolvedValue([stale]);
    const out = await getEffectiveIdleTimeoutsMs('http://192.0.2.10:8098');
    expect(out['rlm-sandbox']).toBe(0);
  });

  it('leaves the stored policy of every other role untouched', async () => {
    findMany.mockResolvedValue([
      { ...row('ss-completion', 'docker-ollama'), minOnline: 0, idleTimeoutMin: 10 },
    ]);
    expect((await getEffectiveMinOnline('http://192.0.2.10:8098'))['completion']).toBe(0);
    expect((await getEffectiveIdleTimeoutsMs('http://192.0.2.10:8098'))['completion']).toBe(600_000);
  });
});

describe('setAssignment persists a pinned runtime', () => {
  const args = () => upsert.mock.calls[0][0];

  it('writes docker-cpu on create even when the caller asks for something else', async () => {
    await setAssignment({
      sidecarUrl: 'http://192.0.2.10:8098',
      mode: 'ss-rlm-sandbox',
      enabled: true,
      runtime: 'host',
    });
    expect(args().create.runtime).toBe('docker-cpu');
  });

  it('repairs a stale stored value on update, so the DB converges', async () => {
    findUnique.mockResolvedValue({ minOnline: 1, enabled: true });
    await setAssignment({
      sidecarUrl: 'http://192.0.2.10:8098',
      mode: 'ss-rlm-sandbox',
      enabled: true,
      runtime: 'docker-model-runner',
    });
    expect(args().update.runtime).toBe('docker-cpu');
  });

  it('gives the sandbox a disabled idle timer, not the 60-min vLLM default', async () => {
    await setAssignment({
      sidecarUrl: 'http://192.0.2.10:8098', mode: 'ss-rlm-sandbox', enabled: true,
    });
    expect(args().create.idleTimeoutMin).toBe(0);
    // minOnline=0 is a HARD never-auto-start gate on the sidecar, and the
    // master only routes to a *running* sandbox — so an enabled row must not
    // land on 0.
    expect(args().create.minOnline).toBe(1);
  });

  it('leaves unpinned modes alone', async () => {
    await setAssignment({
      sidecarUrl: 'http://192.0.2.10:8098', mode: 'ss-rlm', enabled: true, runtime: 'docker-vllm',
    });
    expect(args().create.runtime).toBe('docker-vllm');
    expect(args().create.idleTimeoutMin).toBe(60);
  });
});
