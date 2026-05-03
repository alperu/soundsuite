import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getConfig } from '@/lib/db/config';

interface CandidateAddress {
  /** Full URL the user can copy. */
  url: string;
  /** Bare host:port for display. */
  host: string;
  /** Friendly source label: "configured", "env", "request", "interface:eth0", "loopback". */
  source: string;
  /** Whether this is the recommended default for fresh installs. */
  recommended?: boolean;
}

function listInterfaceAddresses(port: number, protocol: string): CandidateAddress[] {
  const out: CandidateAddress[] = [];
  const seen = new Set<string>();
  try {
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs ?? []) {
        if (addr.internal) continue;       // skip loopback in this pass
        if (addr.family !== 'IPv4') continue; // IPv6 is supported but rarely the right copy-paste choice
        if (seen.has(addr.address)) continue;
        seen.add(addr.address);
        out.push({
          url: `${protocol}//${addr.address}:${port}`,
          host: `${addr.address}:${port}`,
          source: `interface:${name}`,
        });
      }
    }
  } catch { /* no /proc/net/dev or similar — fall through */ }
  // Loopback last
  out.push({
    url: `${protocol}//127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    source: 'loopback',
  });
  return out;
}

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
  const configuredUrl = (config?.masterUrl || '').trim();
  const envUrl = (process.env.SOUND_SUITE_MASTER_URL || '').trim();
  const masterUrl = configuredUrl || envUrl || derivedMasterUrl;

  // Build candidate list: configured / env / request first, then every local
  // network interface IP. The user picks one in the docs UI; substitution
  // re-runs against the chosen URL so each sidecar / client gets the right
  // address for its network position.
  const port = Number(process.env.PORT || reqUrl.port || 3000);
  const protocol = reqUrl.protocol;
  const candidates: CandidateAddress[] = [];
  const candidateSeen = new Set<string>();
  const pushCandidate = (c: CandidateAddress) => {
    if (candidateSeen.has(c.url)) return;
    candidateSeen.add(c.url);
    candidates.push(c);
  };
  if (configuredUrl) pushCandidate({ url: configuredUrl, host: new URL(configuredUrl).host, source: 'configured (admin)', recommended: true });
  if (envUrl) pushCandidate({ url: envUrl, host: new URL(envUrl).host, source: 'env (SOUND_SUITE_MASTER_URL)' });
  pushCandidate({ url: derivedMasterUrl, host: reqUrl.host, source: 'request (this browser)', recommended: !configuredUrl });
  for (const c of listInterfaceAddresses(port, protocol)) pushCandidate(c);

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
    serverPort: port,
    hostname: os.hostname(),
    candidates,
  });
}
