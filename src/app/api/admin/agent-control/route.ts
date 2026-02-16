import { NextRequest, NextResponse } from 'next/server';

const AGENT_PORT = parseInt(process.env.RERANKER_AGENT_PORT || '8098', 10);

/**
 * POST /api/admin/agent-control
 * Start or stop the reranker container via the sidecar agent.
 * Body: { host: string, action: 'start' | 'stop' | 'status' }
 */
export async function POST(request: NextRequest) {
  try {
    const { host, action } = (await request.json()) as {
      host: string;
      action: 'start' | 'stop' | 'status';
    };

    if (!host) {
      return NextResponse.json({ error: 'Reranker host URL is required' }, { status: 400 });
    }
    if (!['start', 'stop', 'status'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    let ip: string;
    try {
      ip = new URL(host).hostname;
    } catch {
      return NextResponse.json({ error: 'Invalid host URL' }, { status: 400 });
    }

    const agentBase = `http://${ip}:${AGENT_PORT}`;

    if (action === 'status') {
      try {
        const res = await fetch(`${agentBase}/status`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          return NextResponse.json({ status: 'error', error: `Agent returned ${res.status}` });
        }
        const data = await res.json();
        return NextResponse.json({ status: data.container?.status || 'unknown' });
      } catch {
        return NextResponse.json({ status: 'error', error: 'Cannot connect to agent' });
      }
    }

    if (action === 'start') {
      try {
        const res = await fetch(`${agentBase}/start`, {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
        });
        const data = await res.json();
        if (data.error) {
          return NextResponse.json({ error: data.error }, { status: res.status === 404 ? 404 : 500 });
        }
        return NextResponse.json(data);
      } catch (err: any) {
        return NextResponse.json(
          { error: `Cannot connect to agent: ${(err?.message || '').slice(0, 200)}` },
          { status: 502 },
        );
      }
    }

    if (action === 'stop') {
      try {
        const res = await fetch(`${agentBase}/stop`, {
          method: 'POST',
          signal: AbortSignal.timeout(30_000),
        });
        const data = await res.json();
        if (data.error) {
          return NextResponse.json({ error: data.error }, { status: 500 });
        }
        return NextResponse.json(data);
      } catch (err: any) {
        return NextResponse.json(
          { error: `Cannot connect to agent: ${(err?.message || '').slice(0, 200)}` },
          { status: 502 },
        );
      }
    }
  } catch (error: any) {
    const msg = error?.message || String(error);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
  }
}
