import { NextRequest, NextResponse } from 'next/server';
import { getDraft, updateDraft, deleteDraft } from '@/lib/draft/draft-service';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const draft = await getDraft(id);
  if (!draft) {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }
  return NextResponse.json(draft);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();
  const { title, content, status, documentType, changeSummary } = body as {
    title?: string;
    content?: string;
    status?: string;
    documentType?: string;
    changeSummary?: string;
  };

  try {
    const updated = await updateDraft(id, { title, content, status, documentType, changeSummary });
    return NextResponse.json(updated);
  } catch (e: any) {
    if (e.message === 'Draft not found') {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
    }
    throw e;
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    await deleteDraft(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  }
}
