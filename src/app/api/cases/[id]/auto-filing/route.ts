/**
 * GET/PUT /api/cases/[id]/auto-filing
 *
 * Persists the auto-filing toggle per case in the Config table.
 * Key format: "case.<caseId>.autoFiling" with value "true" or "false".
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

function configKey(caseId: string): string {
  return `case.${caseId}.autoFiling`;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const config = await prisma.config.findUnique({
    where: { key: configKey(id) },
  });

  return NextResponse.json({
    enabled: config?.value === 'true',
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Verify case exists
  const caseRecord = await prisma.case.findUnique({ where: { id } });
  if (!caseRecord) {
    return NextResponse.json({ error: 'Case not found' }, { status: 404 });
  }

  const body = await request.json();
  const enabled = body.enabled === true;

  await prisma.config.upsert({
    where: { key: configKey(id) },
    update: { value: String(enabled) },
    create: { key: configKey(id), value: String(enabled) },
  });

  return NextResponse.json({ enabled });
}
