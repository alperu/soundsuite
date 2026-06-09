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

export async function GET() {
  const modes = await getModeCatalog();
  return NextResponse.json({
    modes,
    runtimes: ['host', 'docker-ollama', 'docker-vllm'],
    runtimeAvailability: RUNTIME_AVAILABILITY,
  });
}
