import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import * as fs from 'fs';

/**
 * GET /api/documents/[id]/page-image/[pageNum]?scale=1.5
 *
 * Renders a single PDF page as a JPEG image on the server.
 * Used as fallback when client-side rendering fails (JPEG2000, etc.)
 *
 * Returns JPEG with headers:
 * - Cache-Control: private, max-age=3600
 * - X-Page-Width / X-Page-Height: rendered dimensions
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; pageNum: string }> }
) {
  try {
    const { id, pageNum: pageNumStr } = await params;
    const pageNum = parseInt(pageNumStr, 10);

    if (isNaN(pageNum) || pageNum < 1) {
      return NextResponse.json({ error: 'Invalid page number' }, { status: 400 });
    }

    const scale = parseFloat(request.nextUrl.searchParams.get('scale') || '1.5');
    if (isNaN(scale) || scale < 0.1 || scale > 5) {
      return NextResponse.json({ error: 'Invalid scale (0.1-5)' }, { status: 400 });
    }

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

    // Render through the semaphore for PID-controlled concurrency
    const { withSemaphore } = await import('@/lib/render-semaphore');
    const { renderPage } = await import('@/lib/pdf-page-renderer');

    const result = await withSemaphore(() => renderPage(doc.filePath, pageNum, scale));

    // Warm adjacent pages into the renderer's LRU in the background so
    // next/prev navigation in the page viewer is near-instant. Fire-and-
    // forget; the render semaphore keeps concurrency bounded.
    for (const adj of [pageNum + 1, pageNum - 1, pageNum + 2]) {
      if (adj >= 1) {
        withSemaphore(() => renderPage(doc.filePath, adj, scale)).catch(() => {});
      }
    }

    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': result.buffer.length.toString(),
        // A render is immutable for a given (document, page, scale) — the
        // file on disk doesn't change under a stable document id. Cache
        // hard for a day; never cache failure placeholders.
        'Cache-Control': result.placeholder ? 'no-store' : 'private, max-age=86400, immutable',
        'X-Page-Width': result.width.toString(),
        'X-Page-Height': result.height.toString(),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to render page';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
