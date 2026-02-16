import { NextRequest, NextResponse } from 'next/server';
import { archiveSessions } from '@/lib/chat/history-service';

/** POST /api/chat/history/archive — archive sessions as downloadable file */
export async function POST(request: NextRequest) {
  try {
    const { sessionIds } = (await request.json()) as { sessionIds: string[] };
    if (!sessionIds || sessionIds.length === 0) {
      return NextResponse.json({ error: 'sessionIds required' }, { status: 400 });
    }

    const buffer = await archiveSessions(sessionIds);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'text/markdown',
        'Content-Disposition': `attachment; filename="chat-archive-${timestamp}.md"`,
      },
    });
  } catch (error) {
    console.error('Failed to archive chat sessions:', error);
    return NextResponse.json({ error: 'Failed to archive sessions' }, { status: 500 });
  }
}
