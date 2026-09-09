/**
 * @jest-environment node
 *
 * Task 30 Part 3 — `fleet_status` and `role_assignments_list`.
 *
 * The properties under test are not "does it list hosts". They are the four
 * failure modes the task was raised to prevent:
 *
 *  1. **Green while the path is sick.** A role the sidecar reports `running`
 *     because nothing checked must never be indistinguishable from one that
 *     answered a probe. `reportedSynthetic` and `probe` are separate fields and
 *     the tests assert both, never one standing in for the other.
 *  2. **UNREPORTED collapsed into down.** A host that says nothing about a role
 *     must appear in `notReportedBy` and in NO reachability count.
 *  3. **An unbounded probe.** A host that never answers must not extend wall
 *     clock past the budget, and must be reported as `timeout` — a statement
 *     about the probe, not a verdict on the host.
 *  4. **A guessed port.** An unreported port must yield `port: null` and
 *     `probe: 'not_attempted'`, never a value from a fourth role->port map.
 *
 * No global mocks exist in this repo (see CLAUDE.md), so `fetch` and both
 * dynamically-imported modules are mocked here explicitly.
 */

import { FleetStatusTool } from '../fleet-status';
import { RoleAssignmentsListTool } from '../role-assignments-list';
import type { ToolConfigEntry, ToolExecutionContext } from '../../tool-types';

jest.mock('../../../gpu/status-cache', () => ({
  getAllSidecarStatuses: jest.fn(),
}));

jest.mock('../../../db/config', () => ({
  getConfig: jest.fn(),
}));

const statusCache = jest.requireMock('../../../gpu/status-cache');
const dbConfig = jest.requireMock('../../../db/config');

const CONFIG: ToolConfigEntry = { enabled: true, settings: {}, rateLimitPerMinute: 0 };

function ctx(): ToolExecutionContext {
  return {
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  } as unknown as ToolExecutionContext;
}

/**
 * A cached sidecar heartbeat. Only the fields these tools read are present —
 * `CachedSidecarStatus` carries ~20 more that neither tool touches.
 */
function host(opts: {
  url?: string;
  hostname?: string;
  ageMs?: number;
  containers?: Record<string, Record<string, unknown>>;
  perRole?: Record<string, Record<string, unknown>>;
}) {
  return {
    agentUrl: opts.url ?? 'http://10.0.0.1:8098',
    hostname: opts.hostname ?? 'gpu-a',
    mode: 'searching',
    uptime: 1000,
    wsConnected: true,
    activeRequests: 0,
    idleTimeouts: {},
    roles: {},
    peakDemand: {},
    gpus: [],
    containers: opts.containers ?? {},
    ...(opts.perRole ? { vram: { totalMb: 48000, freeMb: 20000, usedMb: 28000, unattributedMb: 0, perRole: opts.perRole, ts: Date.now() } } : {}),
    lastSeen: Date.now() - (opts.ageMs ?? 0),
  };
}

/** A vLLM role as the sidecar registry declares it (state.ts: type 'vllm'). */
const vllmReranker = { status: 'running', name: 'ss-reranker', image: 'vllm/vllm-openai:v0.21.0', port: 8099, type: 'vllm', model: 'Qwen/Qwen3-Reranker-8B' };
const vllmRlm = { status: 'running', name: 'ss-rlm', image: 'vllm/vllm-openai:v0.21.0', port: 8100, type: 'vllm', model: 'mit-oasys/rlm-qwen3-8b-v0.1' };
/** Host-Ollama: `fleet-router.ts:601` stamps image 'host-ollama' and port 11434. */
const hostOllamaEmbedding = { status: 'running', name: 'ss-embedding', image: 'host-ollama', port: 11434, type: 'ollama', model: 'qwen3-embedding:4b' };
const hostOllamaCompletion = { status: 'running', name: 'ss-completion', image: 'host-ollama', port: 11434, type: 'ollama', model: 'qwen3.5:9b' };

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  statusCache.getAllSidecarStatuses.mockReturnValue([]);
  dbConfig.getConfig.mockResolvedValue({ gpuMode: 'searching' });
  fetchMock = jest.fn();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

function okModels(ids: string[]) {
  return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) };
}

/** Never resolves on its own — only the caller's AbortSignal ends it. */
function neverAnswers() {
  return (_url: string, init: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      });
    });
}

const run = (params: Record<string, unknown> = {}) =>
  new FleetStatusTool().executeImpl(params, ctx(), CONFIG);

const runRoles = (params: Record<string, unknown> = {}) =>
  new RoleAssignmentsListTool().executeImpl(params, ctx(), CONFIG);

// ---------------------------------------------------------------------------

describe('fleet_status — metadata', () => {
  it('is local-only and in the search category, with no dependencies', () => {
    const tool = new FleetStatusTool();
    const meta = tool.getMetadata();
    // `search` keeps it answerable on a degraded fleet (tool-registry.ts:154-157);
    // an ABSENT `profiles` would mean BOTH profiles (tool-types.ts:56-58), which
    // is exactly the infrastructure leak task 30's Risks section names.
    expect(meta.category).toBe('search');
    expect(meta.profiles).toEqual(['local']);
    expect(tool.getDependencies()).toEqual([]);
  });

  it('role_assignments_list is local-only and in the search category too', () => {
    const meta = new RoleAssignmentsListTool().getMetadata();
    expect(meta.category).toBe('search');
    expect(meta.profiles).toEqual(['local']);
    expect(new RoleAssignmentsListTool().getDependencies()).toEqual([]);
  });
});

describe('fleet_status / role_assignments_list — strict params', () => {
  // Both tools opt into `rejectsUnknownParams()`. That guard lives in
  // `BaseMCPTool.execute`, which `executeImpl` bypasses — so it is exercised
  // here through the real entry point or not at all.
  it('rejects an undeclared parameter on fleet_status', async () => {
    const res = await new FleetStatusTool().execute({ bogus: 1 } as never, ctx(), CONFIG);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
    expect(res.error).toMatch(/bogus/);
  });

  it('rejects an undeclared parameter on role_assignments_list', async () => {
    const res = await new RoleAssignmentsListTool().execute({ bogus: 1 } as never, ctx(), CONFIG);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
  });

  it('rejects a declared parameter of the wrong type', async () => {
    const res = await new FleetStatusTool().execute({ probe: 'yes' } as never, ctx(), CONFIG);
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('INVALID_PARAMS');
  });

  it('accepts the declared parameters through the real entry point', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([]);
    const res = await new FleetStatusTool().execute(
      { role: 'reranker', probe: false, probeTimeoutMs: 500 } as never,
      ctx(),
      CONFIG,
    );
    expect(res.success).toBe(true);
  });
});

describe('fleet_status — probing vLLM roles', () => {
  it('probes every vLLM role live and reports the model ids it served', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker, rlm: vllmRlm } }),
    ]);
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('8099') ? okModels(['Qwen/Qwen3-Reranker-8B']) : okModels(['mit-oasys/rlm-qwen3-8b-v0.1']),
    );

    const res = await run();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual([
      'http://10.0.0.1:8099/v1/models',
      'http://10.0.0.1:8100/v1/models',
    ]);
    const reranker = res.hosts[0].roles.find((r) => r.role === 'reranker')!;
    expect(reranker.probe).toBe('ok');
    expect(reranker.probeModels).toEqual(['Qwen/Qwen3-Reranker-8B']);
    expect(res.probing.attempted).toBe(2);
  });

  it('does NOT probe Ollama roles — the sidecar observes those live itself', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding, reranker: vllmReranker } }),
    ]);
    fetchMock.mockResolvedValue(okModels(['Qwen/Qwen3-Reranker-8B']));

    const res = await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const embedding = res.hosts[0].roles.find((r) => r.role === 'embedding')!;
    expect(embedding.probe).toBe('not_attempted');
    expect(embedding.probeDetail).toMatch(/reported runtime is "ollama"/);
  });

  it('treats a role as vLLM from vram.perRole.runtime even when `type` is absent', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({
        containers: { reranker: { status: 'running', name: 'ss-reranker', port: 8099 } },
        perRole: { reranker: { role: 'reranker', runtime: 'vllm', loaded: true, actualMb: 7000, budgetMb: 7000, priority: 'normal', gpuOnly: false, modes: [], containerStatus: 'running' } },
      }),
    ]);
    fetchMock.mockResolvedValue(okModels([]));

    const res = await run();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.hosts[0].roles[0].probe).toBe('ok');
    expect(res.hosts[0].roles[0].runtime).toBe('vllm');
  });

  it('makes no network call at all when no vLLM role is reported', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding, completion: hostOllamaCompletion } }),
    ]);

    const res = await run();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.probing.attempted).toBe(0);
  });

  it('does not claim an unreported runtime was observed', async () => {
    // `type`, `config.type` and the whole `vram` block are all optional
    // upstream (status-cache.ts:26,32,40), so a sidecar can report a role and
    // say nothing about its runtime. Collapsing that silence into "not vLLM"
    // would turn UNREPORTED into a positive claim — inside the tool built to
    // stop exactly that.
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: { status: 'running', name: 'ss-reranker', port: 8099 } } }),
    ]);

    const res = await run();

    const reranker = res.hosts[0].roles[0];
    expect(reranker.runtimeReported).toBe(false);
    expect(reranker.runtime).toBeUndefined();
    expect(reranker.probe).toBe('not_attempted');
    expect(reranker.probeDetail).toMatch(/reported no runtime type/);
    expect(reranker.probeDetail).toMatch(/says nothing about the role/);
    // The Ollama message asserts the status WAS observed — it must not appear here.
    expect(reranker.probeDetail).not.toMatch(/is an observation/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the reported runtime when it is a non-vLLM one', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding } }),
    ]);

    const res = await run();

    const embedding = res.hosts[0].roles[0];
    expect(embedding.runtimeReported).toBe(true);
    expect(embedding.runtime).toBe('ollama');
    expect(embedding.probeDetail).toMatch(/reported runtime is "ollama"/);
  });

  it('reports a host that never answers as `timeout` and stays inside the budget', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker } }),
    ]);
    fetchMock.mockImplementation(neverAnswers());

    const t0 = Date.now();
    const res = await run({ probeTimeoutMs: 300 });
    const elapsed = Date.now() - t0;

    const reranker = res.hosts[0].roles[0];
    expect(reranker.probe).toBe('timeout');
    expect(reranker.probeDetail).toMatch(/no answer within 300 ms/);
    // The bound is the point: the reranker's own 90 s batch timeout is the
    // cautionary example a health check must not inherit.
    expect(elapsed).toBeLessThan(3000);
    expect(res.probing.wallClockMs).toBeLessThan(3000);
  });

  it('bounds wall clock by the longest probe, not by host count', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ url: 'http://10.0.0.1:8098', containers: { reranker: vllmReranker } }),
      host({ url: 'http://10.0.0.2:8098', containers: { reranker: vllmReranker } }),
      host({ url: 'http://10.0.0.3:8098', containers: { reranker: vllmReranker, rlm: vllmRlm } }),
    ]);
    fetchMock.mockImplementation(neverAnswers());

    const t0 = Date.now();
    const res = await run({ probeTimeoutMs: 300 });
    const elapsed = Date.now() - t0;

    expect(res.probing.attempted).toBe(4);
    // Sequential probing floors at ~1200 ms, so 1500 still discriminates while
    // leaving headroom for a loaded machine.
    expect(elapsed).toBeLessThan(1500);
  });

  it('reports a refused connection as `unreachable`, distinct from `timeout`', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker } }),
    ]);
    fetchMock.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }));

    const res = await run();

    expect(res.hosts[0].roles[0].probe).toBe('unreachable');
    expect(res.hosts[0].roles[0].probeDetail).toMatch(/ECONNREFUSED/);
  });

  it('reports a non-200 as `http_error`, not as unreachable', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker } }),
    ]);
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const res = await run();

    expect(res.hosts[0].roles[0].probe).toBe('http_error');
    expect(res.hosts[0].roles[0].probeDetail).toBe('HTTP 503');
  });

  it('skips probing entirely when the caller asks for a pure cache read', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker } }),
    ]);

    const res = await run({ probe: false });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.hosts[0].roles[0].probe).toBe('not_attempted');
    expect(res.probing.attempted).toBe(0);
    expect(res.notes.join(' ')).toMatch(/Probing was disabled/);
  });
});

describe('fleet_status — never guesses a port (amendment (b))', () => {
  it('reports port null and does not probe when the sidecar reported no port', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: { status: 'running', name: 'ss-reranker', type: 'vllm' } } }),
    ]);

    const res = await run();

    const reranker = res.hosts[0].roles[0];
    expect(reranker.port).toBeNull();
    expect(reranker.portSource).toBe('unreported');
    expect(reranker.probe).toBe('not_attempted');
    expect(reranker.probeDetail).toMatch(/does not guess/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers the sidecar-reported config port over the container port', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: { ...vllmReranker, port: 8099, config: { port: 9099, type: 'vllm' } } } }),
    ]);
    fetchMock.mockResolvedValue(okModels([]));

    const res = await run();

    expect(res.hosts[0].roles[0].port).toBe(9099);
    expect(res.hosts[0].roles[0].portSource).toBe('sidecar-config');
    expect(fetchMock.mock.calls[0][0]).toBe('http://10.0.0.1:9099/v1/models');
  });

  it('flags two Ollama roles sharing 11434 as shared, never as drift', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding, completion: hostOllamaCompletion } }),
    ]);

    const res = await run();

    for (const role of ['embedding', 'completion']) {
      const summary = res.roles.find((r) => r.role === role)!;
      expect(summary.ports).toHaveLength(1);
      expect(summary.ports[0]).toMatchObject({ port: 11434, sharedOllamaPort: true });
    }
  });
});

describe('fleet_status — synthetic status is labelled, not laundered (amendment (c))', () => {
  it('marks a host-Ollama role as reportedSynthetic and says why', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding } }),
    ]);

    const res = await run();

    const embedding = res.hosts[0].roles[0];
    // The verbatim string is preserved — it is not rewritten to something softer.
    expect(embedding.reported).toBe('running');
    expect(embedding.reportedSynthetic).toBe(true);
    expect(embedding.syntheticBasis).toMatch(/assumes this status/);
    expect(res.roles.find((r) => r.role === 'embedding')!.reportedRunningSynthetic).toBe(1);
    expect(res.notes.join(' ')).toMatch(/Synthetic 'running'/);
  });

  it('marks a Docker Model Runner role as reportedSynthetic', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: { status: 'running', name: 'ss-reranker', image: 'dmr', port: 12434, type: 'vllm' } } }),
    ]);
    fetchMock.mockResolvedValue(okModels([]));

    const res = await run();

    expect(res.hosts[0].roles[0].reportedSynthetic).toBe(true);
    expect(res.hosts[0].roles[0].syntheticBasis).toMatch(/Docker Model Runner/);
  });

  it('does NOT mark a real Docker container as synthetic', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker } }),
    ]);
    fetchMock.mockResolvedValue(okModels([]));

    const res = await run();

    expect(res.hosts[0].roles[0].reportedSynthetic).toBe(false);
    expect(res.hosts[0].roles[0].syntheticBasis).toBeUndefined();
  });

  it('passes through an unmapped status string verbatim', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: { ...vllmReranker, status: 'not_found' } } }),
    ]);
    fetchMock.mockResolvedValue(okModels([]));

    const res = await run();

    // No invented vocabulary: 'not_found' is not remapped to 'exited' or
    // 'not_pulled' — six of amendment (c)'s seven states do not exist upstream.
    expect(res.hosts[0].roles[0].reported).toBe('not_found');
    expect(res.roles.find((r) => r.role === 'reranker')!.reportedRunning).toBe(0);
  });
});

describe('fleet_status — UNREPORTED is not down (amendment (c))', () => {
  it('places a host that never mentions a role in notReportedBy and in no count', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ url: 'http://10.0.0.1:8098', containers: { embedding: hostOllamaEmbedding } }),
      host({ url: 'http://10.0.0.2:8098', containers: { reranker: vllmReranker } }),
    ]);
    fetchMock.mockResolvedValue(okModels([]));

    const res = await run();

    const reranker = res.roles.find((r) => r.role === 'reranker')!;
    expect(reranker.reportedBy).toEqual(['http://10.0.0.2:8098']);
    expect(reranker.notReportedBy).toEqual(['http://10.0.0.1:8098']);
    // The silent host contributes to no probe bucket at all — not to a failing one.
    expect(reranker.probes).toEqual({ ok: 1 });
  });

  it('names a filtered role that nothing reports rather than omitting it', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding } }),
    ]);

    const res = await run({ role: 'rlm' });

    const rlm = res.roles.find((r) => r.role === 'rlm')!;
    expect(rlm).toBeDefined();
    expect(rlm.reportedBy).toEqual([]);
    expect(rlm.notReportedBy).toEqual(['http://10.0.0.1:8098']);
  });

  it('reports an unreadable cache as an absence of information, not a down fleet', async () => {
    statusCache.getAllSidecarStatuses.mockImplementation(() => {
      throw new Error('cache exploded');
    });

    const res = await run();

    expect(res.hosts).toEqual([]);
    expect(res.roles).toEqual([]);
    expect(res.notes.join(' ')).toMatch(/says NOTHING about any host or role/);
    expect(res.notes.join(' ')).toMatch(/not evidence that the fleet is down/);
  });

  it('reports an empty fleet as an absence of information', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([]);

    const res = await run();

    expect(res.notes.join(' ')).toMatch(/absence of information about every role/);
  });
});

describe('fleet_status — staleness is computed here, not inherited', () => {
  it('labels a stale host and still probes it', async () => {
    // `getAllSidecarStatuses` (status-cache.ts:230-232) applies NO staleness
    // filter, unlike findSidecarsWithRole (:267). A stale entry therefore
    // arrives looking exactly like a fresh one unless the caller checks.
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ ageMs: 120_000, containers: { reranker: vllmReranker } }),
    ]);
    fetchMock.mockResolvedValue(okModels(['Qwen/Qwen3-Reranker-8B']));

    const res = await run();

    expect(res.hosts[0].stale).toBe(true);
    expect(res.hosts[0].staleMs).toBeGreaterThanOrEqual(120_000);
    // Probed anyway: a stale cache is exactly where cached state is most
    // likely to disagree with the wire.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.hosts[0].roles[0].probe).toBe('ok');
    expect(res.notes.join(' ')).toMatch(/have not sent a heartbeat/);
  });

  it('does not label a fresh host as stale', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ ageMs: 2_000, containers: { embedding: hostOllamaEmbedding } }),
    ]);

    const res = await run();

    expect(res.hosts[0].stale).toBe(false);
    expect(res.notes.join(' ')).not.toMatch(/have not sent a heartbeat/);
  });
});

describe('fleet_status — never claims a rerank ran', () => {
  it('carries the authority note distinguishing reachability from rerankApplied', async () => {
    const res = await run();
    expect(res.notes[0]).toMatch(/authoritative for REACHABILITY/);
    expect(res.notes[0]).toMatch(/rerankApplied/);
  });
});

// ---------------------------------------------------------------------------

describe('role_assignments_list', () => {
  it('issues no network probes at all', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker, rlm: vllmRlm } }),
    ]);

    await runRoles();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists which hosts run which role, with model, port and residency', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({
        url: 'http://10.0.0.3:8098',
        hostname: 'gpu-c',
        containers: { rlm: vllmRlm },
        perRole: { rlm: { role: 'rlm', runtime: 'vllm', loaded: true, actualMb: 33000, budgetMb: 34000, priority: 'high', gpuOnly: false, modes: [], containerStatus: 'running' } },
      }),
    ]);

    const res = await runRoles({ role: 'rlm' });

    expect(res.assignments).toHaveLength(1);
    const rlm = res.assignments[0];
    expect(rlm.hosts).toHaveLength(1);
    expect(rlm.hosts[0]).toMatchObject({
      hostname: 'gpu-c',
      reported: 'running',
      reportedSynthetic: false,
      runtime: 'vllm',
      port: 8100,
      portSource: 'sidecar-container',
      loaded: true,
      actualMb: 33000,
    });
  });

  it('lists a policy role no host reports, with an explicit meaning', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding } }),
    ]);
    dbConfig.getConfig.mockResolvedValue({ gpuMode: 'searching', gpuMinRlm: 1, gpuIdleRlmMin: 10 });

    const res = await runRoles();

    const rlm = res.assignments.find((a) => a.role === 'rlm')!;
    expect(rlm.hosts).toEqual([]);
    expect(rlm.unreportedMeaning).toMatch(/NOT a statement that the role is down/);
    expect(rlm.policy).toEqual({ minOnline: 1, idleTimeoutMin: 10 });
    // Policy and observation reported side by side, never reconciled.
    expect(res.notes.join(' ')).toMatch(/Policy\/observation gap: rlm/);
  });

  it('omits unreported policy roles when the caller asks for observed placements only', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding } }),
    ]);

    const res = await runRoles({ includeUnreported: false });

    expect(res.assignments.map((a) => a.role)).toEqual(['embedding']);
  });

  it('omits `policy` entirely when Config is unreadable, rather than defaulting to zeros', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { reranker: vllmReranker } }),
    ]);
    dbConfig.getConfig.mockRejectedValue(new Error('db down'));

    const res = await runRoles();

    expect(res.assignments.find((a) => a.role === 'reranker')!.policy).toBeUndefined();
    expect(res.notes.join(' ')).toMatch(/means "unknown", not "zero"/);
  });

  it('reports genuine port drift across hosts', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ url: 'http://10.0.0.1:8098', containers: { reranker: vllmReranker } }),
      host({ url: 'http://10.0.0.2:8098', containers: { reranker: { ...vllmReranker, port: 9099 } } }),
    ]);

    const res = await runRoles({ role: 'reranker' });

    expect(res.assignments[0].ports).toHaveLength(2);
    expect(res.notes.join(' ')).toMatch(/Port drift: reranker/);
  });

  it('does NOT report a shared host-Ollama 11434 as drift', async () => {
    statusCache.getAllSidecarStatuses.mockReturnValue([
      host({ containers: { embedding: hostOllamaEmbedding, completion: hostOllamaCompletion, ocr: { ...hostOllamaEmbedding, name: 'ss-ocr' } } }),
    ]);

    const res = await runRoles();

    expect(res.notes.join(' ')).not.toMatch(/Port drift/);
  });

  it('reports an unreadable cache as an absence of information', async () => {
    statusCache.getAllSidecarStatuses.mockImplementation(() => {
      throw new Error('cache exploded');
    });

    const res = await runRoles();

    expect(res.assignments).toEqual([]);
    expect(res.hostsReporting).toEqual([]);
    expect(res.notes.join(' ')).toMatch(/absence of information about every role/);
  });
});
