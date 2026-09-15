/**
 * GET /api/openrouter/activity — live per-role activity for the admin panel's
 * top-of-page "is it working?" section (in-flight calls, calls/tokens today,
 * spend today, last call incl. master-direct vs sidecar attribution).
 *
 * Deliberately separate from `/api/openrouter/credits`: that route makes a
 * network call to OpenRouter's `/credits` endpoint (slow-ish, rate-limit
 * sensitive) and is refreshed on a "Refresh" button click. This route reads
 * only in-memory counters (`src/lib/openrouter/client.ts`) and is meant to be
 * polled every few seconds — mixing the two would mean every poll also hits
 * OpenRouter for a number nobody asked to refresh that often.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getActivity, type RoleActivity } from '@/lib/openrouter/client';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

/** The four roles the panel breaks activity down by. `code-embedding` is
 *  distinct from `embedding` — see all-sources-embedding-provider.ts's header
 *  on why the two run different local models at different widths. */
const ROLES = ['embedding', 'code-embedding', 'completion', 'reranker'] as const;

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/activity');
  if (denied) return denied;

  const byRole: Record<string, RoleActivity> = {};
  for (const role of ROLES) byRole[role] = getActivity(role);

  return NextResponse.json({ byRole });
}
