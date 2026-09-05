import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { guardMcpRoute } from '@/lib/mcp/execute-auth';

/**
 * GET /api/mcp/stats — aggregated execution statistics
 *
 * Gated with the catalogue (R-1): usage telemetry is not public.
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await guardMcpRoute(request, { label: 'Stats' });
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const toolName = request.nextUrl.searchParams.get('toolName') || undefined;
    const registry = await getToolRegistry();
    const stats = registry.getStats(toolName);
    return NextResponse.json(stats);
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'STATS_FAILED', message: error instanceof Error ? error.message : 'Failed' } },
      { status: 500 },
    );
  }
}
