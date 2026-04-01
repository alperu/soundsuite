import { NextRequest, NextResponse } from 'next/server';
import { addLinkedCase, removeLinkedCase, getLinkedCaseIds } from '@/lib/draft/draft-service';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const caseIds = await getLinkedCaseIds(id);
  return NextResponse.json({ caseIds });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { caseId } = await request.json();
  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required' }, { status: 400 });
  }
  try {
    await addLinkedCase(id, caseId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e.code === 'P2002') {
      return NextResponse.json({ error: 'Case already linked' }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { caseId } = await request.json();
  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required' }, { status: 400 });
  }
  try {
    await removeLinkedCase(id, caseId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  }
}
