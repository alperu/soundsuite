import { NextResponse } from 'next/server';
import { MODE_CATALOG } from '@/lib/db/role-registry';

/**
 * GET /api/admin/mode-catalog
 *
 * Returns the fixed 4-mode catalog (ss-embedding, ss-completion, ss-ocr,
 * ss-reranker). Per-OS availability and default model are baked in — the
 * sidecar uses these to resolve the underlying image/port/VRAM at runtime.
 */
export async function GET() {
  return NextResponse.json({ modes: MODE_CATALOG });
}
