import { NextResponse } from 'next/server';
import { state } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { connectWebSocket, disconnectWebSocket } from '@/lib/ws-client';
import fs from 'fs';
import path from 'path';

// Inline sidecar config save to avoid module resolution issues in Next.js standalone builds
function writeSidecarConfig(serverUrl: string) {
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
    writeSidecarConfig(body.serverUrl);
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
