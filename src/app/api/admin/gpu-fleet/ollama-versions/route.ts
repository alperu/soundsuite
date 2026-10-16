import { NextRequest, NextResponse } from 'next/server';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import { probeOllamaVersion } from '@/lib/gpu/ollama-version';

export const dynamic = 'force-dynamic';

/**
 * Ollama version per container port on a sidecar host, for the /admin/gpu
 * Containers table. Probes host:port/api/version directly (same path the
 * master uses for inference), so it works with sidecars that predate any
 * version reporting.
 *
 * GET ?sidecarUrl=http://host:3100&ports=11434,11435
 * Response: { versions: { "11434": "0.32.5", "11435": null } }
 *   null — endpoint unreachable (stopped container, NAT'd host)
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'gpu-fleet/ollama-versions');
  if (denied) return denied;

  const sidecarUrl = request.nextUrl.searchParams.get('sidecarUrl');
  if (!sidecarUrl) {
    return NextResponse.json({ error: 'sidecarUrl is required' }, { status: 400 });
  }
  let host: string;
  try {
    host = new URL(sidecarUrl).hostname;
  } catch {
    return NextResponse.json({ error: 'invalid sidecarUrl' }, { status: 400 });
  }

  const ports = (request.nextUrl.searchParams.get('ports') || '')
    .split(',')
    .map(p => parseInt(p, 10))
    .filter(p => Number.isInteger(p) && p > 0 && p < 65536)
    .slice(0, 16);

  const entries = await Promise.all(ports.map(async p => [String(p), await probeOllamaVersion(host, p)] as const));
  return NextResponse.json({ versions: Object.fromEntries(entries) });
}
