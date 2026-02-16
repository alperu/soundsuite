/**
 * Filing Types API Route
 *
 * GET  /api/admin/filing-types — list configured filing types
 * POST /api/admin/filing-types — add a filing type
 * DELETE /api/admin/filing-types — remove a filing type
 * PATCH /api/admin/filing-types — rename a filing type
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

const CONFIG_KEY = 'filing.types';

const DEFAULT_FILING_TYPES = [
  'Motion', 'Notice', 'Letter', 'Order', 'Petition', 'Affidavit',
  'Subpoena', 'Brief', 'Response', 'Reply', 'Judgment', 'Decree',
  "Clerk's Record", "Reporter's Record",
  'Transcript', 'Settlement', 'Bill of Review', 'Return of Service',
  'Demand Letter', 'Objection', 'Request', 'Supplement', 'Designation',
  'Other',
];

async function getFilingTypes(): Promise<string[]> {
  const config = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  if (!config || !config.value) {
    return DEFAULT_FILING_TYPES;
  }
  try {
    return JSON.parse(config.value) as string[];
  } catch {
    return DEFAULT_FILING_TYPES;
  }
}

async function saveFilingTypes(types: string[]): Promise<void> {
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value: JSON.stringify(types) },
    create: { key: CONFIG_KEY, value: JSON.stringify(types) },
  });
}

export async function GET() {
  try {
    const types = await getFilingTypes();
    return NextResponse.json({ types });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get filing types' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type } = body;

    if (!type || typeof type !== 'string') {
      return NextResponse.json({ error: 'type is required' }, { status: 400 });
    }

    const types = await getFilingTypes();
    if (types.includes(type)) {
      return NextResponse.json({ error: 'Filing type already exists' }, { status: 409 });
    }

    types.push(type);
    await saveFilingTypes(types);

    return NextResponse.json({ types });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add filing type' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { type } = body;

    if (!type || typeof type !== 'string') {
      return NextResponse.json({ error: 'type is required' }, { status: 400 });
    }

    const types = await getFilingTypes();
    const filtered = types.filter(t => t !== type);
    if (filtered.length === types.length) {
      return NextResponse.json({ error: 'Filing type not found' }, { status: 404 });
    }

    await saveFilingTypes(filtered);

    return NextResponse.json({ types: filtered });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to remove filing type' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { oldType, newType } = body;

    if (!oldType || !newType || typeof oldType !== 'string' || typeof newType !== 'string') {
      return NextResponse.json({ error: 'oldType and newType are required' }, { status: 400 });
    }

    const types = await getFilingTypes();
    const idx = types.indexOf(oldType);
    if (idx === -1) {
      return NextResponse.json({ error: 'Filing type not found' }, { status: 404 });
    }
    if (types.includes(newType)) {
      return NextResponse.json({ error: 'New filing type already exists' }, { status: 409 });
    }

    types[idx] = newType;
    await saveFilingTypes(types);

    // Also update existing filings that used the old type
    await prisma.filing.updateMany({
      where: { filingType: oldType },
      data: { filingType: newType },
    });

    return NextResponse.json({ types });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to rename filing type' },
      { status: 500 }
    );
  }
}
