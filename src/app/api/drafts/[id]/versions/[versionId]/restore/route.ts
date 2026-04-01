import { NextRequest, NextResponse } from 'next/server';
import { restoreVersion } from '@/lib/draft/draft-service';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const { id, versionId } = await params;
  try {
    const updated = await restoreVersion(id, versionId);
    return NextResponse.json(updated);
  } catch (e: any) {
    if (e.message === 'Version not found') {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }
    throw e;
  }
}
