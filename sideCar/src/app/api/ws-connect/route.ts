import { NextResponse } from 'next/server';
import { state } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { saveSidecarConfig } from '@/lib/sidecar-config';
import { connectWebSocket, disconnectWebSocket } from '@/lib/ws-client';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    if (!body.serverUrl) {
      return NextResponse.json(
        { error: 'serverUrl is required' },
        { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    state.serverUrl = body.serverUrl;
    saveSidecarConfig({ serverUrl: body.serverUrl });
    saveConfig();
    disconnectWebSocket();
    connectWebSocket();

    return NextResponse.json(
      { message: `Connecting to ${body.serverUrl}...` },
      { headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
