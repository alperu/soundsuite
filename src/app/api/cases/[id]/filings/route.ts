import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { FilingsCacheService } from '@/services/filings-cache';
import { publishFilingEvent } from '@/lib/sse-events';

const filingsCache = new FilingsCacheService();

function slugify(filingType: string, title: string): string {
  const raw = `${filingType}-${title}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * GET /api/cases/[id]/filings — list all filings for a case with documents.
 * Reads from Redis cache first, falls back to database.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Try cache first
    const cached = await filingsCache.getCaseFilings(id);
    if (cached) {
      return NextResponse.json(
        { filings: cached },
        { headers: { 'X-Cache': 'HIT' } }
      );
    }

    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    const filings = await prisma.filing.findMany({
      where: { caseId: id },
      include: {
        documents: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Populate cache asynchronously (don't block response)
    filingsCache.setCaseFilings(id, filings).catch(() => {});

    return NextResponse.json(
      { filings },
      { headers: { 'X-Cache': 'MISS' } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list filings' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/cases/[id]/filings — create a new filing.
 * Invalidates cache after creation.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { filingType, title, filingDate, description, volumeNumber, isSupplemental, supplementalOrder } = body;

    if (!filingType || !title) {
      return NextResponse.json(
        { error: 'filingType and title are required' },
        { status: 400 }
      );
    }

    const caseRecord = await prisma.case.findUnique({ where: { id } });
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }

    // Generate slug, ensure uniqueness within the case
    let slug = slugify(filingType, title);
    const existing = await prisma.filing.findUnique({
      where: { caseId_slug: { caseId: id, slug } },
    });
    if (existing) {
      // Append a counter
      let counter = 2;
      while (await prisma.filing.findUnique({
        where: { caseId_slug: { caseId: id, slug: `${slug}-${counter}` } },
      })) {
        counter++;
      }
      slug = `${slug}-${counter}`;
    }

    const filing = await prisma.filing.create({
      data: {
        caseId: id,
        filingType,
        title,
        slug,
        filingDate: filingDate ? new Date(filingDate) : null,
        description: description || null,
        volumeNumber: typeof volumeNumber === 'number' ? volumeNumber : null,
        isSupplemental: isSupplemental === true,
        supplementalOrder: typeof supplementalOrder === 'number' ? supplementalOrder : null,
      },
    });

    // Invalidate cache after creating a new filing
    await filingsCache.invalidateCaseFilings(id);

    // Publish SSE event for real-time sidebar updates
    publishFilingEvent({
      type: 'filing_created',
      caseId: id,
      filingId: filing.id,
      filingType: filing.filingType,
      title: filing.title,
      slug: filing.slug,
    }).catch(() => {});

    return NextResponse.json({ filing }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create filing' },
      { status: 500 }
    );
  }
}
