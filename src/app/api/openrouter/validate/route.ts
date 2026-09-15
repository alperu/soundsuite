/**
 * POST /api/openrouter/validate — availability check for curated
 * embedding/rerank/chat model ids.
 *
 * Delegates to `validateModel()` (`src/lib/openrouter/client.ts`), which
 * probes `GET /models/{id}/endpoints`. That endpoint needs no API key and
 * costs nothing, and it is the ONLY correct way to check embedding/rerank
 * availability — `/api/v1/models` does not list them at all. `available:
 * false, reason: 'no-providers'` means "listed but nobody serves it right
 * now" (transient), not a config error — the caller renders it as such.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateModel } from '@/lib/openrouter/client';
import { allCuratedModelIds } from '@/lib/openrouter/models';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

/** Bound the fan-out — the curated set is ~15 ids; anything bigger is misuse. */
const MAX_IDS = 50;

export async function POST(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/validate');
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => ({}));
    let ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x) => typeof x === 'string') as string[] : undefined;

    // No ids given: validate every curated id (embedding + rerank + chat).
    if (!ids || ids.length === 0) {
      ids = allCuratedModelIds();
    }

    if (ids.length > MAX_IDS) {
      return NextResponse.json({ error: `Too many ids (max ${MAX_IDS})` }, { status: 400 });
    }

    const results = await Promise.all(ids.map((id) => validateModel(id)));
    return NextResponse.json({ results });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to validate models';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
