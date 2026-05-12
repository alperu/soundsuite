import { NextResponse } from 'next/server';
import { state, ensureMaster } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { connectMaster } from '@/lib/ws-client';
import { createLogger } from '@/lib/logger';

const cors = { 'Access-Control-Allow-Origin': '*' };
const log = createLogger('api/masters');

function snapshot() {
  return [...state.masters.values()].map(m => ({
    serverUrl: m.serverUrl,
    wsPort: m.wsPort ?? null,
    connectionMode: m.connectionMode,
    lastHeartbeatAt: m.lastHeartbeatAt ?? null,
    lastSeenServerVersion: m.lastSeenServerVersion ?? null,
  }));
}

function parseWsPort(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 65535) {
    return { error: 'wsPort must be a positive integer between 1 and 65535' };
  }
  return Math.floor(raw);
}

export async function GET() {
  return NextResponse.json({ masters: snapshot() }, { headers: cors });
}

export async function POST(request: Request) {
  let serverUrl = '';
  try {
    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl.trim() : '';
    const authToken = typeof body.authToken === 'string' ? body.authToken : undefined;
    const wsPortParsed = parseWsPort(body.wsPort);

    if (!serverUrl) {
      return NextResponse.json(
        { error: 'serverUrl is required' },
        { status: 400, headers: cors },
      );
    }
    // Validate the URL up front so we return 400 (clear error) instead of
    // letting `new URL(...)` throw later inside connectMaster and tripping
    // a 500 with an opaque "Invalid URL" message.
    try {
      const u = new URL(serverUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`unsupported protocol "${u.protocol}" — use http:// or https://`);
      }
    } catch (urlErr) {
      return NextResponse.json(
        { error: `Invalid serverUrl "${serverUrl}": ${(urlErr as Error).message}` },
        { status: 400, headers: cors },
      );
    }
    if (wsPortParsed && typeof wsPortParsed === 'object' && 'error' in wsPortParsed) {
      return NextResponse.json(
        { error: wsPortParsed.error },
        { status: 400, headers: cors },
      );
    }

    const existed = state.masters.has(serverUrl);
    const m = ensureMaster(serverUrl, { authToken, wsPort: wsPortParsed as number | undefined });
    try {
      saveConfig();
    } catch (saveErr) {
      // saveConfig() logs+swallows internally, but if something escapes
      // (e.g. permission error on /app/config) surface it clearly rather
      // than letting it bubble as a generic 500.
      log.error(`saveConfig failed while adding master ${serverUrl}: ${(saveErr as Error).message}`);
      return NextResponse.json(
        { error: `Master added in memory but failed to persist: ${(saveErr as Error).message}` },
        { status: 500, headers: cors },
      );
    }
    // connectMaster is intentionally fire-and-forget. Its outer try/catch
    // already routes failures to the HTTP-fallback path, so it should never
    // propagate. But wrap defensively so a bug there doesn't 500 the API.
    if (!existed) {
      try {
        connectMaster(m);
      } catch (connErr) {
        log.warn(`connectMaster threw for ${serverUrl} (master kept; will retry): ${(connErr as Error).message}`);
      }
    }

    return NextResponse.json(
      {
        master: {
          serverUrl: m.serverUrl,
          wsPort: m.wsPort ?? null,
          connectionMode: m.connectionMode,
          lastHeartbeatAt: m.lastHeartbeatAt ?? null,
          lastSeenServerVersion: m.lastSeenServerVersion ?? null,
        },
        added: !existed,
      },
      { headers: cors },
    );
  } catch (err) {
    const e = err as Error;
    // Log the full stack so the sidecar console shows the real cause, not
    // just the truncated message that goes to the API client.
    log.error(`POST /api/masters failed for serverUrl="${serverUrl}": ${e.message}\n${e.stack || '(no stack)'}`);
    return NextResponse.json(
      { error: e.message || 'unknown error' },
      { status: 500, headers: cors },
    );
  }
}
