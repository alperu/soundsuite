import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import path from 'path';
import { commitEntity } from '../haystack/[op]/route';

/**
 * Parse case metadata from a folder name.
 * Expected pattern: "Case Title - Case-Number"
 * e.g. "Bill of Review - D-1-FM-25-000222"
 */
function parseCaseFolder(folderPath: string): { name: string; caseNumber: string | null; jurisdiction: string | null } {
  const folderName = path.basename(folderPath).trim();
  const dashMatch = folderName.match(/^(.+?)\s*-\s*([A-Z0-9][\w-]+.*)$/i);

  if (dashMatch) {
    const name = dashMatch[1].trim();
    const caseNumber = dashMatch[2].trim();
    // Extract jurisdiction from case number prefix (e.g. "D-1-FM" from "D-1-FM-25-000222")
    const jurisdictionMatch = caseNumber.match(/^([A-Z](?:-\d+)?-[A-Z]+)/i);
    const jurisdiction = jurisdictionMatch ? jurisdictionMatch[1] : null;
    return { name, caseNumber, jurisdiction };
  }

  return { name: folderName, caseNumber: null, jurisdiction: null };
}

/**
 * GET /api/cases - List all cases, or look up a single case by caseNumber
 * Query params: ?caseNumber=D-1-FM-25-000222
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const caseNumberFilter = searchParams.get('caseNumber');

  if (caseNumberFilter) {
    // Look up a single case by caseNumber (trim to handle whitespace mismatches)
    const trimmed = caseNumberFilter.trim();
    
    const findCase = async (where: any) => {
      try {
        return await prisma.case.findFirst({
          where,
          include: {
            documents: { orderBy: { createdAt: 'desc' } },
            filings: {
              include: { documents: { orderBy: { createdAt: 'asc' } } },
              orderBy: { createdAt: 'desc' },
            },
          },
        });
      } catch {
        // Fallback without filings (in case Filing table doesn't exist yet)
        return await prisma.case.findFirst({
          where,
          include: {
            documents: { orderBy: { createdAt: 'desc' } },
          },
        });
      }
    };

    let caseRecord = await findCase({ caseNumber: trimmed });
    // Fallback: try contains match for cases with trailing whitespace in DB
    if (!caseRecord) {
      caseRecord = await findCase({ caseNumber: { contains: trimmed } });
    }
    if (!caseRecord) {
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    }
    return NextResponse.json({ case: caseRecord });
  }

  const cases = await prisma.case.findMany({
    include: {
      documents: {
        select: { status: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const result = cases.map((c: any) => ({
    id: c.id,
    name: c.name,
    path: c.path,
    caseNumber: c.caseNumber,
    jurisdiction: c.jurisdiction,
    county: c.county,
    state: c.state,
    country: c.country,
    totalDocuments: c.documents.length,
    createdAt: c.createdAt,
  }));

  return NextResponse.json({ cases: result });
}

/**
 * POST /api/cases - Create a new case from a folder path
 * Body: { folderPath: string, name?: string, caseNumber?: string, jurisdiction?: string }
 *
 * @deprecated Prefer `PUT /api/haystack-proxy/commit` with
 * `{ id: 'new', kind: 'case', patch: { name, path, caseNumber, ... } }`.
 * This endpoint forwards to the unified commit code path; folder-name
 * parsing remains here as a convenience for the legacy "add case" UX.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { folderPath, name, caseNumber, jurisdiction, county, state, country } = body;

    if (!folderPath || typeof folderPath !== 'string') {
      return NextResponse.json(
        { error: 'folderPath is required' },
        { status: 400 }
      );
    }

    const cleanPath = folderPath.replace(/\/+$/, ''); // trim trailing slashes

    // Surface the explicit 409 for duplicate paths the way the legacy API did
    // (commitEntity would also throw P2002, but the legacy contract returns
    // the existing case row so callers can adopt it).
    const existing = await prisma.case.findUnique({ where: { path: cleanPath } });
    if (existing) {
      return NextResponse.json(
        { error: 'A case with this folder path already exists', case: existing },
        { status: 409 }
      );
    }

    // Use provided values, fall back to parsed folder name
    const parsed = parseCaseFolder(cleanPath);
    const caseName = (name && name.trim()) || parsed.name;
    const caseNum = (caseNumber && caseNumber.trim()) || parsed.caseNumber;
    const juris = (jurisdiction && jurisdiction.trim()) || parsed.jurisdiction;

    const result = await commitEntity({
      id: null, // create
      kind: 'case',
      patch: {
        name: caseName,
        path: cleanPath,
        caseNumber: caseNum,
        jurisdiction: juris,
        county,
        state,
        country,
      },
    });

    if (!result.ok) {
      let msg = 'Failed to create case';
      try {
        const g = JSON.parse(result.errGridJson);
        msg = String(g?.meta?.dis ?? msg);
      } catch { /* ignore */ }
      const status = /unique|already exists/i.test(msg) ? 409
        : /missing required|does not exist|not a directory|is required/i.test(msg) ? 400
        : 500;
      return NextResponse.json({ error: msg }, { status });
    }

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
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create case' },
      { status: 500 }
    );
  }
}
