import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

/**
 * GET /api/mcp/execution-history — paginated execution history
 */
export async function GET(request: NextRequest) {
  try {
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
