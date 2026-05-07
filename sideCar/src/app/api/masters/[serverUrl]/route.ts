import { NextResponse } from 'next/server';
import { state, removeMaster } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { disconnectMaster } from '@/lib/ws-client';

const cors = { 'Access-Control-Allow-Origin': '*' };

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ serverUrl: string }> },
) {
  try {
    const { serverUrl: encoded } = await context.params;
    const serverUrl = decodeURIComponent(encoded);
    const m = state.masters.get(serverUrl);
    if (!m) {
      return NextResponse.json(
        { error: `Master not found: ${serverUrl}` },
        { status: 404, headers: cors },
      );
    }
    disconnectMaster(m);
    removeMaster(serverUrl);
    saveConfig();
    return NextResponse.json(
      { ok: true, removed: serverUrl },
      { headers: cors },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}
