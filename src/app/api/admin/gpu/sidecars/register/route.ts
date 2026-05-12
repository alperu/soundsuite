import { NextRequest, NextResponse } from 'next/server';
import { getConfig, setConfigValue } from '@/lib/db/config';
import { MASTER_URL_HEADER, deriveOriginFromHeaders } from '@/lib/gpu/master-identity';
import { resolveMasterUrlForHost } from '@/lib/gpu/resolve-master-url-for-host';
import { triggerReassertNow } from '@/lib/gpu/sidecar-reconnect-watchdog';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SidecarRegister');

interface SidecarEntry {
  url: string;
  hostname: string;
  mode: 'direct' | 'websocket';
  lastSeen: string;
  status: string;
  containers?: string[];
  lastSeenAt?: number;
  lastSeenFromIp?: string;
}

/**
 * POST /api/admin/gpu/sidecars/register
 * Register a sidecar via direct HTTP (for sidecars that can reach the server).
 * Body: { agentUrl: string, hostname: string, containers?: string[] }
 *
 * Response includes `X-Sound-Suite-Master-Url` so the sidecar can persist
 * the canonical master URL (re-asserting in case the operator dropped it).
 *
 * Bootstrap fallback: when no per-host record exists, we use the request's
 * Host header as a one-time URL push. NOT persisted to HostProvisioning.
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
    const nowMs = Date.now();
    const reqIp =
      request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
      request.headers.get('x-real-ip') ||
      '';
    const existing = sidecars.findIndex(s => s.url === agentUrl);

    const entry: SidecarEntry = {
      url: agentUrl,
      hostname: hostname || 'unknown',
      mode: 'direct',
      lastSeen: now,
      lastSeenAt: nowMs,
      lastSeenFromIp: reqIp || undefined,
      status: 'connected',
      containers: containers || [],
    };

    if (existing >= 0) {
      sidecars[existing] = entry;
    } else {
      sidecars.push(entry);
    }

    await setConfigValue('gpu.sidecars', JSON.stringify(sidecars));

    // Per-host provisioning takes precedence; request Host header is a
    // one-time bootstrap (not persisted).
    const headers: Record<string, string> = {};
    const provisioned = await resolveMasterUrlForHost(agentUrl);
    const bootstrap = provisioned ? null : deriveOriginFromHeaders(request.headers);
    const effectiveMasterUrl = provisioned ?? bootstrap;
    if (effectiveMasterUrl) headers[MASTER_URL_HEADER] = effectiveMasterUrl;

    // Register is by definition "first contact" - if the sidecar is calling
    // /register, treat it like an empty-masters reset and fire an immediate
    // reverse-poll so /api/masters is populated without waiting 30s.
    if (effectiveMasterUrl) {
      logger.info('Sidecar registered via HTTP - firing immediate reassert', {
        agentUrl, effectiveMasterUrl, bootstrap: !provisioned,
      });
      void triggerReassertNow(agentUrl, effectiveMasterUrl).catch(() => {});
    }

    return NextResponse.json(
      { ok: true, registered: entry, masterUrl: effectiveMasterUrl || undefined },
      { headers },
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
