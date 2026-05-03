import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getConfig } from '@/lib/db/config';

/**
 * GET /api/docs/info
 * Runtime values for template substitution in the docs viewer.
 * Safe to expose: no secrets, just URLs/versions the user needs to copy-paste.
 */
export async function GET(request: NextRequest) {
  const config = await getConfig().catch(() => null);

  // Master URL: configured (admin) > env var > derived from request hostname.
  const reqUrl = new URL(request.url);
  const derivedMasterUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  const masterUrl = (config?.masterUrl || '').trim() || process.env.SOUND_SUITE_MASTER_URL || derivedMasterUrl;

  // Sidecar version + tarball path from build manifest
  let sidecarVersion = 'unknown';
  let sidecarTarball = 'sidecar-latest.tar.gz';
  try {
    const manifestPath = path.join(process.cwd(), 'public', 'sideCar', 'builds', 'manifest.json');
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    sidecarVersion = m.version || sidecarVersion;
    sidecarTarball = m.filename || sidecarTarball;
  } catch { /* manifest absent */ }

  return NextResponse.json({
    masterUrl,
    masterHost: new URL(masterUrl).host,
    mcpHttpUrl: `${masterUrl}/api/mcp`,
    mcpRpcUrl: `${masterUrl}/api/mcp/rpc`,
    mcpAuthMode: process.env.MCP_AUTH_MODE || 'none',
    sidecarVersion,
    sidecarTarballUrl: `${masterUrl}/sideCar/builds/${sidecarTarball}`,
    sidecarPort: 8098,
    serverPort: Number(process.env.PORT || 3000),
  });
}
