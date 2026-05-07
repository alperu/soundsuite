import { NextResponse } from 'next/server';
import { state, removeMaster, rekeyMaster } from '@/lib/state';
import { saveConfig } from '@/lib/config';
import { disconnectMaster, connectMaster } from '@/lib/ws-client';

const cors = { 'Access-Control-Allow-Origin': '*' };

function parseWsPort(raw: unknown): number | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > 65535) {
    return { error: 'wsPort must be a positive integer between 1 and 65535' };
  }
  return Math.floor(raw);
}

function masterPayload(m: ReturnType<typeof state.masters.get> & object) {
  return {
    serverUrl: m.serverUrl,
    wsPort: m.wsPort ?? null,
    connectionMode: m.connectionMode,
    lastHeartbeatAt: m.lastHeartbeatAt ?? null,
    lastSeenServerVersion: m.lastSeenServerVersion ?? null,
  };
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ serverUrl: string }> },
) {
  try {
    const { serverUrl: encoded } = await context.params;
    const serverUrl = decodeURIComponent(encoded);
    const m = state.masters.get(serverUrl);
    if (!m) {
      return NextResponse.json(
        { error: `Master not found: ${serverUrl}` },
        { status: 404, headers: cors },
      );
    }
    disconnectMaster(m);
    removeMaster(serverUrl);
    saveConfig();
    return NextResponse.json(
      { ok: true, removed: serverUrl },
      { headers: cors },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}

/**
 * PATCH — edit a master's URL (rename) and/or wsPort. Body:
 *   { serverUrl?: string, wsPort?: number | null, authToken?: string }
 *
 * If serverUrl changes the slot is rekeyed (existing connection state is
 * preserved). If wsPort changes the existing WS is closed and reconnected
 * with the new port. Setting wsPort to null clears the override (back to
 * default 3002).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ serverUrl: string }> },
) {
  try {
    const { serverUrl: encoded } = await context.params;
    const currentUrl = decodeURIComponent(encoded);
    const m = state.masters.get(currentUrl);
    if (!m) {
      return NextResponse.json(
        { error: `Master not found: ${currentUrl}` },
        { status: 404, headers: cors },
      );
    }

    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const newUrl = typeof body.serverUrl === 'string' && body.serverUrl ? body.serverUrl : undefined;
    const authToken = typeof body.authToken === 'string' ? body.authToken : undefined;

    let wsPortChange: { set?: number; clear?: boolean } = {};
    if ('wsPort' in body) {
      if (body.wsPort === null) {
        wsPortChange = { clear: true };
      } else {
        const parsed = parseWsPort(body.wsPort);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
          return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
        }
        if (typeof parsed === 'number') wsPortChange = { set: parsed };
      }
    }

    const urlChanged = newUrl !== undefined && newUrl !== currentUrl;
    if (newUrl !== undefined && state.masters.has(newUrl) && newUrl !== currentUrl) {
      return NextResponse.json(
        { error: `Master already exists at ${newUrl}` },
        { status: 409, headers: cors },
      );
    }

    const portChanged =
      ('set' in wsPortChange && wsPortChange.set !== m.wsPort) ||
      ('clear' in wsPortChange && m.wsPort !== undefined);

    // Connection-affecting changes need a reconnect. Tear down first.
    const needsReconnect = urlChanged || portChanged;
    if (needsReconnect) disconnectMaster(m);

    if (authToken !== undefined) m.authToken = authToken;
    if ('set' in wsPortChange) m.wsPort = wsPortChange.set;
    if ('clear' in wsPortChange) m.wsPort = undefined;

    if (urlChanged && newUrl) {
      rekeyMaster(currentUrl, newUrl);
    }

    saveConfig();

    if (needsReconnect) connectMaster(m);

    return NextResponse.json(
      { master: masterPayload(m), urlChanged, portChanged },
      { headers: cors },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}
