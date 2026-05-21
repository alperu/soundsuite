import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getServicesManager } from '@/lib/services-manager';
import { commitEntity } from '../../haystack/[op]/route';

/**
 * PATCH /api/cases/[id] - Update case information
 *
 * @deprecated Prefer `PUT /api/haystack-proxy/commit` with
 * `{ id, kind: 'case', patch: {...} }`. This endpoint is a thin shim that
 * forwards to the unified Haystack commit code path so both legacy and
 * Haystack writes share a single source of truth.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    // Whitelist of legacy fields the dialog sends. Everything else is
    // ignored to keep the deprecated surface minimal.
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'caseNumber', 'jurisdiction', 'county', 'state', 'country', 'path'] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const result = await commitEntity({ id, kind: 'case', patch });
    if (!result.ok) {
      // Parse out the err message from the grid for legacy JSON shape.
      let msg = 'Failed to update case';
      try {
        const g = JSON.parse(result.errGridJson);
        msg = String(g?.meta?.dis ?? msg);
      } catch { /* ignore */ }
      // Detect not-found vs validation
      const status = /not found/i.test(msg) ? 404 : 400;
      return NextResponse.json({ error: msg }, { status });
    }

    // Return the column shape callers expect (no tags inlined). The row
    // from commitEntity has tags merged in; pluck the original columns.
    const r = result.row;
    return NextResponse.json({
      case: {
        id: r.id,
        name: r.name,
        path: r.path,
        caseNumber: r.caseNumber,
        jurisdiction: r.jurisdiction,
        country: r.country,
        state: r.state,
        county: r.county,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update case' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/cases/[id] - Delete a case and all associated data
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    // Cascade delete removes documents automatically (onDelete: Cascade)
    await prisma.case.delete({ where: { id } });

    // Notify FileWatcher to stop watching the deleted case path
    const fileWatcher = getServicesManager().getFileWatcher();
    if (fileWatcher) {
      await fileWatcher.removePath(caseRecord.path);
    }

    return NextResponse.json({ success: true, deletedCase: caseRecord.name });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete case' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/cases/[id] - Get a single case with documents
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const caseRecord = await prisma.case.findUnique({
      where: { id },
      include: {
        documents: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    return NextResponse.json({ case: caseRecord });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get case' },
      { status: 500 }
    );
  }
}
