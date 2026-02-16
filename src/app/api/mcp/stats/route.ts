import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

/**
 * GET /api/mcp/stats — aggregated execution statistics
 */
export async function GET(request: NextRequest) {
  try {
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
