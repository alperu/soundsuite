import { NextRequest, NextResponse } from 'next/server';
import { getConfig, setConfigValue } from '@/lib/db/config';
import { updateSidecarStatus } from '@/lib/gpu/status-cache';
import { fetchPendingCommands } from '@/lib/gpu/command-queue';
import {
  MASTER_URL_HEADER,
  deriveOriginFromHeaders,
  getCanonicalMasterUrl,
  noteRequestOrigin,
} from '@/lib/gpu/master-identity';

interface SidecarEntry {
  url: string;
  hostname: string;
  mode: 'direct' | 'websocket';
  lastSeen: string;
  status: string;
  containers?: string[];
  /** Epoch ms of the last successful heartbeat. */
  lastSeenAt?: number;
  /** Source IP observed on the last heartbeat — used for reverse-poll. */
  lastSeenFromIp?: string;
}

/**
 * POST /api/admin/gpu/sidecars/heartbeat
 * Receive heartbeat from a sidecar with full status.
 * Also returns any pending commands (piggyback on heartbeat = fewer round-trips).
 *
 * Response includes `X-Sound-Suite-Master-Url` header so HTTP-only sidecars
 * can persist the canonical master URL and survive config-volume loss.
 */
export async function POST(request: NextRequest) {
  try {
    // Opportunistically cache a self-URL derived from this request, so future
    // sidecars can still get a master-identity push if env/Config aren't set.
    noteRequestOrigin(deriveOriginFromHeaders(request.headers));

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
    const nowMs = Date.now();
    const reqIp =
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      request.headers.get('x-real-ip') ||
      '';
    const containerNames = body.containerNames
      || (body.containers ? Object.values(body.containers).map((c: any) => c.name).filter(Boolean) : undefined);
    const existing = sidecars.findIndex(s => s.url === agentUrl);

    if (existing >= 0) {
      sidecars[existing].lastSeen = now;
      sidecars[existing].lastSeenAt = nowMs;
      if (reqIp) sidecars[existing].lastSeenFromIp = reqIp;
      sidecars[existing].status = 'connected';
      sidecars[existing].hostname = body.hostname || sidecars[existing].hostname;
      if (containerNames) sidecars[existing].containers = containerNames;
    } else {
      sidecars.push({
        url: agentUrl,
        hostname: body.hostname || 'unknown',
        mode: 'direct',
        lastSeen: now,
        lastSeenAt: nowMs,
        lastSeenFromIp: reqIp || undefined,
        status: 'connected',
        containers: containerNames || [],
      });
    }

    await setConfigValue('gpu.sidecars', JSON.stringify(sidecars));

    // Piggyback: return any pending commands for this sidecar
    const commands = await fetchPendingCommands(agentUrl);

    const headers: Record<string, string> = {};
    const masterUrl = await getCanonicalMasterUrl();
    if (masterUrl) headers[MASTER_URL_HEADER] = masterUrl;

    return NextResponse.json({ ok: true, commands, masterUrl: masterUrl || undefined }, { headers });
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
