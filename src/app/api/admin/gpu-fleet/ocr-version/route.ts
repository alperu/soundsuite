import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/db/config';
import { ocrModelCaps } from '@/lib/gpu/ocr-model-caps';
import { requireAdminApiAccess } from '@/lib/api/route-guard';
import { cmpVersions, probeOllamaVersion } from '@/lib/gpu/ollama-version';

export const dynamic = 'force-dynamic';

/**
 * Check whether a sidecar host's OCR Ollama endpoint meets the configured
 * OCR model's minimum Ollama version (ocr-model-caps.minOllamaVersion).
 *
 * The probe goes to the Ollama container port directly (same network path
 * the master uses for inference), NOT through the sidecar — old containers
 * predate any sidecar-side version reporting.
 *
 * Response: { model, required, version, ok }
 *   ok=true   — no floor for this model, or version >= floor
 *   ok=false  — version known and below floor
 *   ok=null   — endpoint unreachable (container stopped is normal here)
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdminApiAccess(request, 'gpu-fleet/ocr-version');
  if (denied) return denied;

  const sidecarUrl = request.nextUrl.searchParams.get('sidecarUrl');
  const port = parseInt(request.nextUrl.searchParams.get('port') || '11436', 10);
  if (!sidecarUrl) {
    return NextResponse.json({ error: 'sidecarUrl is required' }, { status: 400 });
  }
  let host: string;
  try {
    host = new URL(sidecarUrl).hostname;
  } catch {
    return NextResponse.json({ error: 'invalid sidecarUrl' }, { status: 400 });
  }

  const config = await getConfig();
  const model = config.ocrOllamaModel || '';
  const required = ocrModelCaps(model).minOllamaVersion ?? null;
  if (!required) {
    return NextResponse.json({ model, required: null, version: null, ok: true });
  }

  const version = await probeOllamaVersion(host, port);
  if (!version) return NextResponse.json({ model, required, version: null, ok: null });
  return NextResponse.json({ model, required, version, ok: cmpVersions(version, required) >= 0 });
}
