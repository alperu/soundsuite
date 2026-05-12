import { NextResponse } from 'next/server';
import { getModeCatalog } from '@/lib/gpu/mode-catalog-server';

/**
 * GET /api/admin/mode-catalog
 *
 * Returns the fixed 4-mode catalog (ss-embedding, ss-completion, ss-ocr,
 * ss-reranker). Per-OS availability is baked in; the per-mode default
 * model is READ DYNAMICALLY from the Config DB (set by the existing admin
 * settings pages — /admin/embedding, /admin/localai, /admin/ocr,
 * /admin/reranking). The sidecar uses the model the master pushes via
 * `modelOverrides` to spin up the right container/model at runtime.
 */
export async function GET() {
  const modes = await getModeCatalog();
  return NextResponse.json({ modes });
}
