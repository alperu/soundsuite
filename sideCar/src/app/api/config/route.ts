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

    const rolesNowOptOut: string[] = [];
    if (body.minOnline && typeof body.minOnline === 'object') {
      for (const [key, value] of Object.entries(body.minOnline as Record<string, unknown>)) {
        if (typeof value === 'number' && value >= 0) {
          const prev = state.minOnline[key];
          state.minOnline[key] = value;
          if (value === 0 && prev !== 0) rolesNowOptOut.push(key);
        }
      }
    }

    state.lastConfigPushAt = Date.now();

    // Auto-stop any role that just transitioned to minOnline=0, provided
    // it has no active requests. The operator policy is "never run" — honour
    // it immediately rather than waiting for the idle timer to expire.
    if (rolesNowOptOut.length > 0) {
      const { stopContainer } = await import('@/lib/docker');
      const { getContainerState } = await import('@/lib/docker');
      for (const role of rolesNowOptOut) {
        const def = state.registry[role];
        if (!def) continue;
        const active = state.perRole[role]?.activeRequests ?? 0;
        if (active > 0) continue; // let in-flight requests finish; idle timer will stop later
        try {
          const cs = await getContainerState(def.containerName);
          if (cs.status === 'running') {
            await stopContainer(def.containerName);
          }
        } catch { /* best-effort */ }
      }
    }

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

    // Per-role vLLM --gpu-memory-utilization (operator-tuned, keyed by short
    // role name). Applied onto the existing registry entry's vllmArgs so the
    // container restarts with the operator value. WS path (ws-client.ts) does
    // the same after resolveMode(); this covers the HTTP-poll fallback.
    if (body.gpuMemUtils && typeof body.gpuMemUtils === 'object') {
      const { withGpuMemUtil } = await import('@/lib/mode-templates');
      for (const [role, val] of Object.entries(body.gpuMemUtils as Record<string, unknown>)) {
        const def = state.registry[role];
        if (def && def.type === 'vllm' && typeof val === 'number') {
          def.vllmArgs = withGpuMemUtil(def.vllmArgs, val);
        }
      }
    }

    // Reranker --enforce-eager toggle (off = CUDA graphs + torch.compile).
    if (typeof body.rerankEnforceEager === 'boolean') {
      const { withBoolFlag } = await import('@/lib/mode-templates');
      const def = state.registry['reranker'];
      if (def && def.type === 'vllm') {
        def.vllmArgs = withBoolFlag(def.vllmArgs, '--enforce-eager', body.rerankEnforceEager);
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
