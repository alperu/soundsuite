/**
 * @jest-environment node
 *
 * Task 39 stage 1 — fleet role availability.
 *
 * The property under test is the three-outcome rule: `unknown` must never
 * refuse. Two-outcome logic here would make every tool that declares a role
 * dependency fail closed on a single-box install with no sidecars at all.
 */

import {
  checkRoleAvailability,
  roleDependency,
} from '../shared-dependencies';

jest.mock('../../gpu/status-cache', () => ({
  findSidecarsWithRole: jest.fn(),
  getAllSidecarStatuses: jest.fn(),
}));

jest.mock('../../db/prisma', () => ({
  prisma: { config: { findMany: jest.fn() } },
}));

const statusCache = jest.requireMock('../../gpu/status-cache');
const { prisma } = jest.requireMock('../../db/prisma');

/** Minimal shape — only the fields `checkRoleAvailability` reads. */
function sidecar(role: string, opts: { loaded?: boolean; lastSeen?: number } = {}) {
  return {
    agentUrl: 'http://sidecar.invalid',
    lastSeen: opts.lastSeen ?? Date.now(),
    containers: { [role]: { status: 'running', name: `ss-${role}` } },
    vram:
      opts.loaded === undefined
        ? undefined
        : { perRole: { [role]: { role, loaded: opts.loaded } } },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OLLAMA_HOST;
  statusCache.findSidecarsWithRole.mockReturnValue([]);
  statusCache.getAllSidecarStatuses.mockReturnValue([]);
  prisma.config.findMany.mockResolvedValue([]);
});

describe('checkRoleAvailability', () => {
  it('reports available when a sidecar runs the role with the model resident', async () => {
    statusCache.findSidecarsWithRole.mockReturnValue([sidecar('reranker', { loaded: true })]);
    const r = await checkRoleAvailability('reranker');
    expect(r.state).toBe('available');
    expect(r.basis).toMatch(/resident/);
  });

  it('reports available for a running-but-cold role, since it loads on demand', async () => {
    statusCache.findSidecarsWithRole.mockReturnValue([sidecar('embedding', { loaded: false })]);
    const r = await checkRoleAvailability('embedding');
    expect(r.state).toBe('available');
    expect(r.basis).toMatch(/loads on demand/);
  });

  it('reports unknown when no sidecar has reported at all', async () => {
    const r = await checkRoleAvailability('completion');
    expect(r.state).toBe('unknown');
    // The distinction this whole task exists to preserve.
    expect(r.basis).toMatch(/not the same as/);
  });

  it('reports unknown when the fleet omits the role but a direct host is configured', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([sidecar('ocr')]);
    prisma.config.findMany.mockResolvedValue([
      { key: 'ai.ollamaCompletionHost', value: 'http://host.invalid:11435' },
    ]);
    const r = await checkRoleAvailability('completion');
    expect(r.state).toBe('unknown');
    expect(r.basis).toMatch(/direct Ollama host is configured/);
  });

  it('honours OLLAMA_HOST from the environment as a direct host', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([sidecar('ocr')]);
    process.env.OLLAMA_HOST = 'http://host.invalid:11434';
    const r = await checkRoleAvailability('embedding');
    expect(r.state).toBe('unknown');
    expect(prisma.config.findMany).not.toHaveBeenCalled();
  });

  it('reports unavailable only when sidecars report and none serve the role', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([sidecar('ocr'), sidecar('embedding')]);
    const r = await checkRoleAvailability('reranker');
    expect(r.state).toBe('unavailable');
    expect(r.basis).toMatch(/none with 'reranker' running/);
  });

it('reports unknown, not unavailable, when every cached sidecar entry is stale', async () => {
    // Regression: `getAllSidecarStatuses` has NO staleness filter (unlike
    // `findSidecarsWithRole`), so a fleet that went silent hours ago still
    // returns a non-empty array. Treating that as "role absent" asserts a host
    // is down on the strength of a stale snapshot.
    const old = Date.now() - 10 * 60_000;
    statusCache.getAllSidecarStatuses.mockReturnValue([
      sidecar('ocr', { lastSeen: old }),
      sidecar('embedding', { lastSeen: old }),
    ]);
    const r = await checkRoleAvailability('reranker');
    expect(r.state).toBe('unknown');
    expect(r.basis).toMatch(/stale/);
    expect(await roleDependency('reranker').check()).toBe(true);
  });

  it('still reports unavailable when a fresh sidecar simply lacks the role', async () => {
    // The staleness filter must not swallow the genuine negative.
    statusCache.getAllSidecarStatuses.mockReturnValue([
      sidecar('ocr', { lastSeen: Date.now() }),
      sidecar('embedding', { lastSeen: Date.now() - 10 * 60_000 }),
    ]);
    const r = await checkRoleAvailability('reranker');
    expect(r.state).toBe('unavailable');
    expect(r.basis).toMatch(/1 sidecar\(s\) reporting fresh status/);
  });

  it('distinguishes an empty cache from an entirely stale one in its basis', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([]);
    expect((await checkRoleAvailability('rlm')).basis).toMatch(/never|ever reported/);
  });

  it('never claims unavailable for a vLLM role via a direct host it cannot use', async () => {
    // reranker/rlm have no direct-host path; a configured Ollama host must not
    // rescue them into `unknown`.
    statusCache.getAllSidecarStatuses.mockReturnValue([sidecar('ocr')]);
    process.env.OLLAMA_HOST = 'http://host.invalid:11434';
    expect((await checkRoleAvailability('rlm')).state).toBe('unavailable');
  });
});

describe('roleDependency', () => {
  it('is advisory in stage 1, so isToolReady cannot block on it', () => {
    expect(roleDependency('reranker').required).toBe(false);
    expect(roleDependency('reranker', { required: true }).required).toBe(true);
  });

  it('scopes its key by role so two role deps never collide', () => {
    expect(roleDependency('rlm').key).toBe('fleetRole:rlm');
    expect(roleDependency('embedding').key).not.toBe(roleDependency('rlm').key);
  });

  it('is satisfied when the role is unknown — unknown must not refuse', async () => {
    expect(await roleDependency('completion').check()).toBe(true);
  });

  it('is unsatisfied only when the role is positively absent', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([sidecar('ocr')]);
    expect(await roleDependency('reranker').check()).toBe(false);
  });

  it('survives an unreadable fleet cache without refusing', async () => {
    statusCache.findSidecarsWithRole.mockImplementation(() => {
      throw new Error('cache exploded');
    });
    // `refreshDependencies` turns a thrown check into `satisfied = false`, so a
    // fault that escaped here would read as "role absent" once stage 2 makes
    // these required. It must degrade to `unknown` instead.
    const r = await checkRoleAvailability('embedding');
    expect(r.state).toBe('unknown');
    expect(r.basis).toMatch(/unreadable/);
    expect(await roleDependency('embedding').check()).toBe(true);
  });
});
