/**
 * Role Registry — simplified (post 2.3).
 *
 * The RoleType CRUD table is gone. There is now a fixed 4-mode catalog
 * (`ss-embedding`, `ss-completion`, `ss-ocr`, `ss-reranker`) resolved
 * per-OS by the sidecar (see sideCar/src/lib/mode-templates.ts).
 *
 * The master stores per-host enablement, minOnline, idleTimeout, and an
 * optional modelOverride per mode in `HostRoleAssignment`. Everything else
 * (image, port, vram, type, priority, runtime) is derived by the sidecar
 * from its own OS.
 *
 * Wire contract pushed by fleet-router.ts:
 *   { enabledModes: string[], modelOverrides?: Record<string,string>, ... }
 */

import { prisma } from './prisma';
import type { HostRoleAssignment } from '@prisma/client';

// ─── Public types ───────────────────────────────────────────────────────
//
// All the static mode-catalog data (defaults, availability, labels) is
// shared with the UI in src/lib/gpu/mode-catalog.ts. Re-exporting here so
// existing import paths keep working without each consumer having to know
// about the new file.

import {
  ALL_MODES,
  MODE_CATALOG,
  isModeName,
  defaultModelFor,
  resolveModelFromConfig,
  type ModeName,
  type ModeCatalogEntry,
  type HostOs,
} from '@/lib/gpu/mode-catalog';
import {
  getModeCatalog,
  defaultModelForAsync,
} from '@/lib/gpu/mode-catalog-server';
export {
  ALL_MODES,
  MODE_CATALOG,
  getModeCatalog,
  isModeName,
  defaultModelFor,
  defaultModelForAsync,
  resolveModelFromConfig,
};
export type { ModeName, ModeCatalogEntry, HostOs };

/**
 * Allowed runtime values for a HostRoleAssignment row. Mirrors the sidecar's
 * `RuntimeChoice` in mode-templates.ts.
 *   'host'                — native Ollama via host.docker.internal:11434 (Mac primary)
 *   'docker-ollama'       — sidecar runs `ollama/ollama` container w/ GPU passthrough
 *   'docker-vllm'         — sidecar runs `vllm/vllm-openai` container (CUDA only)
 *   'docker-model-runner' — Docker Model Runner (vllm-metal on Apple Silicon,
 *                           DMR on Linux). Used by ss-rlm on Mac since plain
 *                           docker-vllm has no GPU on macOS.
 */
export type RuntimeChoice = 'host' | 'docker-ollama' | 'docker-vllm' | 'docker-model-runner';

export interface AssignmentInput {
  sidecarUrl: string;
  mode: string;
  enabled?: boolean;
  minOnline?: number;
  idleTimeoutMin?: number;
  modelOverride?: string | null;
  /**
   * Where the role runs on the sidecar:
   *   'host'                — native Ollama via host.docker.internal:11434 (Mac primary)
   *   'docker-ollama'       — sidecar runs `ollama/ollama` container w/ GPU passthrough
   *   'docker-vllm'         — sidecar runs `vllm/vllm-openai` container (CUDA only)
   *   'docker-model-runner' — Docker Model Runner / vllm-metal (Mac primary for ss-rlm)
   * Backward-compat: rows pre-dating this field default to 'docker-ollama'
   * on linux/win32 and 'host' on darwin (resolved client-side).
   */
  runtime?: RuntimeChoice;
}

export type AssignmentRow = HostRoleAssignment;

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// ─── CRUD: HostRoleAssignment ───────────────────────────────────────────

export async function listAssignmentsForHost(
  sidecarUrl: string,
): Promise<AssignmentRow[]> {
  const url = normalizeUrl(sidecarUrl);
  return prisma.hostRoleAssignment.findMany({
    where: { sidecarUrl: url },
    orderBy: { mode: 'asc' },
  });
}

export async function listAllAssignments(): Promise<AssignmentRow[]> {
  return prisma.hostRoleAssignment.findMany();
}

export async function setAssignment(input: AssignmentInput): Promise<AssignmentRow> {
  if (!isModeName(input.mode)) {
    throw new Error(
      `Unknown mode "${input.mode}". Must be one of: ${ALL_MODES.join(', ')}`,
    );
  }
  const url = normalizeUrl(input.sidecarUrl);
  // Prisma rejects null for non-nullable Int columns (minOnline, idleTimeoutMin).
  // The UI sometimes sends those fields as null when the operator didn't touch
  // them — treat null AS undefined ("don't change") rather than passing it
  // through. modelOverride is nullable so null is meaningful there (= clear).
  //
  // Stale-row repair: rows created before the create-branch default fix
  // landed have minOnline=0 even when enabled. The UI's toggle/runtime edits
  // hit this update branch (not create), so the stale 0 never gets corrected.
  // When the caller is enabling the row AND didn't explicitly set minOnline,
  // bump 0 → 1 so the sidecar's HARD `minOnline=0` gate releases.
  const existing = await prisma.hostRoleAssignment.findUnique({
    where: { sidecarUrl_mode: { sidecarUrl: url, mode: input.mode } },
  });
  const isEnabledAfter = input.enabled != null ? input.enabled : existing?.enabled ?? true;
  const shouldRepairMinOnline =
    input.minOnline == null &&
    isEnabledAfter &&
    existing != null &&
    existing.minOnline === 0;

  return prisma.hostRoleAssignment.upsert({
    where: { sidecarUrl_mode: { sidecarUrl: url, mode: input.mode } },
    update: {
      ...(input.enabled != null ? { enabled: input.enabled } : {}),
      ...(input.minOnline != null
        ? { minOnline: input.minOnline }
        : shouldRepairMinOnline
        ? { minOnline: 1 }
        : {}),
      ...(input.idleTimeoutMin != null ? { idleTimeoutMin: input.idleTimeoutMin } : {}),
      ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
      ...(input.runtime != null ? { runtime: input.runtime } : {}),
    },
    create: {
      sidecarUrl: url,
      mode: input.mode,
      enabled: input.enabled ?? true,
      // Default minOnline by enabled-state:
      //   enabled=true  → 1 (auto-start: operator turned this role on so they
      //                  expect the sidecar to pull+load the model).
      //   enabled=false → 0 (operator opted out).
      // The sidecar treats `minOnline=0` as a HARD "never auto-start" policy
      // (handlers.ts:346, ws-client.ts:205) so defaulting newly-enabled rows
      // to 0 means clicking the checkbox in /admin/roleassign persists in the
      // DB but the sidecar refuses to act on the next /config push:
      //   handleAcquire → "Role X is disabled (minOnline=0)" → no ollamaPull,
      //   no container start, no model load. This was the BASWS34 / mcpserver
      //   regression observed 2026-05-12.
      minOnline:
        input.minOnline != null
          ? input.minOnline
          : (input.enabled ?? true)
          ? 1
          : 0,
      idleTimeoutMin: input.idleTimeoutMin ?? 5,
      modelOverride: input.modelOverride ?? null,
      runtime: input.runtime ?? 'docker-ollama',
    },
  });
}

export async function removeAssignment(sidecarUrl: string, mode: string): Promise<void> {
  const url = normalizeUrl(sidecarUrl);
  await prisma.hostRoleAssignment.deleteMany({
    where: { sidecarUrl: url, mode },
  });
}

// ─── Wire-format helpers used by fleet-router.pushModelRegistry ─────────

/** All enabled assignments for a host (drops `enabled:false` rows). */
export async function getEnabledAssignmentsForHost(
  sidecarUrl: string,
): Promise<AssignmentRow[]> {
  const rows = await listAssignmentsForHost(sidecarUrl);
  return rows.filter(r => r.enabled);
}

/** Just the enabled mode names — what we send to the sidecar. */
export async function getEnabledModesForHost(sidecarUrl: string): Promise<string[]> {
  const rows = await getEnabledAssignmentsForHost(sidecarUrl);
  return rows.map(r => r.mode);
}

/** Map of mode → modelOverride for enabled assignments (where set). */
export async function getModelOverridesForHost(
  sidecarUrl: string,
): Promise<Record<string, string>> {
  const rows = await getEnabledAssignmentsForHost(sidecarUrl);
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.modelOverride) out[r.mode] = r.modelOverride;
  }
  return out;
}

/**
 * Map of role-short-name → minOnline. Keys are the *short* names
 * (`embedding`, `completion`, `ocr`, `reranker`) because the sidecar's
 * internal state.minOnline is keyed by short name. fleet-router strips the
 * "ss-" prefix when building the wire payload.
 */
export async function getEffectiveMinOnline(
  sidecarUrl: string,
): Promise<Record<string, number>> {
  const rows = await getEnabledAssignmentsForHost(sidecarUrl);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.mode.replace(/^ss-/, '')] = r.minOnline;
  return out;
}

/** Map of role-short-name → idle timeout in ms. Same keying as above. */
export async function getEffectiveIdleTimeoutsMs(
  sidecarUrl: string,
): Promise<Record<string, number>> {
  const rows = await getEnabledAssignmentsForHost(sidecarUrl);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.mode.replace(/^ss-/, '')] = r.idleTimeoutMin * 60_000;
  return out;
}

const RUNTIME_VALUES: RuntimeChoice[] = ['host', 'docker-ollama', 'docker-vllm'];

export function isRuntimeChoice(s: unknown): s is RuntimeChoice {
  return typeof s === 'string' && (RUNTIME_VALUES as string[]).includes(s);
}

/**
 * Default runtime for a (mode, hostOs) pair when the DB row has no explicit
 * `runtime` set. Mirrors today's OS-derived behavior so unmigrated rows
 * push the same containers the master always pushed for that host.
 */
export function defaultRuntimeFor(
  mode: string,
  hostOs: 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | 'unknown',
): RuntimeChoice {
  if (mode === 'ss-reranker') {
    // Linux + windows-docker-wsl2 both run the vLLM reranker in Docker with
    // GPU passthrough. mac-docker-ollama has no supported reranker path; fall
    // back to 'host' so the UI shows "inherit" rather than auto-selecting
    // docker-vllm.
    return hostOs === 'linux' || hostOs === 'windows-docker-wsl2' ? 'docker-vllm' : 'host';
  }
  if (hostOs === 'linux' || hostOs === 'windows-docker-wsl2') return 'docker-ollama';
  return 'host';
}

/**
 * Map of mode → runtime for enabled assignments. Falls back to the OS
 * default when the DB row has runtime=null. Keyed by the FULL mode name
 * (`ss-embedding`, not `embedding`) — that's what the sidecar's config
 * handler keys runtimes by.
 */
export async function getRuntimesForHost(
  sidecarUrl: string,
  hostOs: 'linux' | 'mac-docker-ollama' | 'windows-docker-wsl2' | 'unknown',
): Promise<Record<string, RuntimeChoice>> {
  const rows = await getEnabledAssignmentsForHost(sidecarUrl);
  const out: Record<string, RuntimeChoice> = {};
  for (const r of rows) {
    out[r.mode] = isRuntimeChoice(r.runtime)
      ? r.runtime
      : defaultRuntimeFor(r.mode, hostOs);
  }
  return out;
}
