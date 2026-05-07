import { NextRequest, NextResponse } from 'next/server';
import { getConfig, setConfigValue } from '@/lib/db/config';
import { updateSidecarStatus } from '@/lib/gpu/status-cache';
import { fetchPendingCommands } from '@/lib/gpu/command-queue';

interface SidecarEntry {
  url: string;
  hostname: string;
  mode: 'direct' | 'websocket';
  lastSeen: string;
  status: string;
  containers?: string[];
}

/**
 * POST /api/admin/gpu/sidecars/heartbeat
 * Receive heartbeat from a sidecar with full status.
 * Also returns any pending commands (piggyback on heartbeat = fewer round-trips).
 *
 * Body: {
 *   agentUrl: string,
 *   hostname?: string,
 *   version?: string,
 *   mode?: string,
 *   uptime?: number,
 *   containers?: Record<string, { status, name, image, port, vram, type, model, exists }>,
 *   activeRequests?: number,
 *   idleTimeouts?: Record<string, number>,
 *   roles?: Record<string, { activeRequests, idleTimerActive }>,
 *   peakDemand?: Record<string, number>,
 *   gpus?: Array<{ index, name, memoryTotal, memoryUsed, memoryFree, temperature }>,
 *   wsConnected?: boolean,
 *   // Legacy fields:
 *   containerNames?: string[],
 * }
 *
 * Response: { ok: true, commands: [{ id, action, payload }] }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { agentUrl } = body;

    if (!agentUrl || typeof agentUrl !== 'string') {
      return NextResponse.json({ error: 'agentUrl is required' }, { status: 400 });
    }

    // Update status cache with full status
    updateSidecarStatus(agentUrl, {
      hostname: body.hostname,
      version: body.version,
      mode: body.mode,
      uptime: body.uptime,
      containers: body.containers,
      activeRequests: body.activeRequests,
      idleTimeouts: body.idleTimeouts,
      roles: body.roles,
      peakDemand: body.peakDemand,
      gpus: body.gpus,
      wsConnected: body.wsConnected,
      masters: body.masters,
      lastConfigPushAt: body.lastConfigPushAt,
      vram: body.vram,
    });

    // Update legacy sidecar registry in Config DB
    const config = await getConfig();
    let sidecars: SidecarEntry[] = [];
    try {
      sidecars = JSON.parse(config.gpuSidecars);
    } catch { /* empty */ }

    const now = new Date().toISOString();
    const containerNames = body.containerNames
      || (body.containers ? Object.values(body.containers).map((c: any) => c.name).filter(Boolean) : undefined);
    const existing = sidecars.findIndex(s => s.url === agentUrl);

    if (existing >= 0) {
      sidecars[existing].lastSeen = now;
      sidecars[existing].status = 'connected';
      sidecars[existing].hostname = body.hostname || sidecars[existing].hostname;
      if (containerNames) sidecars[existing].containers = containerNames;
    } else {
      sidecars.push({
        url: agentUrl,
        hostname: body.hostname || 'unknown',
        mode: 'direct',
        lastSeen: now,
        status: 'connected',
        containers: containerNames || [],
      });
    }

    await setConfigValue('gpu.sidecars', JSON.stringify(sidecars));

    // Piggyback: return any pending commands for this sidecar
    const commands = await fetchPendingCommands(agentUrl);

    return NextResponse.json({ ok: true, commands });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
