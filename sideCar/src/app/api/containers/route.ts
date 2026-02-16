import { NextRequest, NextResponse } from 'next/server';
import { getAllContainerStates } from '@/lib/containers';
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
      const status = result.error ? 404 : 200;
      return NextResponse.json(result, { status, headers: cors });
    }

    if (action === 'stop') {
      const result = await handleStop(role);
      const status = result.error ? 404 : 200;
      return NextResponse.json(result, { status, headers: cors });
    }

    if (action === 'loadModel') {
      const def = state.registry[role];
      if (!def) return NextResponse.json({ error: `Unknown role: ${role}` }, { status: 400, headers: cors });
      if (def.type !== 'ollama' || !def.model) return NextResponse.json({ error: `${role} is not an Ollama container with a model` }, { status: 400, headers: cors });
      const loaded = await ollamaLoad(def.port, def.model);
      if (!loaded) return NextResponse.json({ error: `Failed to load ${def.model} into VRAM` }, { status: 500, headers: cors });
      return NextResponse.json({ ok: true, message: `${def.model} loaded into VRAM` }, { headers: cors });
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
