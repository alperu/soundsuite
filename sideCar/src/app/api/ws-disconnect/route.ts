import { NextResponse } from 'next/server';
import { state, removeMaster } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { disconnectMaster, disconnectAllMasters } from '@/lib/ws-client';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({} as { serverUrl?: string }));
    const serverUrl: string | undefined = body && typeof body.serverUrl === 'string' ? body.serverUrl : undefined;

    if (serverUrl) {
      const m = state.masters.get(serverUrl);
      if (!m) {
        return NextResponse.json(
          { error: `Master not found: ${serverUrl}` },
          { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } },
        );
      }
      disconnectMaster(m);
      removeMaster(serverUrl);
      saveConfig();
      return NextResponse.json(
        { message: `Disconnected from ${serverUrl}`, removed: serverUrl },
        { headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }

    // No body → legacy "wipe all" semantics.
    disconnectAllMasters();
    for (const url of [...state.masters.keys()]) removeMaster(url);
    saveConfig();
    return NextResponse.json(
      { message: 'All masters disconnected' },
      { headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
