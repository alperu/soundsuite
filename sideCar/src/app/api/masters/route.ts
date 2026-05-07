import { NextResponse } from 'next/server';
import { state, ensureMaster } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { connectMaster } from '@/lib/ws-client';

const cors = { 'Access-Control-Allow-Origin': '*' };

function snapshot() {
  return [...state.masters.values()].map(m => ({
    serverUrl: m.serverUrl,
    connectionMode: m.connectionMode,
    lastHeartbeatAt: m.lastHeartbeatAt ?? null,
    lastSeenServerVersion: m.lastSeenServerVersion ?? null,
  }));
}

export async function GET() {
  return NextResponse.json({ masters: snapshot() }, { headers: cors });
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl : '';
    const authToken = typeof body.authToken === 'string' ? body.authToken : undefined;

    if (!serverUrl) {
      return NextResponse.json(
        { error: 'serverUrl is required' },
        { status: 400, headers: cors },
      );
    }

    const existed = state.masters.has(serverUrl);
    const m = ensureMaster(serverUrl, { authToken });
    saveConfig();
    if (!existed) connectMaster(m);

    return NextResponse.json(
      {
        master: {
          serverUrl: m.serverUrl,
          connectionMode: m.connectionMode,
          lastHeartbeatAt: m.lastHeartbeatAt ?? null,
          lastSeenServerVersion: m.lastSeenServerVersion ?? null,
        },
        added: !existed,
      },
      { headers: cors },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}
