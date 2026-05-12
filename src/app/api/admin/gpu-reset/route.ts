import { NextRequest, NextResponse } from 'next/server';
import { getFleetStatus, sendToSidecar } from '@/lib/gpu/fleet-router';
import { createLogger } from '@/lib/logger';

const logger = createLogger('admin/gpu-reset');

/**
 * Fan out /reset-counters to every registered sidecar. Used to recover from
 * leaked activeRequests counters that prevent idle timers from firing and
 * pin GPU VRAM at near-100%.
 *
 * Body (optional):
 *   { role?: string }   // restrict reset to a single role (e.g. "reranker")
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as { role?: string }));
  const role = typeof body.role === 'string' ? body.role : undefined;

  const fleet = await getFleetStatus();
  const results: Array<{ sidecar: string; hostname: string; ok: boolean; result?: unknown; error?: string }> = [];

  for (const s of fleet.sidecars) {
    try {
      const r = await sendToSidecar(s.url, '/reset-counters', role ? { role } : {});
      results.push({ sidecar: s.url, hostname: s.hostname, ok: true, result: r });
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn('reset-counters failed', { sidecar: s.url, error: msg });
      results.push({ sidecar: s.url, hostname: s.hostname, ok: false, error: msg });
    }
  }

  return NextResponse.json({ role: role ?? 'all', sidecars: results });
}
