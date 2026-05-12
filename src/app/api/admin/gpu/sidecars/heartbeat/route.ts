import { NextRequest, NextResponse } from 'next/server';
import { getConfig, setConfigValue } from '@/lib/db/config';
import { updateSidecarStatus } from '@/lib/gpu/status-cache';
import { fetchPendingCommands } from '@/lib/gpu/command-queue';
import { MASTER_URL_HEADER, deriveOriginFromHeaders } from '@/lib/gpu/master-identity';
import { resolveMasterUrlForHost } from '@/lib/gpu/resolve-master-url-for-host';
import { triggerReassertNow } from '@/lib/gpu/sidecar-reconnect-watchdog';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SidecarHeartbeat');

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
 *
 * When the sidecar reports an empty `masters[]` array (config lost on reboot
 * or fresh container), this route fires an immediate reverse-poll to push
 * the master URL back instead of waiting for the watchdog tick.
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

    // Resolve the master URL the sidecar should use. Priority:
    //   1. explicit per-host provisioning   (HostProvisioning.masterUrlForHost)
    //   2. request-scoped bootstrap         (derived from Host hdr - NOT persisted)
    // The bootstrap path covers the case where a freshly-rebooted sidecar at
    // a never-before-seen IP successfully reached us; we know that URL works.
    const headers: Record<string, string> = {};
    const provisioned = await resolveMasterUrlForHost(agentUrl);
    const bootstrap = provisioned ? null : deriveOriginFromHeaders(request.headers);
    const effectiveMasterUrl = provisioned ?? bootstrap;
    if (effectiveMasterUrl) headers[MASTER_URL_HEADER] = effectiveMasterUrl;

    // Sidecar reset detection: empty masters[] in heartbeat means it lost
    // its config. Fire an immediate reverse-poll instead of waiting for the
    // watchdog tick. Fire-and-forget; we still return the header above.
    if (Array.isArray(body.masters) && body.masters.length === 0) {
      logger.warn(
        `Sidecar boot detected with empty master list: ${agentUrl} — reasserting URL`,
        { agentUrl, effectiveMasterUrl, bootstrap: !provisioned },
      );
      // effectiveMasterUrl is undefined if neither path produced one - in that
      // case triggerReassertNow correctly no-ops.
      void triggerReassertNow(agentUrl, effectiveMasterUrl ?? null).catch(() => {});
    }

    return NextResponse.json(
      { ok: true, commands, masterUrl: effectiveMasterUrl || undefined },
      { headers },
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
