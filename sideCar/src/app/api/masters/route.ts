import { NextResponse } from 'next/server';
import { state, ensureMaster } from '@/lib/state';
import { saveConfig, persistedOnlyMasters, isMasterBlocked } from '@/lib/config';
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
    // Reported, not given up on: the sidecar is still retrying on the capped
    // backoff. UNREPORTED is not down; unreachable is not gone.
    unreachable: m.unreachable === true,
    consecutiveFailures: m.httpHeartbeatFailCount,
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
  const live = snapshot();
  // Entries that exist in config.json with no live slot. They were invisible here,
  // so DELETE 404'd on them and an operator could never clear a stale master — it
  // simply came back on the next boot. Surfaced so the UI can offer Remove.
  const orphans = persistedOnlyMasters(live.map((m) => m.serverUrl)).map((o) => ({
    serverUrl: o.serverUrl,
    wsPort: o.wsPort,
    connectionMode: 'not-loaded' as const,
    lastHeartbeatAt: null,
    lastSeenServerVersion: null,
    unreachable: false,
    consecutiveFailures: 0,
    persistedOnly: true,
    // No wsPort means `wsPort ?? 3002` at dial time, which is another master's
    // relay on a shared host — two slots, one agentUrl, mutual eviction.
    warning: o.wsPort === null
      ? 'No wsPort set — this would dial the default 3002, which may be another master\u2019s relay.'
      : undefined,
  }));
  return NextResponse.json({ masters: [...live, ...orphans] }, { headers: cors });
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

    if (isMasterBlocked(serverUrl)) {
      log.warn(`Refusing to add blocked master ${serverUrl} (removed by an operator)`);
      return NextResponse.json(
        { error: `Master was removed by an operator and will not be re-added: ${serverUrl}`,
          hint: 'Re-add it deliberately from Setup if this was not intended.' },
        { status: 409, headers: cors },
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
