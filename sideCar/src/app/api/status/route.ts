import { NextRequest, NextResponse } from 'next/server';
import { handleStatus } from '@/lib/handlers';
import { state } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { saveSidecarConfig } from '@/lib/sidecar-config';
import { connectWebSocket, disconnectWebSocket } from '@/lib/ws-client';
import { switchMode } from '@/lib/containers';

const cors = { 'Access-Control-Allow-Origin': '*' };

export async function GET() {
  try {
    const result = await handleStatus();
    return NextResponse.json(result, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, serverUrl } = body;

    if (action === 'connect') {
      if (!serverUrl) {
        return NextResponse.json({ error: 'serverUrl is required' }, { status: 400, headers: cors });
      }
      state.serverUrl = serverUrl;
      saveSidecarConfig({ serverUrl });
      saveConfig();
      disconnectWebSocket();
      connectWebSocket();
      return NextResponse.json({ message: `Connecting to ${serverUrl}...` }, { headers: cors });
    }

    if (action === 'disconnect') {
      disconnectWebSocket();
      state.serverUrl = null;
      saveSidecarConfig({ serverUrl: null });
      saveConfig();
      return NextResponse.json({ message: 'Disconnected' }, { headers: cors });
    }

    if (action === 'setMode') {
      const result = await switchMode(body.mode);
      return NextResponse.json(result, { headers: cors });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400, headers: cors });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}
