import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { guardMcpRoute } from '@/lib/mcp/execute-auth';

/**
 * GET /api/mcp/execution-history — paginated execution history
 *
 * Gated (R-1) and the most sensitive of the listing routes: the records carry
 * the parameters tools were called with, i.e. real queries over case data.
 */
export async function GET(request: NextRequest) {
  try {
    const guard = await guardMcpRoute(request, { label: 'ExecutionHistory' });
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const { searchParams } = request.nextUrl;
    const toolName = searchParams.get('toolName') || undefined;
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const registry = await getToolRegistry();
    const records = registry.getRecentRecords(toolName, limit);
    return NextResponse.json({ records });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'HISTORY_FAILED', message: error instanceof Error ? error.message : 'Failed' } },
      { status: 500 },
    );
  }
}
