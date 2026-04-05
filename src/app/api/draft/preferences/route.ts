/**
 * DELETE /api/draft/preferences?draftId=...&scope=draft|case
 * Clears learned UserPreferenceSignal rows for privacy control.
 *
 * POST /api/draft/preferences?draftId=...&caseId=...
 * Body: { action: 'promote-to-case' }
 * Promotes all draftId-scoped signals to caseId scope (used by the
 * "Share learned preferences across this case" toggle).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  clearLearnedPreferencesForDraft,
  clearLearnedPreferencesForCase,
  promoteDraftSignalsToCase,
} from '@/lib/draft/preferences';

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const draftId = searchParams.get('draftId');
    const caseId = searchParams.get('caseId');
    const scope = searchParams.get('scope') || 'draft';

    if (scope === 'case') {
      if (!caseId) {
        return NextResponse.json({ error: 'caseId is required for scope=case' }, { status: 400 });
      }
      const deleted = await clearLearnedPreferencesForCase(caseId);
      return NextResponse.json({ deleted });
    }

    if (!draftId) {
      return NextResponse.json({ error: 'draftId is required' }, { status: 400 });
    }
    const deleted = await clearLearnedPreferencesForDraft(draftId);
    return NextResponse.json({ deleted });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear preferences' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const draftId = searchParams.get('draftId');
    const caseId = searchParams.get('caseId');
    const body = await request.json().catch(() => ({}));
    const action = body?.action as string | undefined;

    if (action !== 'promote-to-case') {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    }
    if (!draftId || !caseId) {
      return NextResponse.json({ error: 'draftId and caseId are required' }, { status: 400 });
    }
    const promoted = await promoteDraftSignalsToCase(draftId, caseId);
    return NextResponse.json({ promoted });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to promote preferences' },
      { status: 500 }
    );
  }
}
