import { NextRequest, NextResponse } from 'next/server';
import { getAllContainerStates, loadGpuOnly } from '@/lib/containers';
import { handleStart, handleStop, pullOllamaModelAsync } from '@/lib/handlers';
import { ollamaLoad } from '@/lib/ollama-api';
import { state } from '@/lib/state';

const cors = { 'Access-Control-Allow-Origin': '*' };

export async function GET() {
  try {
    const containers = await getAllContainerStates();
    return NextResponse.json({ containers }, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, role } = body;

    if (action === 'start') {
      const result = await handleStart(role);
      // 404 = unknown role; 502 = provisioning failed (pull/create/probe)
      const isNotFound = result.error && (/^unknown role:/i.test(String(result.error)) || /not found/i.test(String(result.error)));
      const status = result.error ? (isNotFound ? 404 : 502) : 200;
      return NextResponse.json(result, { status, headers: cors });
    }

    if (action === 'stop') {
      const result = await handleStop(role);
      const isNotFound = result.error && (/^unknown role:/i.test(String(result.error)) || /not found/i.test(String(result.error)));
      const status = result.error ? (isNotFound ? 404 : 502) : 200;
      return NextResponse.json(result, { status, headers: cors });
    }

    if (action === 'loadModel') {
      const def = state.registry[role];
      if (!def) return NextResponse.json({ error: `Unknown role: ${role}` }, { status: 400, headers: cors });
      if (def.type !== 'ollama' || !def.model) return NextResponse.json({ error: `${role} is not an Ollama container with a model` }, { status: 400, headers: cors });
      const loaded = def.gpuOnly
        ? await loadGpuOnly(role)
        : await ollamaLoad(def.port, def.model);
      if (!loaded) {
        const reason = def.gpuOnly
          ? `Failed to load ${def.model} fully on GPU (insufficient VRAM after eviction)`
          : `Failed to load ${def.model} into VRAM`;
        return NextResponse.json({ error: reason }, { status: 500, headers: cors });
      }
      return NextResponse.json({ ok: true, message: `${def.model} loaded into VRAM${def.gpuOnly ? ' (full GPU)' : ''}` }, { headers: cors });
    }

    if (action === 'pullModel' || action === 'pullAndLoad') {
      const def = state.registry[role];
      if (!def) return NextResponse.json({ error: `Unknown role: ${role}` }, { status: 400, headers: cors });
      if (def.type !== 'ollama' || !def.model) return NextResponse.json({ error: `${role} is not an Ollama container with a model` }, { status: 400, headers: cors });

      const andLoad = action === 'pullAndLoad';
      pullOllamaModelAsync(role, andLoad);

      return NextResponse.json({ ok: true, message: `Pull${andLoad ? ' + load' : ''} started for ${def.model}` }, { headers: cors });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400, headers: cors });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}
