/**
 * GET  /api/draft/suggestions?draftId=...&status=pending — list suggestions (rehydration)
 * POST /api/draft/suggestions                              — batch insert (fallback / manual)
 * DELETE /api/draft/suggestions?draftId=...&status=stale   — cleanup
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import {
  detectConflicts,
  persistSuggestion,
  rowToDTO,
} from '@/lib/draft/suggestion-persist';
import {
  postSuggestionsBodySchema,
  SUGGESTION_STATUSES,
  type SuggestionStatus,
} from '@/lib/draft/suggestion-types';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const draftId = searchParams.get('draftId');
    const statusParam = searchParams.get('status');
    const sessionId = searchParams.get('sessionId');

    if (!draftId) {
      return NextResponse.json({ error: 'draftId is required' }, { status: 400 });
    }

    const where: Record<string, unknown> = { draftId };
    if (statusParam && SUGGESTION_STATUSES.includes(statusParam as SuggestionStatus)) {
      where.status = statusParam;
    }
    if (sessionId) where.sessionId = sessionId;

    const rows = await prisma.draftSuggestion.findMany({
      where,
      orderBy: [{ anchorFrom: 'asc' }, { createdAt: 'asc' }],
      take: 200,
    });

    const conflictMap = detectConflicts(rows);
    const suggestions = rows.map((row) =>
      rowToDTO(row, { conflictsWith: conflictMap.get(row.id) })
    );

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error('[GET /api/draft/suggestions]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list suggestions' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = postSuggestionsBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request body', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { draftId, sessionId, draftVersion, items } = parsed.data;

    // Load current document text so the anchors can be verified.
    const draft = await prisma.draft.findUnique({ where: { id: draftId } });
    if (!draft) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
    }

    // Strip TipTap JSON → plain text for anchor location.
    const documentText = draftJsonToPlainText(draft.content);

    const persisted = [];
    for (const raw of items) {
      const row = await persistSuggestion({
        draftId,
        sessionId,
        draftVersion,
        raw,
        documentText,
      });
      if (row) persisted.push(row);
    }

    const conflictMap = detectConflicts(persisted);
    const suggestions = persisted.map((row) =>
      rowToDTO(row, { conflictsWith: conflictMap.get(row.id) })
    );

    return NextResponse.json({ suggestions }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/draft/suggestions]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create suggestions' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const draftId = searchParams.get('draftId');
    const statusParam = searchParams.get('status');

    if (!draftId) {
      return NextResponse.json({ error: 'draftId is required' }, { status: 400 });
    }

    const where: Record<string, unknown> = { draftId };
    if (statusParam && SUGGESTION_STATUSES.includes(statusParam as SuggestionStatus)) {
      where.status = statusParam;
    }

    const result = await prisma.draftSuggestion.deleteMany({ where });
    return NextResponse.json({ deleted: result.count });
  } catch (error) {
    console.error('[DELETE /api/draft/suggestions]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete suggestions' },
      { status: 500 }
    );
  }
}

/**
 * Best-effort plain-text extraction from a TipTap JSON document string.
 * Walks the node tree and concatenates text nodes with newlines between blocks.
 */
function draftJsonToPlainText(contentJson: string): string {
  if (!contentJson) return '';
  try {
    const doc = JSON.parse(contentJson);
    const chunks: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (typeof n.text === 'string') {
        chunks.push(n.text);
      }
      if (Array.isArray(n.content)) {
        for (const child of n.content) walk(child);
        if (n.type && ['paragraph', 'heading', 'listItem', 'blockquote'].includes(n.type)) {
          chunks.push('\n');
        }
      }
    };
    walk(doc);
    return chunks.join('');
  } catch {
    return contentJson; // fall back to raw (may still work for plain-text drafts)
  }
}
