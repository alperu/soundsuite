import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getServicesManager } from '@/lib/services-manager';

/**
 * PATCH /api/cases/[id] - Update case information
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    const data: Record<string, string> = {};
    if (body.name !== undefined) data.name = body.name.trim();
    if (body.caseNumber !== undefined) data.caseNumber = body.caseNumber.trim() || null as unknown as string;
    if (body.jurisdiction !== undefined) data.jurisdiction = body.jurisdiction.trim() || null as unknown as string;
    if (body.county !== undefined) data.county = body.county.trim() || null as unknown as string;
    if (body.state !== undefined) data.state = body.state.trim() || null as unknown as string;
    if (body.country !== undefined) data.country = body.country.trim() || null as unknown as string;
    if (body.path !== undefined) {
      // Validate new path exists
      const fs = await import('fs/promises');
      try {
        const stat = await fs.stat(body.path.trim());
        if (!stat.isDirectory()) {
          return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
        }
      } catch {
        return NextResponse.json({ error: 'Path does not exist' }, { status: 400 });
      }
      data.path = body.path.trim();
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const updated = await prisma.case.update({ where: { id }, data });

    // If path changed, update file watcher
    if (data.path && data.path !== caseRecord.path) {
      const fileWatcher = getServicesManager().getFileWatcher();
      if (fileWatcher) {
        await fileWatcher.removePath(caseRecord.path);
        await fileWatcher.addPath(data.path);
      }
    }

    return NextResponse.json({ case: updated });
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
