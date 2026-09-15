/**
 * GET /api/openrouter/credits — remaining balance + today's per-role spend.
 *
 * `getCredits()` throws `OpenRouterError(401, 'auth')` when no key is
 * configured yet — that is the normal pre-setup state, not a server error,
 * so it is rendered as `{ configured: false }` (200) rather than a 500 that
 * would look scary on a fresh install.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCredits, getSpendToday, OpenRouterError } from '@/lib/openrouter/client';
import { requireAdminApiAccess } from '@/lib/api/route-guard';

export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'openrouter/credits');
  if (denied) return denied;

  const spendToday = {
    embedding: getSpendToday('embedding'),
    reranker: getSpendToday('reranker'),
    completion: getSpendToday('completion'),
    total: getSpendToday(),
  };

  try {
    const credits = await getCredits();
    return NextResponse.json({ configured: true, credits, spendToday });
  } catch (error) {
    if (error instanceof OpenRouterError && error.kind === 'auth') {
      return NextResponse.json({ configured: false, credits: null, spendToday });
    }
    const msg = error instanceof Error ? error.message : 'Failed to load OpenRouter credits';
    return NextResponse.json({ configured: true, credits: null, spendToday, error: msg }, { status: 502 });
  }
}
