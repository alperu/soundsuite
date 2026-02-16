import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

/**
 * Generate the next exhibit label for a filing.
 * Returns "Exhibit A", "Exhibit B", ..., "Exhibit Z", "Exhibit AA", etc.
 */
async function nextExhibitLabel(filingId: string): Promise<string> {
  const existing = await prisma.document.findMany({
    where: { filingId, exhibitLabel: { not: null } },
    select: { exhibitLabel: true },
    orderBy: { exhibitLabel: 'asc' },
  });

  const usedLetters = new Set(
    existing
      .map(d => d.exhibitLabel?.replace('Exhibit ', '') || '')
      .filter(Boolean)
  );

  // Generate A-Z, then AA, AB, etc.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const letter of alphabet) {
    if (!usedLetters.has(letter)) return `Exhibit ${letter}`;
  }
  // Overflow: AA, AB, ...
  for (const first of alphabet) {
    for (const second of alphabet) {
      const combo = `${first}${second}`;
      if (!usedLetters.has(combo)) return `Exhibit ${combo}`;
    }
  }
  return `Exhibit ${existing.length + 1}`;
}

/**
 * POST /api/documents/[id]/exhibit — attach a document to a filing as an exhibit
 * Body: { filingId: string, exhibitLabel?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { filingId, exhibitLabel } = body;

    if (!filingId) {
      return NextResponse.json({ error: 'filingId is required' }, { status: 400 });
    }

    const doc = await prisma.document.findUnique({ where: { id } });
    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const filing = await prisma.filing.findUnique({ where: { id: filingId } });
    if (!filing) {
      return NextResponse.json({ error: 'Filing not found' }, { status: 404 });
    }

    // Validate same case
    if (doc.caseId !== filing.caseId) {
      return NextResponse.json(
        { error: 'Document and filing must belong to the same case' },
        { status: 400 }
      );
    }

    const label = exhibitLabel || await nextExhibitLabel(filingId);

    const updated = await prisma.document.update({
      where: { id },
      data: { filingId, exhibitLabel: label },
    });

    return NextResponse.json({ document: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add exhibit' },
      { status: 500 }
    );
  }
}
