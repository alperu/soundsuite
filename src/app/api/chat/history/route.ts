import { NextRequest, NextResponse } from 'next/server';
import { listSessions, saveSession, type ChatSession } from '@/lib/chat/history-service';

/** GET /api/chat/history?caseNumber=... */
export async function GET(request: NextRequest) {
  try {
    const caseNumber = request.nextUrl.searchParams.get('caseNumber') || undefined;
    const sessions = await listSessions(caseNumber);
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error('Failed to list chat sessions:', error);
    return NextResponse.json({ error: 'Failed to list sessions' }, { status: 500 });
  }
}

/** POST /api/chat/history — save a session */
export async function POST(request: NextRequest) {
  try {
    const session = (await request.json()) as ChatSession;
    if (!session.id) {
      return NextResponse.json({ error: 'Session ID is required' }, { status: 400 });
    }
    await saveSession(session);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to save chat session:', error);
    return NextResponse.json({ error: 'Failed to save session' }, { status: 500 });
  }
}
