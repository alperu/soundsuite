/**
 * PATCH /api/draft/suggestions/[id] — transition suggestion status and trigger the learning loop.
 * DELETE /api/draft/suggestions/[id] — permanently remove a single suggestion.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { patchSuggestionBodySchema, type DenyReasonTagSlug } from '@/lib/draft/suggestion-types';
import { rowToDTO } from '@/lib/draft/suggestion-persist';
import { derivePreferenceSignal, type Decision } from '@/lib/draft/preferences';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = patchSuggestionBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { status, denyReasonTags, denyReasonText } = parsed.data;

    const existing = await prisma.draftSuggestion.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
    }

    const isTerminal = status === 'accepted' || status === 'denied' || status === 'ignored';

    const updated = await prisma.draftSuggestion.update({
      where: { id },
      data: {
        status,
        denyReasonTags: denyReasonTags !== undefined ? JSON.stringify(denyReasonTags) : undefined,
        denyReasonText: denyReasonText !== undefined ? denyReasonText : undefined,
        resolvedAt: isTerminal ? new Date() : status === 'pending' ? null : undefined,
      },
    });

    // Fire-and-forget preference derivation for terminal transitions. Errors here
    // should not fail the request — the suggestion state is already updated.
    if (status === 'accepted' || status === 'denied' || status === 'ignored') {
      const draftRecord = await prisma.draft.findUnique({
        where: { id: updated.draftId },
        select: { caseId: true, documentType: true },
      });

      try {
        await derivePreferenceSignal({
          suggestion: {
            draftId: updated.draftId,
            category: updated.category as never,
            originalText: updated.originalText,
            proposedText: updated.proposedText,
            reason: updated.reason,
            denyReasonTags: (() => {
              try {
                const t = JSON.parse(updated.denyReasonTags);
                return Array.isArray(t) ? (t as DenyReasonTagSlug[]) : [];
              } catch {
                return [];
              }
            })(),
            caseId: draftRecord?.caseId,
            documentType: draftRecord?.documentType,
          },
          decision: status as Decision,
        });
      } catch (e) {
        console.warn('[derivePreferenceSignal] failed', e);
      }
    }

    return NextResponse.json({ suggestion: rowToDTO(updated) });
  } catch (error) {
    console.error('[PATCH /api/draft/suggestions/[id]]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update suggestion' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prisma.draftSuggestion.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/draft/suggestions/[id]]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete suggestion' },
      { status: 500 }
    );
  }
}
