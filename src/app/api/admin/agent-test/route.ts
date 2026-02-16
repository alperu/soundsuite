import { NextRequest, NextResponse } from 'next/server';

const AGENT_PORT = parseInt(process.env.RERANKER_AGENT_PORT || '8098', 10);

/**
 * POST /api/admin/agent-test
 * Test connectivity to the reranker sidecar agent and get container status.
 * Body: { host: string }
 *
 * `host` is the vLLM reranker host URL (e.g. "http://10.10.20.5:8099").
 * The agent IP is extracted from this URL, using AGENT_PORT (default 8098).
 */
export async function POST(request: NextRequest) {
  try {
    const { host } = (await request.json()) as { host: string };

    if (!host) {
      return NextResponse.json({ valid: false, error: 'Reranker host URL is required' }, { status: 400 });
    }

    let ip: string;
    try {
      ip = new URL(host).hostname;
    } catch {
      return NextResponse.json({ valid: false, error: 'Invalid host URL' }, { status: 400 });
    }

    const agentBase = `http://${ip}:${AGENT_PORT}`;

    // Step 1: Test agent connectivity
    let agentUptime: number;
    try {
      const healthRes = await fetch(`${agentBase}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!healthRes.ok) {
        return NextResponse.json({
          valid: false,
          error: `Agent returned ${healthRes.status}. Is the sidecar agent running on port ${AGENT_PORT}?`,
        });
      }
      const healthData = await healthRes.json();
      agentUptime = healthData.uptime || 0;
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return NextResponse.json({
          valid: false,
          error: `Connection refused at ${agentBase}. Run "sideCar/scripts/start-docker-agent.bat" on the GPU machine.`,
        });
      }
      if (msg.includes('TimeoutError') || msg.includes('aborted')) {
        return NextResponse.json({
          valid: false,
          error: `Timed out connecting to ${agentBase}`,
        });
      }
      return NextResponse.json({ valid: false, error: msg.slice(0, 300) });
    }

    // Step 2: Get full status (includes container info)
    let containerStatus = 'unknown';
    let containerName = 'vllm-reranker';
    try {
      const statusRes = await fetch(`${agentBase}/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        containerStatus = statusData.container?.status || 'unknown';
        containerName = statusData.containerName || containerName;
      }
    } catch {
      containerStatus = 'error';
    }

    return NextResponse.json({
      valid: true,
      agentUptime,
      containerName,
      containerStatus,
      agentUrl: agentBase,
      message:
        containerStatus === 'running'
          ? `Agent connected (uptime ${agentUptime}s). Container "${containerName}" is running.`
          : containerStatus === 'exited'
          ? `Agent connected (uptime ${agentUptime}s). Container "${containerName}" is stopped (will auto-start on next search).`
          : containerStatus === 'not_found'
          ? `Agent connected (uptime ${agentUptime}s). Container "${containerName}" not found — run start-reranker script first.`
          : `Agent connected (uptime ${agentUptime}s). Container "${containerName}" status: ${containerStatus}.`,
    });
  } catch (error: any) {
    return NextResponse.json(
      { valid: false, error: (error?.message || String(error)).slice(0, 300) },
      { status: 500 },
    );
  }
}
