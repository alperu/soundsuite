import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { publishFilingEvent } from '@/lib/sse-events';
import { FilingsCacheService } from '@/services/filings-cache';
import { VectorStore } from '@/lib/vector/vector-store';

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
 * Move a filing to another case, carrying everything that hangs off it.
 *
 * `Filing.caseId` is only one of several places a filing's case is recorded.
 * The XETO entity rows (Motion / MotionAttachment / ClerksRecord /
 * ReportersRecord) each denormalize `caseId`, and so do the filing's
 * Documents. The `ensure*ForFiling` helpers copy `Filing.caseId` at row
 * CREATE only and never revisit it, so nothing repairs these afterwards: move
 * the Filing alone and the entity rows keep pointing at the old case forever,
 * silently. Hence one server-side cascade rather than the client orchestrating
 * several write families.
 *
 * Everything runs in a transaction so a filing can never end up half-moved.
 *
 * Scope note: only documents ATTACHED to this filing move. Documents that
 * belong to the case but no filing are the case's, not this filing's, and
 * stay put.
 */
async function moveFilingToCase(
  filingId: string,
  targetCaseId: string,
  updateData: Record<string, unknown>,
) {
  return prisma.$transaction(async (tx) => {
    const filing = await tx.filing.update({ where: { id: filingId }, data: updateData });

    // Entity rows adopt `entity.id === Filing.id`. Motion is matched on its
    // `filingId` FK too: a shadow Motion materialized for an attachment-kind
    // filing shares the id, but matching both is what keeps this correct if
    // that convention is ever relaxed.
    const motions = await tx.motion.findMany({
      where: { OR: [{ id: filingId }, { filingId }] },
      select: { id: true },
    });
    const motionIds = motions.map((m) => m.id);
    if (motionIds.length > 0) {
      await tx.motion.updateMany({
        where: { id: { in: motionIds } },
        data: { caseId: targetCaseId },
      });
      // MotionEvents hang off `motionId`, not off the filing id, so they are
      // invisible to an entityKinds-based sweep. Zero rows in the corpus
      // today; handled here so the first one written doesn't diverge.
      await tx.motionEvent.updateMany({
        where: { motionId: { in: motionIds } },
        data: { caseId: targetCaseId },
      });
    }

    await tx.motionAttachment.updateMany({ where: { id: filingId }, data: { caseId: targetCaseId } });
    await tx.clerksRecord.updateMany({ where: { id: filingId }, data: { caseId: targetCaseId } });
    await tx.reportersRecord.updateMany({ where: { id: filingId }, data: { caseId: targetCaseId } });

    // Documents move with the filing. Only the INDEXED ones have chunks, and
    // only their ids come back — an unindexed document has nothing to re-stamp
    // in the vector store, so including it would just widen the IN-list.
    const indexed = await tx.document.findMany({
      where: { filingId, status: 'INDEXED' },
      select: { id: true },
    });
    await tx.document.updateMany({ where: { filingId }, data: { caseId: targetCaseId } });

    return { filing, documentIds: indexed.map((d) => d.id) };
  });
}

/**
 * Re-stamp the moved documents' chunks with the destination case.
 *
 * LanceDB cannot join the SQL transaction, so this necessarily runs after the
 * move has committed. Between the commit and this call the two stores disagree:
 * SQL says the filing is in the new case while chunks still carry the old
 * `case_id` / `case_number`, so case-scoped search misattributes those chunks.
 * The window is milliseconds in the normal path and unbounded if this throws —
 * which is why a failure is logged loudly with the ids needed to repair it by
 * hand, rather than swallowed.
 *
 * A vector-store failure never fails the move — the SQL half is already
 * durable, so the outcome is REPORTED (`chunkRestamp` in the response) rather
 * than thrown. Awaited so that report can be truthful: 'ok' and 'failed' are
 * not knowable without waiting for the answer. A retry queue is the obvious v2.
 */
async function restampChunkCase(
  documentIds: string[],
  targetCaseId: string,
  filingId: string,
): Promise<'ok' | 'failed' | 'skipped'> {
  // Nothing indexed under this filing — no chunks exist to carry.
  if (documentIds.length === 0) return 'skipped';
  try {
    const target = await prisma.case.findUnique({
      where: { id: targetCaseId },
      select: { caseNumber: true },
    });
    const vectorStore = new VectorStore({
      dbPath: process.env.LANCEDB_PATH || './data/lancedb',
      tableName: 'chunks',
    });
    await vectorStore.initialize();
    const stamped = await vectorStore.stampCaseAssignment(
      documentIds,
      targetCaseId,
      target?.caseNumber || '',
    );
    console.log(
      `[filing-move] chunk restamp ok for ${stamped} docs filing=${filingId} case=${targetCaseId}`,
    );
    return 'ok';
  } catch (error) {
    // The SQL move is already committed, so this is a divergence between the
    // two stores, not a failed operation: the ids are what an operator needs
    // to repair it. First line is kept greppable.
    console.error(
      `[filing-move] chunk restamp failed for ${documentIds.length} docs ` +
        `filing=${filingId} case=${targetCaseId}: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `  documents=[${documentIds.join(',')}]\n` +
        `  SQL move already committed; case-scoped search misattributes these chunks until they are re-stamped or re-indexed.`,
    );
    return 'failed';
  }
}

/**
 * PATCH /api/cases/[id]/filings/[filingId] — update a filing
 * Body: { title?, filingType?, filingDate?, description?, caseId? }
 *
 * Passing a different `caseId` MOVES the filing: see `moveFilingToCase` for
 * what travels with it.
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
    if (body.isSupplemental !== undefined) updateData.isSupplemental = body.isSupplemental === true;
    if (body.supplementalOrder !== undefined) updateData.supplementalOrder = typeof body.supplementalOrder === 'number' ? body.supplementalOrder : null;
    // Moving the filing to another case. Everything that hangs off this filing
    // has to follow — see the cascade below.
    let targetCaseId: string | null = null;
    if (body.caseId && typeof body.caseId === 'string' && body.caseId !== filing.caseId) {
      const target = await prisma.case.findUnique({ where: { id: body.caseId }, select: { id: true } });
      if (!target) {
        return NextResponse.json({ error: 'Target case not found' }, { status: 400 });
      }
      targetCaseId = target.id;
      updateData.caseId = targetCaseId;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    // Regenerate the slug when the title or type changed — and ALWAYS on a
    // move, because `@@unique([caseId, slug])` scopes uniqueness per case: a
    // slug that was free here can already be taken in the target case, and the
    // move would fail on the constraint. Uniqueness is checked against the
    // case the filing is landing in, not the one it is leaving.
    const slugCaseId = targetCaseId ?? id;
    if (updateData.title || updateData.filingType || targetCaseId) {
      const newType = (updateData.filingType as string) || filing.filingType;
      const newTitle = (updateData.title as string) || filing.title;
      const raw = `${newType}-${newTitle}`;
      let slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      // Ensure uniqueness
      const existing = await prisma.filing.findFirst({
        where: { caseId: slugCaseId, slug, id: { not: filingId } },
      });
      if (existing) {
        let counter = 2;
        while (await prisma.filing.findFirst({
          where: { caseId: slugCaseId, slug: `${slug}-${counter}`, id: { not: filingId } },
        })) counter++;
        slug = `${slug}-${counter}`;
      }
      updateData.slug = slug;
    }

    let updated;
    let chunkRestamp: 'ok' | 'failed' | 'skipped' | undefined;
    if (targetCaseId) {
      const move = await moveFilingToCase(filingId, targetCaseId, updateData);
      updated = move.filing;
      // Awaited so the response can state what actually happened. It never
      // throws and never undoes the move — a vector-store outage downgrades
      // the result to 'failed' and leaves a greppable log line, rather than
      // failing a request whose SQL half is already durable.
      chunkRestamp = await restampChunkCase(move.documentIds, targetCaseId, filingId);
    } else {
      updated = await prisma.filing.update({ where: { id: filingId }, data: updateData });
    }

    // Invalidate Redis cache — both sides of a move, or the filing lingers in
    // the source case's cached list and is missing from the destination's.
    const filingsCache = new FilingsCacheService();
    await filingsCache.invalidateCaseFilings(id);
    if (targetCaseId) await filingsCache.invalidateCaseFilings(targetCaseId);

    // Publish SSE event for real-time sidebar updates. A move announces to
    // both sidebars for the same reason.
    publishFilingEvent({
      type: 'filing_updated',
      caseId: id,
      filingId,
      filingType: updated.filingType,
      title: updated.title,
      slug: updated.slug,
    }).catch(() => {});
    if (targetCaseId) {
      publishFilingEvent({
        type: 'filing_updated',
        caseId: targetCaseId,
        filingId,
        filingType: updated.filingType,
        title: updated.title,
        slug: updated.slug,
      }).catch(() => {});
    }

    return NextResponse.json({
      filing: updated,
      moved: targetCaseId ? { from: id, to: targetCaseId } : undefined,
      // 'skipped' = the filing had no INDEXED documents, so there were no
      // chunks to carry. 'failed' = the move stands but the vector store still
      // has the old case on those chunks; see the logged document ids.
      chunkRestamp,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update filing' },
      { status: 500 }
    );
  }
}

