import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

/**
 * API route for executing MCP tools from the Dashboard.
 * Routes through the ToolRegistry which handles config, readiness, rate-limiting and logging.
 */

interface ExecuteRequest {
  tool: string;
  params: Record<string, any>;
  provider?: string;
  model?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: ExecuteRequest = await request.json();
    const { tool, params, provider, model } = body;

    if (!tool || typeof tool !== 'string') {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Missing or invalid tool name' } },
        { status: 400 },
      );
    }

    if (provider && model) {
      console.log(`[MCP Execute] Provider override via context: ${provider}/${model} for tool=${tool}`);
    } else {
      console.log(`[MCP Execute] No provider override (provider=${provider}, model=${model}), using auto-select for tool=${tool}`);
    }

    const registry = await getToolRegistry();
    await registry.refreshDependencies();

    // Pass provider/model through a context overlay so it reaches callLLM()
    // without relying on a module-level global variable (which can be a
    // different module instance under Turbopack/HMR).
    const contextOverride = (provider && model)
      ? { aiProvider: provider, aiModel: model }
      : undefined;
    const result = await registry.execute(tool, params || {}, contextOverride);

    if (!result.success) {
      const statusMap: Record<string, number> = {
        TOOL_NOT_FOUND: 404,
        TOOL_DISABLED: 403,
        TOOL_NOT_READY: 503,
        RATE_LIMITED: 429,
        INVALID_PARAMS: 400,
        INVALID_REGEX: 400,
        NOT_IMPLEMENTED: 501,
      };
      const status = statusMap[result.errorCode || ''] || 500;
      return NextResponse.json(
        { error: { code: result.errorCode || 'EXECUTION_FAILED', message: result.error } },
        { status },
      );
    }

    return NextResponse.json(result.data);
  } catch (error) {
    console.error('Error executing MCP tool:', error);
    return NextResponse.json(
      { error: { code: 'EXECUTION_FAILED', message: error instanceof Error ? error.message : 'Failed to execute tool' } },
      { status: 500 },
    );
  }
}
