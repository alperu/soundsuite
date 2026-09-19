import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { loadScopeCases } from '@/lib/scope/scope-graph-data';

/**
 * GET /api/scope/graph
 *
 * The whole Haystack scope graph in one payload: cases → filings → documents,
 * with per-filing connectivity refs. At current corpus scale (single-digit
 * cases, low-hundreds of filings, high-hundreds of documents) this is a few
 * hundred KB, so there's no pagination — the block-view canvas wants the whole
 * structure anyway to compute cascade selection.
 *
 * Read-only. The loader lives in `@/lib/scope/scope-graph-data` so the
 * Haystack ops (`ssScopeGraph`, `ssWorklist`, `ssReadCase`) derive from the
 * same data this canvas renders — one definition of "connected".
 */
export async function GET() {
  try {
    const payload = await loadScopeCases(prisma);
    return NextResponse.json({ cases: payload });
  } catch (err) {
    console.error('[scope/graph] failed', err);
    return NextResponse.json(
      { error: { message: err instanceof Error ? err.message : 'Failed to build scope graph' } },
      { status: 500 },
    );
  }
}
