import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import * as fs from 'fs';

/**
 * GET /api/documents/[id]/page-metadata
 *
 * Returns page dimensions and count without rendering.
 * Used by the client for placeholder sizing before pages load.
 *
 * Response: { numPages, width, height }
 * width/height are page 1 dimensions at scale=1.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const doc = await prisma.document.findUnique({
      where: { id },
      select: { filePath: true },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    if (!fs.existsSync(doc.filePath)) {
      return NextResponse.json({ error: 'PDF file not found on disk' }, { status: 404 });
    }

    const { getDocumentInfo } = await import('@/lib/pdf-page-renderer');
    const info = await getDocumentInfo(doc.filePath);

    return NextResponse.json({
      numPages: info.numPages,
      width: info.defaultWidth,
      height: info.defaultHeight,
    }, {
      headers: { 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get page metadata' },
      { status: 500 }
    );
  }
}
