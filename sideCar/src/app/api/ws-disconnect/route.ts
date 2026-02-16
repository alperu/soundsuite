import { NextResponse } from 'next/server';
import { state } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { saveSidecarConfig } from '@/lib/sidecar-config';
import { disconnectWebSocket } from '@/lib/ws-client';

export async function POST() {
  try {
    disconnectWebSocket();
    state.serverUrl = null;
    saveSidecarConfig({ serverUrl: null });
    saveConfig();

    return NextResponse.json(
      { message: 'WebSocket disconnected' },
      { headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
