import { NextRequest, NextResponse } from 'next/server';
import { listVersions } from '@/lib/draft/draft-service';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const versions = await listVersions(id);
  return NextResponse.json(versions);
}
