import { NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

/**
 * GET /api/mcp/tool-health — readiness status for all tools
 */
export async function GET() {
  try {
    const registry = await getToolRegistry();
    await registry.refreshDependencies();
    const tools = registry.listTools();
    const health = tools.map(t => ({
      name: t.metadata.name,
      ready: t.ready,
      reasons: t.readyReasons,
      dependencies: t.dependencies,
    }));
    // Readiness after hysteresis (N-4): when a smoke has failed but the
    // last-known-good value is still being served, `ollama.degraded` is true
    // and `ollama.pendingReason` names the failure — the tools below stay
    // ready on purpose rather than flapping out of `tools/list`.
    const ollama = registry.getOllamaReadiness();
    return NextResponse.json({ tools: health, ollama });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'HEALTH_CHECK_FAILED', message: error instanceof Error ? error.message : 'Failed' } },
      { status: 500 },
    );
  }
}
