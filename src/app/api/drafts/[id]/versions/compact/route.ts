import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

/**
 * POST /api/drafts/[id]/versions/compact
 * Deletes all older versions, keeping only the latest (highest version number).
 * Returns the count of deleted versions.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: draftId } = await params;

  try {
    // Get the latest version
    const latest = await prisma.draftVersion.findFirst({
      where: { draftId },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    });

    if (!latest) {
      return NextResponse.json({ deleted: 0, message: 'No versions found' });
    }

    // Delete all versions except the latest
    const result = await prisma.draftVersion.deleteMany({
      where: {
        draftId,
        id: { not: latest.id },
      },
    });

    return NextResponse.json({
      deleted: result.count,
      kept: latest.version,
      message: `Deleted ${result.count} older version${result.count === 1 ? '' : 's'}, kept v${latest.version}`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Compact failed' },
      { status: 500 },
    );
  }
}
