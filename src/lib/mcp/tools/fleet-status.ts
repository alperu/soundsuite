/**
 * `fleet_status` — read-only, probing fleet visibility (docs/tasks/30, Part 3
 * item 3, amendments (a)–(c)).
 *
 * Writing REPORT-v12 required opening `/api/admin/gpu-fleet` in a browser pane
 * because nothing on the MCP surface answered "is the rerank path reachable
 * right now". This tool answers that. What it must NOT do is answer it by
 * re-serving the cache, and the reasons are specific:
 *
 *  - **It probes, it does not relay (amendment (a)).** The sidecar queries
 *    Ollama roles live (`/api/tags`, `/api/ps`) but has no equivalent for vLLM:
 *    `sideCar/src/lib/state.ts:411-412` says verbatim that vLLM "doesn't expose
 *    a per-model size endpoint like Ollama's /api/ps", so it infers liveness
 *    from `nvidia-smi` PID attribution. The vLLM roles (`reranker`, `rlm`) are
 *    exactly the ones whose health cannot otherwise be asserted, so this tool
 *    issues a bounded `GET /v1/models` against them. Every probe carries its own
 *    `AbortSignal.timeout`, all probes run under one `Promise.allSettled`, and a
 *    host that does not answer is reported as `unreachable`/`timeout` — never
 *    waited on past the budget.
 *
 *  - **It never invents a status vocabulary (amendment (c)).** Amendment (c)
 *    asks for seven states and then warns that six of them do not exist:
 *    `CachedSidecarStatus.containers[role].status` is typed bare `string` and the
 *    observed literals are `'running' | 'not_found' | 'error'`. Inventing five
 *    values nothing produces is the same "green because nothing checked" defect
 *    in new costume. Instead every role carries four ORTHOGONAL fields that are
 *    never collapsed into one word:
 *      `reported`          — the sidecar's own string, verbatim and unmapped
 *      `reportedSynthetic` — true when the sidecar ASSUMED that string rather
 *                            than probing (host-Ollama and Docker Model Runner
 *                            roles get a synthetic 'running'; see CLAUDE.md
 *                            "Host-Ollama mode" and `fleet-router.ts:601,606,611`)
 *      `staleMs`           — how old the heartbeat that carried it is
 *      `probe`             — what THIS tool observed on the wire, if anything
 *    A role the fleet does not mention is absent from `reportedBy` and named in
 *    `notReportedBy`: UNREPORTED is not down, and the two never share a field.
 *
 *  - **It adds no fourth role→port map (amendment (b)).** The map already exists
 *    three times and they disagree (`sideCar/src/lib/state.ts:59+` = 6 roles,
 *    `src/lib/gpu/fleet-router.ts:874-879` = 4, `src/lib/ai/stream-rlm.ts:53` = 1).
 *    A fourth copy here, consulted precisely when the sidecar told us nothing,
 *    would be worse than the trap it patches. Ports come from what the sidecar
 *    reported (`containers[role].config.port ?? containers[role].port`) and are
 *    `null` — with `probe: 'not_attempted'` — when it reported none.
 *
 *  - **`category: 'search'` and `profiles: ['local']`.** `tool-registry.ts:154-157`
 *    makes every non-`search` tool require a reachable Ollama under the `local`
 *    profile; a fleet tool that fails closed on a degraded fleet is useless in
 *    exactly the situation you most want it. And `tool-types.ts:56-58` makes an
 *    ABSENT `profiles` mean *both* profiles, so `['local']` is stated explicitly:
 *    this payload is infrastructure detail (hostnames, ports, VRAM) and a routed
 *    profile could hand it to a cloud model.
 *
 * It also declares no dependencies. A tool whose whole job is reporting fleet
 * degradation must not refuse because the fleet is degraded.
 *
 * **This tool does not prove a rerank happened.** A reachable host that timed
 * out mid-call still yields first-stage order. `probe: 'ok'` says the rerank
 * path was reachable at `observedAt`; only task 22's `rerankApplied` says the
 * reranker actually ran on a given call. See `roleAuthorityNote()`.
 */

import { BaseMCPTool } from './base-tool';
import type {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import type { CachedSidecarStatus } from '../../gpu/status-cache';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Mirrors `status-cache.ts:178` STALE_THRESHOLD_MS, which is not exported.
 * Used only to LABEL a host (`stale: true`), never to hide one: a stale entry
 * is the case where cached state is most likely to be lying, so it is still
 * reported and still probed.
 */
export const FLEET_STALE_THRESHOLD_MS = 30_000;

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const MIN_PROBE_TIMEOUT_MS = 250;
const MAX_PROBE_TIMEOUT_MS = 10_000;

/**
 * Container images the sidecar stamps when it is NOT managing a Docker
 * container and therefore did not observe the status it reports.
 *
 * - `host-ollama` — host-Ollama mode; `fleet-router.ts:601,606,611` stamp it,
 *   and CLAUDE.md records that `getContainerState` then "returns a synthetic
 *   `{status: 'running'}`".
 * - `dmr` — Docker Model Runner; CLAUDE.md records `getAllContainerStates`
 *   synthesising `{status: 'running', image: 'dmr'}`.
 *
 * Matching on the image rather than on a role list means a future host-runtime
 * role is labelled without an edit here.
 */
const SYNTHETIC_STATUS_IMAGES: Record<string, string> = {
  'host-ollama': 'host-Ollama runtime — the sidecar assumes this status rather than inspecting a container',
  dmr: 'Docker Model Runner — the sidecar synthesises this status; it does not manage DMR lifecycle',
};

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** What THIS tool observed on the wire. `not_attempted` is not a health claim. */
export type ProbeOutcome =
  | 'ok'
  | 'http_error'
  | 'timeout'
  | 'unreachable'
  | 'not_attempted';

export interface FleetRoleView {
  role: string;
  /** The sidecar's own status string, verbatim and unmapped. Observed literals
   *  today are 'running' | 'not_found' | 'error', but the field is typed bare
   *  `string` upstream, so nothing here narrows it. */
  reported: string;
  /** True when the sidecar assumed `reported` rather than observing it. */
  reportedSynthetic: boolean;
  /** Why `reportedSynthetic` is true. Absent when it is false. */
  syntheticBasis?: string;
  /** Runtime as reported — 'ollama' | 'vllm' | 'utility' | … Absent when the
   *  sidecar reported none, which is NOT the same as "not vLLM". */
  runtime?: string;
  /** False when no runtime was reported at all. Carried beside `runtime` for
   *  the same reason `reportedSynthetic` is carried beside `reported`: a caller
   *  must be able to tell silence from a negative answer. */
  runtimeReported: boolean;
  /** Container type as the sidecar registry declares it ('ollama' | 'vllm' | …). */
  type?: string;
  model?: string | null;
  /** From `containers[role].config.port ?? containers[role].port`. `null` when
   *  the sidecar reported neither — this tool does not guess a port. */
  port: number | null;
  portSource: 'sidecar-config' | 'sidecar-container' | 'unreported';
  /** VRAM accounting for this role, where the sidecar reports it. */
  vram?: { loaded: boolean; actualMb: number; budgetMb: number; gpuOnly: boolean; priority: string };
  /** Sidecar watchdog signal: false when a gpuOnly role is partly CPU-offloaded. */
  gpuReady?: boolean;
  probe: ProbeOutcome;
  /** Why the probe ended as it did — HTTP status, error text, or why it was skipped. */
  probeDetail?: string;
  probeMs?: number;
  /** Model ids `/v1/models` returned. Surfaced, not asserted against `model`:
   *  a 200 serving a different model than the role expects is a real failure
   *  mode, and the caller is better placed to judge it. */
  probeModels?: string[];
}

export interface FleetHostView {
  agentUrl: string;
  hostname: string;
  version?: string;
  mode: string;
  wsConnected: boolean;
  dockerMode?: string;
  lastSeen: number;
  /** Age of the newest heartbeat from this host, in ms. */
  staleMs: number;
  /** `staleMs > FLEET_STALE_THRESHOLD_MS`. A label, not a filter. */
  stale: boolean;
  activeRequests: number;
  gpus: Array<{ index: number; name: string; memoryTotal: number; memoryUsed: number; memoryFree: number }>;
  /** Sidecar's own VRAM accounting totals, where reported. */
  vram?: { totalMb: number; freeMb: number; usedMb: number; unattributedMb: number; ts: number };
  /** Host-level memory stats for non-NVIDIA hosts (Mac / Windows). */
  hostStats?: { totalMb?: number; freeMb?: number; usedMb?: number; source?: string };
  roles: FleetRoleView[];
}

export interface FleetRoleSummary {
  role: string;
  /** Hosts whose heartbeat carries an entry for this role. */
  reportedBy: string[];
  /**
   * Hosts that report OTHER roles but say nothing about this one. Kept in its
   * own field and never merged with a reachability verdict: a host that does
   * not mention a role has told you NOTHING about it (amendment (c)).
   */
  notReportedBy: string[];
  /** Count of `reportedBy` hosts whose verbatim status is exactly 'running'. */
  reportedRunning: number;
  /** How many of those 'running' values the sidecar assumed rather than observed. */
  reportedRunningSynthetic: number;
  /** Probe outcomes across hosts, keyed by outcome. Absent keys are zero. */
  probes: Partial<Record<ProbeOutcome, number>>;
  /**
   * Distinct ports observed for this role across hosts, with the runtime that
   * reported each. Amendment (b): a shared host-Ollama answers on 11434
   * regardless of role and that is CORRECT — `sharedOllamaPort` marks it so a
   * caller never reads it as drift.
   */
  ports: Array<{ port: number | null; hosts: string[]; sharedOllamaPort: boolean }>;
}

export interface FleetStatusResult {
  observedAt: number;
  stalenessThresholdMs: number;
  probing: { attempted: number; timeoutMs: number; wallClockMs: number };
  hosts: FleetHostView[];
  roles: FleetRoleSummary[];
  /** Reading instructions that would otherwise have to be inferred. */
  notes: string[];
}

export interface FleetStatusParams {
  /** Restrict the report to one role. Hosts with no entry for it still appear
   *  in `roles[].notReportedBy`. */
  role?: string;
  /** Issue live `GET /v1/models` probes against vLLM-runtime roles (default true). */
  probe?: boolean;
  /** Per-host probe budget in ms (default 2500, clamped to 250–10000). */
  probeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Reading the cache (shared with role_assignments_list)
// ---------------------------------------------------------------------------

/**
 * Snapshot every sidecar the master has heard from, stale entries included.
 *
 * `getAllSidecarStatuses()` (`status-cache.ts:230-232`) is a bare
 * `Array.from(cache.values())` with NO staleness filter — unlike its siblings
 * `findSidecarsWithRole` (`:267`) and `isSidecarConnected` (`:241`), which both
 * filter. That asymmetry is the reason this module computes `staleMs` itself
 * instead of trusting membership in the returned array to mean "connected".
 *
 * Never throws: an unreadable cache yields `null`, which callers must render as
 * "nothing was learned", not as an empty fleet.
 */
export async function readFleetSnapshot(): Promise<
  { ok: true; sidecars: CachedSidecarStatus[] } | { ok: false; reason: string }
> {
  try {
    const statusCache = await import('../../gpu/status-cache');
    return { ok: true, sidecars: statusCache.getAllSidecarStatuses() };
  } catch (err) {
    return { ok: false, reason: (err as Error)?.message ?? String(err) };
  }
}

/** Resolve a role's port from what the sidecar reported. Never guesses. */
export function resolveRolePort(
  container: CachedSidecarStatus['containers'][string],
): { port: number | null; portSource: FleetRoleView['portSource'] } {
  const cfgPort = container.config?.port;
  if (typeof cfgPort === 'number' && cfgPort > 0) return { port: cfgPort, portSource: 'sidecar-config' };
  if (typeof container.port === 'number' && container.port > 0) {
    return { port: container.port, portSource: 'sidecar-container' };
  }
  return { port: null, portSource: 'unreported' };
}

/** Is `reported` a value the sidecar assumed rather than observed? */
export function detectSyntheticStatus(
  container: CachedSidecarStatus['containers'][string],
): { synthetic: boolean; basis?: string } {
  const image = (container.image ?? container.config?.image ?? '').trim();
  const basis = SYNTHETIC_STATUS_IMAGES[image];
  return basis ? { synthetic: true, basis } : { synthetic: false };
}

/**
 * Which runtime a role reports, or `undefined` when it reports none.
 *
 * Deliberately three-valued rather than an `isVllmRole(): boolean`. Every field
 * this reads is optional upstream — `containers[role].type` and
 * `config?.type` (`status-cache.ts:26,32`) and the whole `vram` block
 * (`:40`) — so a sidecar can report `{status:'running', name:'ss-reranker',
 * port:8099}` and say nothing about runtime at all. A boolean collapses that
 * silence into "not vLLM", which is `unreported` turned into a positive claim:
 * the exact confusion amendment (c) exists to stop, reproduced inside the tool
 * built to stop it. Callers must branch on all three cases.
 *
 * Derived from what is reported, never from a hardcoded `['reranker','rlm']`
 * pair — `type: 'vllm'` is set by the sidecar registry
 * (`sideCar/src/lib/state.ts`) for every vLLM role and
 * `vram.perRole[role].runtime` corroborates it — so a future vLLM role is
 * probed without an edit here.
 *
 * Ollama roles are deliberately NOT probed: the sidecar already queries them
 * live via `/api/tags` and `/api/ps`, so its reported status for them is an
 * observation. It is only vLLM whose status is inferred.
 */
export function resolveRoleRuntime(
  container: CachedSidecarStatus['containers'][string],
  perRole?: { runtime?: string },
): string | undefined {
  const type = (container.type ?? container.config?.type ?? '').trim().toLowerCase();
  if (type) return type;
  const runtime = perRole?.runtime?.trim().toLowerCase();
  return runtime || undefined;
}

/** Host part of a sidecar agent URL (`http://10.0.0.5:8098` → `10.0.0.5`). */
export function hostOf(agentUrl: string): string | null {
  try {
    return new URL(agentUrl).hostname || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The bounded probe
// ---------------------------------------------------------------------------

interface ProbeTarget {
  hostIndex: number;
  roleIndex: number;
  url: string;
}

interface ProbeResult {
  probe: ProbeOutcome;
  probeDetail?: string;
  probeMs: number;
  probeModels?: string[];
}

/**
 * One bounded `GET /v1/models`. Never throws, never outlives `timeoutMs`.
 *
 * The cautionary example is the reranker's own 90 s batch timeout
 * (`src/lib/search/reranker.ts:190-192`): a health check inherits none of that
 * budget. A host that does not answer inside `timeoutMs` is reported as
 * `timeout` — which is a statement about this probe, not a verdict on the host.
 */
export async function probeVllmModels(url: string, timeoutMs: number): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const probeMs = Date.now() - t0;
    if (!res.ok) {
      return { probe: 'http_error', probeDetail: `HTTP ${res.status}`, probeMs };
    }
    let probeModels: string[] | undefined;
    try {
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = Array.isArray(body?.data)
        ? body.data.map((m) => m?.id).filter((id): id is string => typeof id === 'string')
        : [];
      probeModels = ids;
    } catch {
      // A 200 that is not the expected JSON is still a reachable endpoint —
      // report `ok` with no model list rather than downgrading reachability.
      probeModels = undefined;
    }
    return { probe: 'ok', probeMs, ...(probeModels ? { probeModels } : {}) };
  } catch (err) {
    const probeMs = Date.now() - t0;
    const name = (err as Error)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    const msg = (err as Error)?.message ?? String(err);
    return {
      probe: timedOut ? 'timeout' : 'unreachable',
      probeDetail: timedOut ? `no answer within ${timeoutMs} ms` : msg.slice(0, 160),
      probeMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The authority note item 6 of task 30 asks for, carried in the payload rather
 * than left to the caller's memory.
 */
export function roleAuthorityNote(): string {
  return (
    'A probe result is authoritative for REACHABILITY at observedAt, not for what ran on any ' +
    'given call. A reachable reranker that timed out mid-request still yields first-stage order. ' +
    'Once task 22 ships `rerankApplied` in search responses, THAT field is authoritative for ' +
    '"did rerank run on this call"; fleet_status stays authoritative for "is the rerank path ' +
    'reachable now". Neither substitutes for the other.'
  );
}

export function buildHostViews(
  sidecars: CachedSidecarStatus[],
  now: number,
  roleFilter?: string,
): FleetHostView[] {
  return sidecars.map((s) => {
    const staleMs = Math.max(0, now - (s.lastSeen ?? 0));
    const containers = s.containers ?? {};
    const roleNames = Object.keys(containers)
      .filter((r) => !roleFilter || r === roleFilter)
      .sort();

    const roles: FleetRoleView[] = roleNames.map((role) => {
      const c = containers[role];
      const perRole = s.vram?.perRole?.[role];
      const { port, portSource } = resolveRolePort(c);
      const { synthetic, basis } = detectSyntheticStatus(c);
      const runtime = resolveRoleRuntime(c, perRole);
      return {
        role,
        reported: typeof c.status === 'string' ? c.status : String(c.status),
        reportedSynthetic: synthetic,
        ...(basis ? { syntheticBasis: basis } : {}),
        ...(runtime ? { runtime } : {}),
        runtimeReported: !!runtime,
        ...(c.type ?? c.config?.type ? { type: c.type ?? c.config?.type } : {}),
        ...(c.model !== undefined ? { model: c.model } : c.config?.model !== undefined ? { model: c.config.model } : {}),
        port,
        portSource,
        ...(perRole
          ? {
              vram: {
                loaded: perRole.loaded,
                actualMb: perRole.actualMb,
                budgetMb: perRole.budgetMb,
                gpuOnly: perRole.gpuOnly,
                priority: perRole.priority,
              },
            }
          : {}),
        ...(c.gpuReady !== undefined ? { gpuReady: c.gpuReady } : {}),
        // Filled in by the probe pass; `not_attempted` is the honest default.
        probe: 'not_attempted' as ProbeOutcome,
      };
    });

    return {
      agentUrl: s.agentUrl,
      hostname: s.hostname,
      ...(s.version ? { version: s.version } : {}),
      mode: s.mode,
      wsConnected: !!s.wsConnected,
      ...(s.dockerMode ? { dockerMode: s.dockerMode } : {}),
      lastSeen: s.lastSeen ?? 0,
      staleMs,
      stale: staleMs > FLEET_STALE_THRESHOLD_MS,
      activeRequests: s.activeRequests ?? 0,
      gpus: Array.isArray(s.gpus) ? s.gpus : [],
      ...(s.vram
        ? {
            vram: {
              totalMb: s.vram.totalMb,
              freeMb: s.vram.freeMb,
              usedMb: s.vram.usedMb,
              unattributedMb: s.vram.unattributedMb,
              ts: s.vram.ts,
            },
          }
        : {}),
      ...(s.host?.stats
        ? {
            hostStats: {
              totalMb: s.host.stats.totalMb,
              freeMb: s.host.stats.freeMb,
              usedMb: s.host.stats.usedMb,
              source: s.host.stats.source,
            },
          }
        : {}),
      roles,
    };
  });
}

/**
 * Per-role rollup. `notReportedBy` is the field amendment (c) exists for: a host
 * that reports other roles but not this one appears there and NOWHERE in any
 * reachability count.
 */
export function summariseRoles(hosts: FleetHostView[], roleFilter?: string): FleetRoleSummary[] {
  const allRoles = new Set<string>();
  for (const h of hosts) for (const r of h.roles) allRoles.add(r.role);
  if (roleFilter) {
    // A filtered report still names the role even when nothing reports it —
    // "no host mentions it" is the answer, and it is not "it is down".
    allRoles.add(roleFilter);
    for (const r of [...allRoles]) if (r !== roleFilter) allRoles.delete(r);
  }

  return [...allRoles].sort().map((role) => {
    const reportedBy: string[] = [];
    const notReportedBy: string[] = [];
    const probes: Partial<Record<ProbeOutcome, number>> = {};
    const portBuckets = new Map<string, { port: number | null; hosts: string[]; sharedOllamaPort: boolean }>();
    let reportedRunning = 0;
    let reportedRunningSynthetic = 0;

    for (const h of hosts) {
      const view = h.roles.find((r) => r.role === role);
      if (!view) {
        notReportedBy.push(h.agentUrl);
        continue;
      }
      reportedBy.push(h.agentUrl);
      if (view.reported === 'running') {
        reportedRunning += 1;
        if (view.reportedSynthetic) reportedRunningSynthetic += 1;
      }
      probes[view.probe] = (probes[view.probe] ?? 0) + 1;

      // Amendment (b): a shared host-Ollama answers on 11434 for EVERY Ollama
      // role. That is encoded behaviour (fleet-router.ts:601,606,611), not
      // drift, so it is flagged as such rather than counted as disagreement.
      // Port 11434 with NO reported runtime is treated as shared too: the
      // alternative is counting an unreported role as drift on the strength of
      // a runtime nothing declared.
      const sharedOllamaPort =
        view.port === 11434 && (!view.runtimeReported || view.runtime === 'ollama');
      const key = `${view.port ?? 'null'}`;
      const bucket = portBuckets.get(key);
      if (bucket) {
        bucket.hosts.push(h.agentUrl);
        bucket.sharedOllamaPort = bucket.sharedOllamaPort && sharedOllamaPort;
      } else {
        portBuckets.set(key, { port: view.port, hosts: [h.agentUrl], sharedOllamaPort });
      }
    }

    return {
      role,
      reportedBy,
      notReportedBy,
      reportedRunning,
      reportedRunningSynthetic,
      probes,
      ports: [...portBuckets.values()],
    };
  });
}

function clampTimeout(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.min(MAX_PROBE_TIMEOUT_MS, Math.max(MIN_PROBE_TIMEOUT_MS, Math.floor(v)));
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class FleetStatusTool extends BaseMCPTool<FleetStatusParams, FleetStatusResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'fleet_status',
      displayName: 'Fleet Status',
      description:
        'Read-only GPU fleet visibility: which hosts have reported, which roles each declares, ' +
        'ports, VRAM where the sidecar accounts for it, and — for vLLM-served roles (reranker, ' +
        'rlm) — a LIVE bounded GET /v1/models probe, because the sidecar cannot observe vLLM ' +
        'liveness the way it observes Ollama. Each role carries four separate fields that are ' +
        'never collapsed into one verdict: `reported` (the sidecar\'s own status string, ' +
        'verbatim), `reportedSynthetic` (true when the sidecar ASSUMED that status instead of ' +
        'observing it — host-Ollama and Docker Model Runner roles do this), `staleMs` on the ' +
        'owning host (how old the heartbeat is), and `probe` (what this call saw on the wire). ' +
        'A host that does not mention a role appears in roles[].notReportedBy and NOWHERE in any ' +
        'reachability count: unreported is not down. Ports are only ever what a sidecar reported; ' +
        'an unreported port yields port: null and probe: "not_attempted", never a guess. This ' +
        'tool does not prove a rerank ran — see notes[] — only that the path was reachable.',
      version: '1.0.0',
      category: 'search',
      // Explicit: an absent `profiles` means BOTH profiles (tool-types.ts:56-58),
      // and this payload is infrastructure detail a routed profile could hand to
      // a cloud model (task 30 Risks).
      profiles: ['local'],
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description:
              'Restrict the report to one role (embedding, code-embedding, completion, ocr, ' +
              'reranker, rlm, …). Hosts that do not report it are still listed under ' +
              'roles[].notReportedBy.',
          },
          probe: {
            type: 'boolean',
            description:
              'Issue live GET /v1/models probes against vLLM-runtime roles (default true). Set ' +
              'false for a pure cache read — every role then carries probe: "not_attempted".',
          },
          probeTimeoutMs: {
            type: 'integer',
            description:
              'Per-host probe budget in ms (default 2500, clamped to 250-10000). Probes run in ' +
              'parallel, so total wall clock is bounded by roughly this value, not by host count.',
          },
        },
        required: [],
      },
    };
  }

  /** None. A tool that reports fleet degradation must not refuse because the
   *  fleet is degraded. */
  getDependencies() {
    return [];
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  async executeImpl(
    params: FleetStatusParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<FleetStatusResult> {
    const t0 = Date.now();
    const roleFilter = typeof params?.role === 'string' && params.role.trim() ? params.role.trim() : undefined;
    const wantProbe = params?.probe !== false;
    const timeoutMs = clampTimeout(params?.probeTimeoutMs);

    const notes: string[] = [roleAuthorityNote()];

    const snapshot = await readFleetSnapshot();
    if (!snapshot.ok) {
      // Nothing was learned. That is reported as such — an empty `hosts` with a
      // note, never as a fleet that is down.
      notes.push(
        `The fleet state cache could not be read (${snapshot.reason}). This report says NOTHING ` +
          'about any host or role — it is not evidence that the fleet is down.',
      );
      return {
        observedAt: t0,
        stalenessThresholdMs: FLEET_STALE_THRESHOLD_MS,
        probing: { attempted: 0, timeoutMs, wallClockMs: Date.now() - t0 },
        hosts: [],
        roles: [],
        notes,
      };
    }

    const hosts = buildHostViews(snapshot.sidecars, t0, roleFilter);

    if (hosts.length === 0) {
      notes.push(
        'No sidecar has ever reported to this master. That is an absence of information about ' +
          'every role, not a statement that any role is down.',
      );
    }

    // -- Probe pass ---------------------------------------------------------
    let attempted = 0;
    if (wantProbe) {
      const targets: ProbeTarget[] = [];
      hosts.forEach((h, hostIndex) => {
        const host = hostOf(h.agentUrl);
        h.roles.forEach((r, roleIndex) => {
          const container = snapshot.sidecars[hostIndex]?.containers?.[r.role];
          if (!container) return;
          // Three-valued, not two. An unreported runtime is NOT evidence the
          // role is Ollama-served, and must not be described as one.
          const runtime = resolveRoleRuntime(
            container,
            snapshot.sidecars[hostIndex]?.vram?.perRole?.[r.role],
          );
          if (!runtime) {
            r.probeDetail =
              'the sidecar reported no runtime type for this role, so it is not known whether its ' +
              'status was observed (Ollama, via /api/tags and /api/ps) or inferred (vLLM, which the ' +
              'sidecar cannot observe) — not probed, and this says nothing about the role';
            return;
          }
          if (runtime !== 'vllm') {
            r.probeDetail =
              `reported runtime is "${runtime}" — the sidecar observes Ollama roles live via ` +
              '/api/tags and /api/ps, so its reported status for them is an observation, not an inference';
            return;
          }
          if (r.port === null) {
            r.probeDetail =
              'the sidecar reported no port for this role, and this tool does not guess one ' +
              '(the role->port map already exists three times and they disagree — task 30 amendment (b))';
            return;
          }
          if (!host) {
            r.probeDetail = `could not parse a hostname from agentUrl "${h.agentUrl}"`;
            return;
          }
          targets.push({ hostIndex, roleIndex, url: `http://${host}:${r.port}/v1/models` });
        });
      });

      attempted = targets.length;
      // One `allSettled` over every target: wall clock is bounded by the single
      // longest probe, not by targets.length * timeoutMs.
      const results = await Promise.allSettled(
        targets.map((t) => probeVllmModels(t.url, timeoutMs)),
      );
      results.forEach((res, i) => {
        const { hostIndex, roleIndex } = targets[i];
        const view = hosts[hostIndex].roles[roleIndex];
        if (res.status === 'fulfilled') {
          Object.assign(view, res.value);
        } else {
          // `probeVllmModels` never rejects, but a rejection here must still not
          // become a health verdict.
          view.probe = 'unreachable';
          view.probeDetail = String(res.reason).slice(0, 160);
        }
      });
    } else {
      notes.push('Probing was disabled by the caller — every `probe` field reads "not_attempted".');
    }

    const roles = summariseRoles(hosts, roleFilter);

    const staleHosts = hosts.filter((h) => h.stale);
    if (staleHosts.length > 0) {
      notes.push(
        `${staleHosts.length} of ${hosts.length} host(s) have not sent a heartbeat within ` +
          `${FLEET_STALE_THRESHOLD_MS} ms (see host.stale / host.staleMs). Their "reported" values ` +
          'are last-known, not current. They were still probed — a stale cache is exactly where ' +
          'cached state is most likely to disagree with the wire.',
      );
    }

    const syntheticRoles = roles.filter((r) => r.reportedRunningSynthetic > 0);
    if (syntheticRoles.length > 0) {
      notes.push(
        `Synthetic 'running': ${syntheticRoles
          .map((r) => `${r.role} (${r.reportedRunningSynthetic}/${r.reportedRunning})`)
          .join(', ')}. The sidecar assumes these rather than inspecting a container ` +
          '(host-Ollama and Docker Model Runner). Read them as "nothing has said otherwise", ' +
          'not as "something checked".',
      );
    }

    context.logger?.info?.('fleet_status', {
      hosts: hosts.length,
      roles: roles.length,
      probesAttempted: attempted,
      wallClockMs: Date.now() - t0,
    });

    return {
      observedAt: t0,
      stalenessThresholdMs: FLEET_STALE_THRESHOLD_MS,
      probing: { attempted, timeoutMs, wallClockMs: Date.now() - t0 },
      hosts,
      roles,
      notes,
    };
  }
}
