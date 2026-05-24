import { NextRequest, NextResponse } from 'next/server';
import { state } from '@/lib/state';
import { getContainerLogs, isDockerAvailable } from '@/lib/docker';

const cors = { 'Access-Control-Allow-Origin': '*' };

/**
 * GET /api/logs?role=<role>&tail=<N>
 *
 * Returns the last N lines of the Docker container's stdout+stderr as plain
 * text JSON ({ logs: "..." }). Resolves the container name from
 * state.registry[role].containerName so the master / sidecar dashboard never
 * needs to guess the container name. tail clamped to [1, 5000], default 200.
 *
 * 400 for unknown role, 503 when Docker isn't reachable, 502 when the daemon
 * returns a non-2xx.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const role = url.searchParams.get('role');
  const tail = Math.max(1, Math.min(parseInt(url.searchParams.get('tail') || '200', 10) || 200, 5000));

  if (!role) {
    return NextResponse.json({ error: 'role query param is required' }, { status: 400, headers: cors });
  }
  const def = state.registry[role];
  if (!def) {
    return NextResponse.json({ error: `Unknown role: ${role}` }, { status: 400, headers: cors });
  }
  // host / docker-model-runner runtimes have no sidecar-managed container —
  // logs come from the host process (Ollama / DMR scheduler), not from us.
  if (def.runtime === 'host' || def.runtime === 'docker-model-runner') {
    return NextResponse.json({
      role,
      runtime: def.runtime,
      logs: `No container logs available — ${role} runs via ${def.runtime}. Check the host process directly.`,
    }, { headers: cors });
  }
  if (!isDockerAvailable()) {
    return NextResponse.json({ error: 'Docker is not reachable from this sidecar' }, { status: 503, headers: cors });
  }
  try {
    const { status, text } = await getContainerLogs(def.containerName, tail);
    if (status >= 400) {
      return NextResponse.json({ error: `docker logs HTTP ${status}`, body: text }, { status: 502, headers: cors });
    }
    return NextResponse.json({ role, containerName: def.containerName, tail, logs: text }, { headers: cors });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500, headers: cors });
  }
}
