import { NextRequest, NextResponse } from 'next/server';
import { getModeCatalog } from '@/lib/gpu/mode-catalog-server';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import { isModeName, settingsPageForMode } from '@/lib/gpu/mode-catalog';
import { setConfigValue } from '@/lib/db/config';

/**
 * GET /api/admin/mode-catalog
 *
 * Returns the fixed 4-mode catalog (ss-embedding, ss-completion, ss-ocr,
 * ss-reranker). Per-OS availability is baked in; the per-mode default
 * model is READ DYNAMICALLY from the Config DB (set by the existing admin
 * settings pages — /admin/embedding, /admin/localai, /admin/ocr,
 * /admin/reranking). The sidecar uses the model the master pushes via
 * `modelOverrides` to spin up the right container/model at runtime.
 *
 * Also returns `runtimeAvailability` — a static per-runtime map of which
 * modes that runtime CAN serve (regardless of host capability). The UI
 * intersects this with per-host capability (Docker/GPU/host-helper status
 * pulled from the sidecar's /api/gpu) to grey out unsupported cells in
 * the 3-column runtime picker.
 *
 *   host         → all 3 Ollama-backed modes
 *   docker-ollama → all 3 Ollama-backed modes, GPU-required for OCR
 *   docker-vllm  → reranker only (CUDA only)
 */
const RUNTIME_AVAILABILITY: Record<string, string[]> = {
  host: ['ss-embedding', 'ss-code-embedding', 'ss-completion', 'ss-ocr'],
  'docker-ollama': ['ss-embedding', 'ss-code-embedding', 'ss-completion', 'ss-ocr'],
  'docker-vllm': ['ss-reranker'],
};

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'mode-catalog');
  if (denied) return denied;

  const modes = await getModeCatalog();
  return NextResponse.json({
    modes,
    runtimes: ['host', 'docker-ollama', 'docker-vllm'],
    runtimeAvailability: RUNTIME_AVAILABILITY,
  });
}

/**
 * POST /api/admin/mode-catalog — set a mode's default model from the
 * /admin/roletypes table, without inventing a second storage mechanism.
 *
 * This writes to the SAME Config key `settingsPageForMode(mode)` already
 * names as that mode's owning settings page (e.g. ss-rlm-sandbox →
 * `rlm.sandboxModel`, same key /admin/openrouter's picker writes). It is a
 * thin generic wrapper over `setConfigValue` — the existing primitive every
 * dedicated settings page already uses (see /api/openrouter/settings,
 * /api/config/pipeline, etc.) — not a parallel path. Per-HOST overrides
 * still live only in HostRoleAssignment via /admin/roleassign; this sets
 * the global default every host falls back to.
 */
export async function POST(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'mode-catalog');
  if (denied) return denied;

  try {
    const body = await request.json();
    const mode = typeof body?.mode === 'string' ? body.mode : '';
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!isModeName(mode)) {
      return NextResponse.json({ error: `Unknown mode "${mode}"` }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ error: 'model is required' }, { status: 400 });
    }
    const target = settingsPageForMode(mode);
    if (!target) {
      return NextResponse.json({ error: `No settings-page config key mapped for mode "${mode}"` }, { status: 400 });
    }
    await setConfigValue(target.configKey, model);

    // Best-effort: push the new default to every connected sidecar so an
    // operator doesn't have to wait for the next reconnect. Mirrors
    // /api/openrouter/settings's push — failure here must not fail the save.
    let pushed = 0;
    try {
      const { getFleetStatus, pushModelRegistry } = await import('@/lib/gpu/fleet-router');
      const fleet = await getFleetStatus();
      for (const sidecar of fleet.sidecars) {
        pushed++;
        pushModelRegistry(sidecar.url).catch(() => {});
      }
    } catch {
      // Orchestration unavailable — the Config write above still succeeded.
    }

    return NextResponse.json({ success: true, mode, configKey: target.configKey, pushedToSidecars: pushed });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to update mode default model';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
