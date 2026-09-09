/**
 * `role_assignments_list` — read-only "which role runs where" (docs/tasks/30,
 * Part 3 item 4).
 *
 * The complement to `fleet_status`, not a subset of it. `fleet_status` is
 * host-major and probes; this is ROLE-major and does not touch the network at
 * all. It answers a placement question — which hosts declare a role, what model
 * and port each advertises, and what the master's own policy says should be
 * online — where `fleet_status` answers a health question.
 *
 * Design notes that are load-bearing:
 *
 *  - **No probing.** Deliberate. A placement question has a cached answer by
 *    construction; issuing probes here would make the two tools differ only by
 *    shape, and a caller wanting liveness should be steered to `fleet_status`
 *    rather than given a second, subtly-different health signal. The one thing
 *    it does carry from the health world is `reportedSynthetic`, because a
 *    placement report that says "running" without saying "assumed" is the same
 *    over-claim task 30 amendment (c) exists to stop.
 *
 *  - **Policy and observation are separate fields.** `policy.minOnline` and
 *    `policy.idleTimeoutMin` come from the master's `Config` table; `hosts[]`
 *    comes from sidecar heartbeats. They are reported side by side and never
 *    reconciled into a single "healthy" boolean — a role with `minOnline: 1`
 *    and zero reporting hosts is a policy/observation gap the caller should
 *    see, not a verdict this tool should issue.
 *
 *  - **Port disagreement is reported, shared-Ollama collapse is not (amendment
 *    (b)).** A host-runtime Ollama answers on 11434 for EVERY Ollama role
 *    (`fleet-router.ts:601,606,611` encode exactly that), so two roles sharing
 *    11434 on one host is correct and is flagged `sharedOllamaPort`, never as
 *    drift. Genuine drift — the same role advertising different ports across
 *    Docker-runtime hosts — surfaces as more than one entry in `ports[]`.
 *
 *  - **`category: 'search'`, `profiles: ['local']`, no dependencies** — the same
 *    three reasons as `fleet-status.ts`; see its header.
 *
 * Roles the master knows a POLICY for but no host reports are still listed,
 * with an empty `hosts` array and `unreportedMeaning` spelled out. A role no
 * host mentions is an absence of information, never a claim that it is down.
 */

import { BaseMCPTool } from './base-tool';
import type {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';
import {
  FLEET_STALE_THRESHOLD_MS,
  readFleetSnapshot,
  resolveRolePort,
  resolveRoleRuntime,
  detectSyntheticStatus,
} from './fleet-status';

export interface RoleAssignmentHost {
  agentUrl: string;
  hostname: string;
  /** The sidecar's own status string, verbatim and unmapped. */
  reported: string;
  /** True when the sidecar assumed `reported` rather than observing it. */
  reportedSynthetic: boolean;
  syntheticBasis?: string;
  /** Absent when the sidecar reported no runtime — not the same as "not vLLM". */
  runtime?: string;
  /** False when no runtime was reported at all. */
  runtimeReported: boolean;
  type?: string;
  model?: string | null;
  port: number | null;
  portSource: 'sidecar-config' | 'sidecar-container' | 'unreported';
  /** Age of the heartbeat carrying this entry, in ms. */
  staleMs: number;
  stale: boolean;
  /** VRAM residency, where the sidecar accounts for it. */
  loaded?: boolean;
  actualMb?: number;
  budgetMb?: number;
}

export interface RoleAssignment {
  role: string;
  hosts: RoleAssignmentHost[];
  /** Hosts that report OTHER roles but say nothing about this one. */
  notReportedBy: string[];
  /** Distinct ports advertised for this role. More than one entry with
   *  `sharedOllamaPort: false` is genuine drift worth investigating. */
  ports: Array<{ port: number | null; hosts: string[]; sharedOllamaPort: boolean }>;
  /** Master-side policy from the Config table. Absent when config is unreadable. */
  policy?: { minOnline?: number; idleTimeoutMin?: number };
  /** Present only when `hosts` is empty — says what that does and does not mean. */
  unreportedMeaning?: string;
}

export interface RoleAssignmentsResult {
  observedAt: number;
  stalenessThresholdMs: number;
  /** Master-wide fleet mode from Config (`indexing` | `searching`). */
  gpuMode?: string;
  /** Hosts that have reported at all — the denominator for `notReportedBy`. */
  hostsReporting: string[];
  assignments: RoleAssignment[];
  notes: string[];
}

export interface RoleAssignmentsParams {
  /** Restrict to one role. It is still listed when no host reports it. */
  role?: string;
  /** Include roles the master holds policy for but no host reports (default true). */
  includeUnreported?: boolean;
}

/**
 * Role names the master's own Config carries policy for. Read from the config
 * keys, which is why this list is safe to state here: it is not a role→port map
 * (task 30 amendment (b) forbids a fourth of those), it is the set of roles
 * `getConfig()` exposes `gpuMin*` / `gpuIdle*` fields for
 * (`src/lib/db/config.ts:305,312`).
 */
const POLICY_ROLES = [
  'embedding',
  'code-embedding',
  'completion',
  'ocr',
  'reranker',
  'rlm',
] as const;

type PolicyRole = (typeof POLICY_ROLES)[number];

const MIN_ONLINE_KEY: Record<PolicyRole, string> = {
  embedding: 'gpuMinEmbedding',
  'code-embedding': 'gpuMinCodeEmbedding',
  completion: 'gpuMinCompletion',
  ocr: 'gpuMinOcr',
  reranker: 'gpuMinReranker',
  rlm: 'gpuMinRlm',
};

const IDLE_KEY: Record<PolicyRole, string> = {
  embedding: 'gpuIdleEmbeddingMin',
  'code-embedding': 'gpuIdleCodeEmbeddingMin',
  completion: 'gpuIdleCompletionMin',
  ocr: 'gpuIdleOcrMin',
  reranker: 'gpuIdleRerankerMin',
  rlm: 'gpuIdleRlmMin',
};

/** Never throws — an unreadable Config yields `null`, and every `policy` is
 *  then omitted rather than defaulted to zeros a caller would read as real. */
async function readPolicy(): Promise<Record<string, unknown> | null> {
  try {
    const { getConfig } = await import('../../db/config');
    return (await getConfig()) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

const UNREPORTED_MEANING =
  'No host currently reports this role. That is an absence of information — it is NOT a ' +
  'statement that the role is down, unavailable, or unconfigured. A sidecar that has not sent ' +
  'a heartbeat, or that declares a container without reporting its state, produces exactly this.';

export class RoleAssignmentsListTool extends BaseMCPTool<RoleAssignmentsParams, RoleAssignmentsResult> {
  getMetadata(): ToolMetadata {
    return {
      name: 'role_assignments_list',
      displayName: 'Role Assignments',
      description:
        'Read-only placement map for GPU fleet roles: for each role (embedding, code-embedding, ' +
        'completion, ocr, reranker, rlm), which hosts declare it, with the model, port and ' +
        'runtime each advertises, VRAM residency where the sidecar accounts for it, and the ' +
        "master's own policy (minOnline, idleTimeoutMin) side by side — never reconciled into a " +
        'single healthy/unhealthy verdict. Issues NO network probes; use fleet_status for ' +
        'liveness. Each host entry carries `reported` (the sidecar\'s verbatim status string) ' +
        'and `reportedSynthetic` (true when the sidecar assumed it rather than observing it). ' +
        'A role no host reports is still listed, with hosts: [] and an explicit note that this ' +
        'is an absence of information, not a claim the role is down. Ports are only ever what a ' +
        'sidecar reported; two Ollama roles sharing 11434 on one host is correct behaviour and ' +
        'is flagged sharedOllamaPort, not drift.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local'],
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description: 'Restrict to one role. It is still listed when no host reports it.',
          },
          includeUnreported: {
            type: 'boolean',
            description:
              'Include roles the master holds policy for but no host currently reports ' +
              '(default true). Set false for observed placements only.',
          },
        },
        required: [],
      },
    };
  }

  getDependencies() {
    return [];
  }

  protected rejectsUnknownParams(): boolean {
    return true;
  }

  async executeImpl(
    params: RoleAssignmentsParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<RoleAssignmentsResult> {
    const now = Date.now();
    const roleFilter = typeof params?.role === 'string' && params.role.trim() ? params.role.trim() : undefined;
    const includeUnreported = params?.includeUnreported !== false;
    const notes: string[] = [];

    const snapshot = await readFleetSnapshot();
    const policy = await readPolicy();
    if (!policy) {
      notes.push(
        'The master Config table could not be read — every `policy` block is omitted rather ' +
          'than defaulted, so a missing policy here means "unknown", not "zero".',
      );
    }

    if (!snapshot.ok) {
      notes.push(
        `The fleet state cache could not be read (${snapshot.reason}). No placement can be ` +
          'reported; this is an absence of information about every role.',
      );
      return {
        observedAt: now,
        stalenessThresholdMs: FLEET_STALE_THRESHOLD_MS,
        ...(policy?.gpuMode ? { gpuMode: String(policy.gpuMode) } : {}),
        hostsReporting: [],
        assignments: [],
        notes,
      };
    }

    const sidecars = snapshot.sidecars;
    const hostsReporting = sidecars.map((s) => s.agentUrl);

    // Every role any host mentions, plus every role the master holds policy for.
    const roleNames = new Set<string>();
    for (const s of sidecars) for (const r of Object.keys(s.containers ?? {})) roleNames.add(r);
    if (includeUnreported) for (const r of POLICY_ROLES) roleNames.add(r);
    if (roleFilter) {
      roleNames.clear();
      roleNames.add(roleFilter);
    }

    const assignments: RoleAssignment[] = [...roleNames].sort().map((role) => {
      const hosts: RoleAssignmentHost[] = [];
      const notReportedBy: string[] = [];
      const portBuckets = new Map<string, { port: number | null; hosts: string[]; sharedOllamaPort: boolean }>();

      for (const s of sidecars) {
        const c = s.containers?.[role];
        if (!c) {
          notReportedBy.push(s.agentUrl);
          continue;
        }
        const staleMs = Math.max(0, now - (s.lastSeen ?? 0));
        const { port, portSource } = resolveRolePort(c);
        const { synthetic, basis } = detectSyntheticStatus(c);
        const perRole = s.vram?.perRole?.[role];
        const type = c.type ?? c.config?.type;
        // Three-valued: `undefined` means the sidecar reported no runtime,
        // which is not the same as reporting a non-Ollama one.
        const runtime = resolveRoleRuntime(c, perRole);

        hosts.push({
          agentUrl: s.agentUrl,
          hostname: s.hostname,
          reported: typeof c.status === 'string' ? c.status : String(c.status),
          reportedSynthetic: synthetic,
          ...(basis ? { syntheticBasis: basis } : {}),
          ...(runtime ? { runtime } : {}),
          runtimeReported: !!runtime,
          ...(type ? { type } : {}),
          ...(c.model !== undefined ? { model: c.model } : c.config?.model !== undefined ? { model: c.config.model } : {}),
          port,
          portSource,
          staleMs,
          stale: staleMs > FLEET_STALE_THRESHOLD_MS,
          ...(perRole
            ? { loaded: perRole.loaded, actualMb: perRole.actualMb, budgetMb: perRole.budgetMb }
            : {}),
        });

        // An unreported runtime on 11434 counts as shared: the alternative is
        // calling a role drift on the strength of a runtime nothing declared.
        const sharedOllamaPort = port === 11434 && (!runtime || runtime === 'ollama');
        const key = `${port ?? 'null'}`;
        const bucket = portBuckets.get(key);
        if (bucket) {
          bucket.hosts.push(s.agentUrl);
          bucket.sharedOllamaPort = bucket.sharedOllamaPort && sharedOllamaPort;
        } else {
          portBuckets.set(key, { port, hosts: [s.agentUrl], sharedOllamaPort });
        }
      }

      const policyRole = (POLICY_ROLES as readonly string[]).includes(role) ? (role as PolicyRole) : undefined;
      const minOnline = policyRole && policy ? policy[MIN_ONLINE_KEY[policyRole]] : undefined;
      const idleTimeoutMin = policyRole && policy ? policy[IDLE_KEY[policyRole]] : undefined;
      const policyBlock =
        typeof minOnline === 'number' || typeof idleTimeoutMin === 'number'
          ? {
              ...(typeof minOnline === 'number' ? { minOnline } : {}),
              ...(typeof idleTimeoutMin === 'number' ? { idleTimeoutMin } : {}),
            }
          : undefined;

      return {
        role,
        hosts,
        notReportedBy,
        ports: [...portBuckets.values()],
        ...(policyBlock ? { policy: policyBlock } : {}),
        ...(hosts.length === 0 ? { unreportedMeaning: UNREPORTED_MEANING } : {}),
      };
    });

    // Genuine port drift: the same role advertising more than one non-shared
    // port across hosts. The shared-Ollama 11434 collapse is excluded by
    // construction (amendment (b)).
    const drifting = assignments.filter(
      (a) => a.ports.filter((p) => p.port !== null && !p.sharedOllamaPort).length > 1,
    );
    if (drifting.length > 0) {
      notes.push(
        `Port drift: ${drifting
          .map((a) => `${a.role} (${a.ports.map((p) => p.port ?? 'unreported').join(', ')})`)
          .join('; ')}. A shared host-Ollama answering on 11434 for several roles is NOT drift ` +
          'and is excluded here; these are the same role advertising different ports across hosts.',
      );
    }

    const gaps = assignments.filter(
      (a) => typeof a.policy?.minOnline === 'number' && a.policy.minOnline > 0 && a.hosts.length === 0,
    );
    if (gaps.length > 0) {
      notes.push(
        `Policy/observation gap: ${gaps.map((a) => a.role).join(', ')} have minOnline > 0 but no ` +
          'host reports them. Reported side by side deliberately — this tool does not decide ' +
          'whether that is a misconfiguration or a sidecar that has not reported yet.',
      );
    }

    notes.push(
      'This tool issues no network probes. `reported` is what a sidecar last said, not what is ' +
        'true now; for a live check of the vLLM-served roles (reranker, rlm) call fleet_status.',
    );

    context.logger?.info?.('role_assignments_list', {
      hosts: hostsReporting.length,
      roles: assignments.length,
    });

    return {
      observedAt: now,
      stalenessThresholdMs: FLEET_STALE_THRESHOLD_MS,
      ...(policy?.gpuMode ? { gpuMode: String(policy.gpuMode) } : {}),
      hostsReporting,
      assignments,
      notes,
    };
  }
}
