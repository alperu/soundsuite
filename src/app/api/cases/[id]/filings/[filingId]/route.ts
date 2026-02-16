import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { publishFilingEvent } from '@/lib/sse-events';
import { FilingsCacheService } from '@/services/filings-cache';

/**
 * GET /api/cases/[id]/filings/[filingId] — get a single filing with documents
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; filingId: string }> }
) {
  try {
    const { id, filingId } = await params;

    const filing = await prisma.filing.findFirst({
      where: { id: filingId, caseId: id },
      include: {
        documents: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!filing) {
      return NextResponse.json({ error: 'Filing not found' }, { status: 404 });
    }

    return NextResponse.json({ filing });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get filing' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/cases/[id]/filings/[filingId] — delete a filing
 * Documents become unassigned (filingId set to null), not deleted.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; filingId: string }> }
) {
  try {
    const { id, filingId } = await params;

    const filing = await prisma.filing.findFirst({
      where: { id: filingId, caseId: id },
    });

    if (!filing) {
      return NextResponse.json({ error: 'Filing not found' }, { status: 404 });
    }

    // Unassign documents from this filing (don't delete them)
    await prisma.document.updateMany({
      where: { filingId },
      data: { filingId: null, exhibitLabel: null },
    });

    await prisma.filing.delete({ where: { id: filingId } });

    // Invalidate Redis cache so stale filings aren't served
    const filingsCache = new FilingsCacheService();
    await filingsCache.invalidateCaseFilings(id);

    // Publish SSE event for real-time sidebar updates
    publishFilingEvent({
      type: 'filing_deleted',
      caseId: id,
      filingId,
      title: filing.title,
      filingType: filing.filingType,
    }).catch(() => {});

    return NextResponse.json({ success: true, deletedFiling: filing.title });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete filing' },
      { status: 500 }
    );
  }
}
/**
 * PATCH /api/cases/[id]/filings/[filingId] — update a filing
 * Body: { title?: string, filingType?: string, filingDate?: string | null, description?: string | null }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; filingId: string }> }
) {
  try {
    const { id, filingId } = await params;
    const body = await request.json();

    const filing = await prisma.filing.findFirst({
      where: { id: filingId, caseId: id },
    });
    if (!filing) {
      return NextResponse.json({ error: 'Filing not found' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (body.title && typeof body.title === 'string') updateData.title = body.title.trim();
    if (body.filingType && typeof body.filingType === 'string') updateData.filingType = body.filingType;
    if (body.filingDate !== undefined) updateData.filingDate = body.filingDate ? new Date(body.filingDate) : null;
    if (body.description !== undefined) updateData.description = body.description || null;
    if (body.volumeNumber !== undefined) updateData.volumeNumber = typeof body.volumeNumber === 'number' ? body.volumeNumber : null;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    // Regenerate slug if title or filingType changed
    if (updateData.title || updateData.filingType) {
      const newType = (updateData.filingType as string) || filing.filingType;
      const newTitle = (updateData.title as string) || filing.title;
      const raw = `${newType}-${newTitle}`;
      let slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      // Ensure uniqueness
      const existing = await prisma.filing.findFirst({
        where: { caseId: id, slug, id: { not: filingId } },
      });
      if (existing) {
        let counter = 2;
        while (await prisma.filing.findFirst({
          where: { caseId: id, slug: `${slug}-${counter}`, id: { not: filingId } },
        })) counter++;
        slug = `${slug}-${counter}`;
      }
      updateData.slug = slug;
    }

    const updated = await prisma.filing.update({
      where: { id: filingId },
      data: updateData,
    });

    // Invalidate Redis cache
    const filingsCache = new FilingsCacheService();
    await filingsCache.invalidateCaseFilings(id);

    // Publish SSE event for real-time sidebar updates
    publishFilingEvent({
      type: 'filing_updated',
      caseId: id,
      filingId,
      filingType: updated.filingType,
      title: updated.title,
      slug: updated.slug,
    }).catch(() => {});

    return NextResponse.json({ filing: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update filing' },
      { status: 500 }
    );
  }
}

