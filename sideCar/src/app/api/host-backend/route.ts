import { NextRequest, NextResponse } from 'next/server';
import { persistAndApplyBackend, type HostBackendPatch } from '@/lib/setup-overrides';
import { state } from '@/lib/state';

const cors = { 'Access-Control-Allow-Origin': '*' };

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;

    const patch: HostBackendPatch = {};
    if (typeof body.hostOllamaEnabled === 'boolean') patch.hostOllamaEnabled = body.hostOllamaEnabled;
    if (Array.isArray(body.hostOllamaRoles)) {
      patch.hostOllamaRoles = body.hostOllamaRoles.filter((s): s is string => typeof s === 'string');
    }
    if (typeof body.hostOllamaBudgetMb === 'number' && body.hostOllamaBudgetMb >= 0) {
      patch.hostOllamaBudgetMb = body.hostOllamaBudgetMb;
    }
    if (typeof body.dmrEnabled === 'boolean') patch.dmrEnabled = body.dmrEnabled;
    if (Array.isArray(body.dmrRoles)) {
      patch.dmrRoles = body.dmrRoles.filter((s): s is string => typeof s === 'string');
    }

    persistAndApplyBackend(patch);

    // Kick the host-ollama watchdog if newly enabled. Cheap; idempotent.
    try {
      if (state.hostOllamaEnabled) {
        const { startHostOllamaWatchdog } = await import('@/lib/host-ollama-watchdog');
        startHostOllamaWatchdog();
      }
    } catch { /* watchdog start failures are not fatal */ }

    return NextResponse.json(
      {
        ok: true,
        hostOllama: {
          enabled: state.hostOllamaEnabled,
          roles: Array.from(state.hostOllamaRoles),
          budgetMb: state.hostOllamaBudgetMb,
        },
        dmr: {
          enabled: state.dmrEnabled,
          roles: Array.from(state.dmrRoles),
        },
      },
      { headers: cors },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500, headers: cors });
  }
}
