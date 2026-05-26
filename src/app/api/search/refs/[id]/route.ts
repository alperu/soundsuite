/**
 * Resolve a `@uuid` ref to its human-readable label for chip rendering.
 *
 * GET /api/search/refs/<id> → { id, kind: 'case'|'person'|'document'|'filing', label }
 *
 * The unified chip composer renders ref chips as `[field] [== ▾] [@HumanLabel]`
 * — this endpoint provides the label. The ID is opaque to the composer; we
 * try each known entity table in priority order (case → person → document →
 * filing) and return the first hit.
 *
 * 404 if nothing matches; the composer should fall back to showing the bare uuid.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

interface RefLookupResult {
  id: string;
  kind: 'case' | 'person' | 'document' | 'filing';
  label: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { error: { message: 'id is required' } },
      { status: 400 },
    );
  }

  try {
    // Case first — most likely target for `caseRef`.
    const caseRow = await prisma.case.findUnique({
      where: { id },
      select: { id: true, name: true, caseNumber: true },
    });
    if (caseRow) {
      const label = caseRow.caseNumber
        ? `${caseRow.caseNumber} — ${caseRow.name}`
        : caseRow.name;
      return NextResponse.json<RefLookupResult>({ id: caseRow.id, kind: 'case', label });
    }

    const person = await prisma.person.findUnique({
      where: { id },
      select: { id: true, displayName: true },
    });
    if (person) {
      return NextResponse.json<RefLookupResult>({
        id: person.id, kind: 'person', label: person.displayName,
      });
    }

    const document = await prisma.document.findUnique({
      where: { id },
      select: { id: true, fileName: true },
    });
    if (document) {
      return NextResponse.json<RefLookupResult>({
        id: document.id, kind: 'document', label: document.fileName,
      });
    }

    const filing = await prisma.filing.findUnique({
      where: { id },
      select: { id: true, title: true },
    });
    if (filing) {
      return NextResponse.json<RefLookupResult>({
        id: filing.id, kind: 'filing', label: filing.title,
      });
    }

    return NextResponse.json(
      { error: { message: 'ref not found' } },
      { status: 404 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: { message: err instanceof Error ? err.message : 'lookup failed' } },
      { status: 500 },
    );
  }
}
