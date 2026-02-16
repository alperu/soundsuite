import { NextRequest, NextResponse } from 'next/server';
import { getConfig, setConfigValue } from '@/lib/db/config';

interface SidecarEntry {
  url: string;
  hostname: string;
  mode: 'direct' | 'websocket';
  lastSeen: string;
  status: string;
  containers?: string[];
}

/**
 * POST /api/admin/gpu/sidecars/register
 * Register a sidecar via direct HTTP (for sidecars that can reach the server).
 * Body: { agentUrl: string, hostname: string, containers?: string[] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agentUrl, hostname, containers } = body;

    if (!agentUrl || typeof agentUrl !== 'string') {
      return NextResponse.json({ error: 'agentUrl is required' }, { status: 400 });
    }

    const config = await getConfig();
    let sidecars: SidecarEntry[] = [];
    try {
      sidecars = JSON.parse(config.gpuSidecars);
    } catch { /* empty */ }

    const now = new Date().toISOString();
    const existing = sidecars.findIndex(s => s.url === agentUrl);

    const entry: SidecarEntry = {
      url: agentUrl,
      hostname: hostname || 'unknown',
      mode: 'direct',
      lastSeen: now,
      status: 'connected',
      containers: containers || [],
    };

    if (existing >= 0) {
      sidecars[existing] = entry;
    } else {
      sidecars.push(entry);
    }

    await setConfigValue('gpu.sidecars', JSON.stringify(sidecars));

    return NextResponse.json({ ok: true, registered: entry });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
