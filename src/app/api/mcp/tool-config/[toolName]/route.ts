import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

/**
 * GET /api/mcp/tool-config/[toolName] — config for a specific tool
 * PUT /api/mcp/tool-config/[toolName] — update config for a specific tool
 */

interface Params {
  params: Promise<{ toolName: string }>;
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const { toolName } = await params;
    const registry = await getToolRegistry();
    const tool = registry.getTool(toolName);
    if (!tool) {
      return NextResponse.json(
        { error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${toolName}` } },
        { status: 404 },
      );
    }
    return NextResponse.json(tool.config);
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'FETCH_FAILED', message: error instanceof Error ? error.message : 'Failed' } },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { toolName } = await params;
    const body = await request.json();
    const registry = await getToolRegistry();

    const tool = registry.getTool(toolName);
    if (!tool) {
      return NextResponse.json(
        { error: { code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${toolName}` } },
        { status: 404 },
      );
    }

    await registry.updateToolConfig(toolName, body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'UPDATE_FAILED', message: error instanceof Error ? error.message : 'Failed' } },
      { status: 500 },
    );
  }
}
