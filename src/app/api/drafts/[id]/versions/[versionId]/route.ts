import { NextRequest, NextResponse } from 'next/server';
import { getVersion } from '@/lib/draft/draft-service';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await params;
  const version = await getVersion(versionId);
  if (!version || version.draftId !== id) {
    return NextResponse.json({ error: 'Version not found' }, { status: 404 });
  }
  return NextResponse.json(version);
}
