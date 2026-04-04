import { NextResponse } from 'next/server';
import { state } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { disconnectWebSocket } from '@/lib/ws-client';
import fs from 'fs';
import path from 'path';

function writeSidecarConfig(serverUrl: string | null) {
  try {
    const configPath = process.env.SIDECAR_CONFIG_PATH ||
      path.join(path.dirname(process.argv[1] || __filename), 'config', 'sidecar.config.json');
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing: any = { serverUrl: null };
    try { if (fs.existsSync(configPath)) existing = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
    fs.writeFileSync(configPath, JSON.stringify({ ...existing, serverUrl }, null, 2));
  } catch {}
}

export async function POST() {
  try {
    disconnectWebSocket();
    state.serverUrl = null;
    writeSidecarConfig(null);
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
