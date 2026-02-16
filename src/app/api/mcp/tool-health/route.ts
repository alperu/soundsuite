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
    return NextResponse.json({ tools: health });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'HEALTH_CHECK_FAILED', message: error instanceof Error ? error.message : 'Failed' } },
      { status: 500 },
    );
  }
}
