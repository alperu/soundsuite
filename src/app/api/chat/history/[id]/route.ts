import { NextRequest, NextResponse } from 'next/server';
import { loadSession, deleteSession } from '@/lib/chat/history-service';

interface Params {
  params: Promise<{ id: string }>;
}

/** GET /api/chat/history/:id?caseNumber=... */
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const caseNumber = request.nextUrl.searchParams.get('caseNumber') || undefined;
    const session = await loadSession(id, caseNumber);
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error) {
    console.error('Failed to load chat session:', error);
    return NextResponse.json({ error: 'Failed to load session' }, { status: 500 });
  }
}

/** DELETE /api/chat/history/:id?caseNumber=... */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const caseNumber = request.nextUrl.searchParams.get('caseNumber') || undefined;
    const deleted = await deleteSession(id, caseNumber);
    if (!deleted) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete chat session:', error);
    return NextResponse.json({ error: 'Failed to delete session' }, { status: 500 });
  }
}
