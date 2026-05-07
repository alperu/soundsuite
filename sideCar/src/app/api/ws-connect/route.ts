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

    if (!existed) {
      connectMaster(m);
    }

    return NextResponse.json(
      {
        message: existed ? `Already connected to ${url}` : `Connecting to ${url}...`,
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
