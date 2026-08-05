import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/db/config';
import { ocrModelCaps } from '@/lib/gpu/ocr-model-caps';

export const dynamic = 'force-dynamic';

/** Numeric dotted-version compare: negative ⇒ a < b. */
function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

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

  try {
    const res = await fetch(`http://${host}:${port}/api/version`, {
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const version = String(data?.version || '');
    const ok = version.length > 0 && cmpVersions(version, required) >= 0;
    return NextResponse.json({ model, required, version: version || null, ok: version ? ok : null });
  } catch {
    return NextResponse.json({ model, required, version: null, ok: null });
  }
}
