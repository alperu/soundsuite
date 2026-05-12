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

export const ALL_MODES = ['ss-embedding', 'ss-completion', 'ss-ocr', 'ss-reranker'] as const;
export type ModeName = (typeof ALL_MODES)[number];

export interface ModeCatalogEntry {
  name: ModeName;
  label: string;
  availableOn: Array<'linux' | 'darwin' | 'win32'>;
  defaultModel: Partial<Record<'linux' | 'darwin' | 'win32', string>>;
  description: string;
}

export const MODE_CATALOG: ModeCatalogEntry[] = [
  {
    name: 'ss-embedding',
    label: 'Embedding',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {
      linux: 'qwen3-embedding:0.6b',
      darwin: 'qwen3-embedding:0.6b',
      win32: 'qwen3-embedding:0.6b',
    },
    description:
      'Document and query embedding via Ollama. Lightweight (~1.2 GB VRAM); used in both indexing and search.',
  },
  {
    name: 'ss-completion',
    label: 'Completion',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {
      linux: 'qwen3.5:9b',
      darwin: 'qwen3.5:9b',
      win32: 'qwen3.5:9b',
    },
    description: 'Chat completion via Ollama. ~10 GB VRAM; used at search time.',
  },
  {
    name: 'ss-ocr',
    label: 'OCR',
    availableOn: ['linux', 'darwin', 'win32'],
    defaultModel: {
      linux: 'richardyoung/olmocr2:7b-q8',
      darwin: 'richardyoung/olmocr2:7b-q8',
      win32: 'richardyoung/olmocr2:7b-q8',
    },
    description:
      'Visual OCR for low-density PDF pages. ~8 GB VRAM; used during indexing only.',
  },
  {
    name: 'ss-reranker',
    label: 'Reranker (cross-encoder)',
    availableOn: ['linux'],
    defaultModel: { linux: 'Qwen/Qwen3-Reranker-8B' },
    description:
      'vLLM cross-encoder reranker. Currently linux-only — vllm-metal lacks cross-encoder support (see vllm-metal#361).',
  },
];

export function isModeName(s: string): s is ModeName {
  return (ALL_MODES as readonly string[]).includes(s);
}

export interface AssignmentInput {
  sidecarUrl: string;
  mode: string;
  enabled?: boolean;
  minOnline?: number;
  idleTimeoutMin?: number;
  modelOverride?: string | null;
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
  return prisma.hostRoleAssignment.upsert({
    where: { sidecarUrl_mode: { sidecarUrl: url, mode: input.mode } },
    update: {
      ...(input.enabled != null ? { enabled: input.enabled } : {}),
      ...(input.minOnline != null ? { minOnline: input.minOnline } : {}),
      ...(input.idleTimeoutMin != null ? { idleTimeoutMin: input.idleTimeoutMin } : {}),
      ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
    },
    create: {
      sidecarUrl: url,
      mode: input.mode,
      enabled: input.enabled ?? true,
      minOnline: input.minOnline ?? 0,
      idleTimeoutMin: input.idleTimeoutMin ?? 5,
      modelOverride: input.modelOverride ?? null,
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
