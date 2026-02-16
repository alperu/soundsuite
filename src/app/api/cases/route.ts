import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getServicesManager } from '@/lib/services-manager';
import fs from 'fs/promises';
import path from 'path';

/**
 * Parse case metadata from a folder name.
 * Expected pattern: "Case Title - Case-Number"
 * e.g. "Bill of Review - D-1-FM-25-004488"
 */
function parseCaseFolder(folderPath: string): { name: string; caseNumber: string | null; jurisdiction: string | null } {
  const folderName = path.basename(folderPath).trim();
  const dashMatch = folderName.match(/^(.+?)\s*-\s*([A-Z0-9][\w-]+.*)$/i);

  if (dashMatch) {
    const name = dashMatch[1].trim();
    const caseNumber = dashMatch[2].trim();
    // Extract jurisdiction from case number prefix (e.g. "D-1-FM" from "D-1-FM-25-004488")
    const jurisdictionMatch = caseNumber.match(/^([A-Z](?:-\d+)?-[A-Z]+)/i);
    const jurisdiction = jurisdictionMatch ? jurisdictionMatch[1] : null;
    return { name, caseNumber, jurisdiction };
  }

  return { name: folderName, caseNumber: null, jurisdiction: null };
}

/**
 * GET /api/cases - List all cases, or look up a single case by caseNumber
 * Query params: ?caseNumber=D-1-FM-25-004488
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

    // Validate folder exists
    try {
      const stat = await fs.stat(cleanPath);
      if (!stat.isDirectory()) {
        return NextResponse.json(
          { error: 'Path is not a directory' },
          { status: 400 }
        );
      }
    } catch {
      return NextResponse.json(
        { error: 'Folder path does not exist or is not accessible' },
        { status: 400 }
      );
    }

    // Check if case already exists
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

    const newCase = await prisma.case.create({
      data: {
        name: caseName,
        path: cleanPath,
        caseNumber: caseNum || null,
        jurisdiction: juris || null,
        county: (county && county.trim()) || null,
        state: (state && state.trim()) || null,
        country: (country && country.trim()) || 'United States',
      },
    });

    // Notify FileWatcher to start watching the new case path
    const fileWatcher = getServicesManager().getFileWatcher();
    if (fileWatcher) {
      await fileWatcher.addPath(cleanPath);
    }

    return NextResponse.json({ case: newCase }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create case' },
      { status: 500 }
    );
  }
}
