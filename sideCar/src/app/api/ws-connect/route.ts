import { NextResponse } from 'next/server';
import { ensureMaster, state } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { connectMaster } from '@/lib/ws-client';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    if (!body.serverUrl) {
      return NextResponse.json(
        { error: 'serverUrl is required' },
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    const url: string = body.serverUrl;
    const authToken: string | undefined = typeof body.authToken === 'string' ? body.authToken : undefined;

    const existed = state.masters.has(url);
    const m = ensureMaster(url, { authToken });
    saveConfig();

    // This endpoint is documented as "force a WebSocket reconnect" and is what
    // an operator reaches for when a slot is stuck. It used to call
    // connectMaster ONLY for a brand-new slot, so on an existing one it did
    // nothing at all and answered "Already connected" — while that same
    // response carried connectionMode: 'disconnected'. The one case it was
    // needed for was the one case it skipped.
    //
    // connectMaster is idempotent by design: it returns early if a socket is
    // already OPEN or CONNECTING, so calling it on a genuinely live slot is a
    // no-op rather than a second socket.
    const live = m.connectionMode === 'websocket';
    if (!live) {
      connectMaster(m);
    }

    return NextResponse.json(
      {
        message: live
          ? `Already connected to ${url}`
          : existed
            ? `Reconnecting to ${url}...`
            : `Connecting to ${url}...`,
        master: {
          serverUrl: m.serverUrl,
          connectionMode: m.connectionMode,
        },
      },
      { headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
