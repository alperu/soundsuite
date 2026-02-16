import { NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

/**
 * API route for listing available MCP tools.
 * Returns full tool metadata including category, version, dependencies, readiness.
 */

export async function GET() {
  try {
    const registry = await getToolRegistry();
    await registry.refreshDependencies();
    const tools = registry.listTools();
    return NextResponse.json({ tools });
  } catch (error) {
    console.error('Error fetching MCP tools:', error);
    return NextResponse.json(
      {
        error: {
          code: 'FETCH_FAILED',
          message: error instanceof Error ? error.message : 'Failed to fetch tools',
        },
      },
      { status: 500 },
    );
  }
}
