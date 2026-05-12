import { NextRequest, NextResponse } from 'next/server';
import { getAllContainerStates } from '@/lib/containers';
import { handleStart, handleStop, handlePullModel, handleLoadModel } from '@/lib/handlers';

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
      if (!role) return NextResponse.json({ error: 'role is required' }, { status: 400, headers: cors });
      const result = await handleLoadModel(role);
      const isNotFound = result.error && /^unknown role:/i.test(String(result.error));
      const status = result.error ? (isNotFound ? 404 : 500) : 200;
      return NextResponse.json(result, { status, headers: cors });
    }

    if (action === 'pullModel' || action === 'pullAndLoad') {
      if (!role) return NextResponse.json({ error: 'role is required' }, { status: 400, headers: cors });
      const andLoad = action === 'pullAndLoad';
      const result = await handlePullModel(role, andLoad);
      const isNotFound = result.error && /^unknown role:/i.test(String(result.error));
      const status = result.error ? (isNotFound ? 404 : 500) : 200;
      return NextResponse.json(result, { status, headers: cors });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400, headers: cors });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: cors },
    );
  }
}
