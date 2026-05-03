import { NextResponse } from 'next/server';
import { state } from '@/lib/state';
import { saveConfig } from '@/lib/config';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body.idleTimeouts && typeof body.idleTimeouts === 'object') {
      for (const [key, value] of Object.entries(body.idleTimeouts)) {
        if (typeof value === 'number') {
          state.idleTimeouts[key] = value;
        }
      }
    }

    if (body.minOnline && typeof body.minOnline === 'object') {
      for (const [key, value] of Object.entries(body.minOnline as Record<string, unknown>)) {
        if (typeof value === 'number' && value >= 0) {
          state.minOnline[key] = value;
        }
      }
    }

    state.lastConfigPushAt = Date.now();

    if (typeof body.idleTimeoutMs === 'number') {
      state.IDLE_TIMEOUT_MS = body.idleTimeoutMs;
      state.idleTimeouts.reranker = body.idleTimeoutMs;
    }

    if (typeof body.containerName === 'string') {
      state.CONTAINER_NAME = body.containerName;
    }

    if (body.registry && typeof body.registry === 'object') {
      for (const [role, overrides] of Object.entries(body.registry as Record<string, unknown>)) {
        if (state.registry[role]) {
          Object.assign(state.registry[role], overrides);
        }
      }
    }

    saveConfig();

    return NextResponse.json(
      { ok: true, idleTimeouts: state.idleTimeouts, containerName: state.CONTAINER_NAME },
      { headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
