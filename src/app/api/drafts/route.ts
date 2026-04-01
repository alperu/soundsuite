import { NextRequest, NextResponse } from 'next/server';
import { listDrafts, createDraft } from '@/lib/draft/draft-service';

export async function GET(request: NextRequest) {
  const caseId = request.nextUrl.searchParams.get('caseId');
  if (!caseId) {
    return NextResponse.json({ error: 'caseId is required' }, { status: 400 });
  }
  const drafts = await listDrafts(caseId);
  return NextResponse.json(drafts);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { caseId, title, documentType } = body as {
    caseId?: string;
    title?: string;
    documentType?: string;
  };

  if (!caseId || !title?.trim() || !documentType?.trim()) {
    return NextResponse.json(
      { error: 'caseId, title, and documentType are required' },
      { status: 400 },
    );
  }

  const draft = await createDraft({ caseId, title: title.trim(), documentType: documentType.trim() });
  return NextResponse.json(draft, { status: 201 });
}
