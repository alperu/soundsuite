/**
 * GET /api/openrouter/workers — live stats of the OpenRouter worker pool
 * (src/lib/openrouter/worker-pool.ts): bulk and interactive lanes (running,
 * queued, limit), done / failed / 429 counts, current bulk limit, and the
 * event-loop lag p95. In-memory only, cheap to poll. The Workers setting
 * itself is saved through /api/openrouter/settings.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import { getConfig } from '@/lib/db/config';
import { openRouterPool } from '@/lib/openrouter/worker-pool';

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/workers');
  if (denied) return denied;

  const pool = openRouterPool();
  try {
    // Show the saved value even before the first OpenRouter call applied it.
    const cfg = await getConfig();
    pool.setWorkerCount(cfg.openRouterWorkers);
  } catch {
    // Config unreadable: stats still describe the running pool.
  }
  return NextResponse.json(pool.stats());
}
