import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { guardMcpRoute } from '@/lib/mcp/execute-auth';

/**
 * GET  /api/mcp/tool-config — return all tool configs
 * POST /api/mcp/tool-config — bulk update tool configs
 *
 * Both gated (R-1). The write side matters more than the catalogue: it can
 * enable a disabled tool or lift a rate limit.
 */

export async function GET(request?: NextRequest) {
  try {
    const guard = await guardMcpRoute(request, { label: 'ToolConfig' });
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const registry = await getToolRegistry();
    const tools = registry.listTools();
    const configs: Record<string, { enabled: boolean; rateLimitPerMinute: number; settings: Record<string, any> }> = {};
    for (const t of tools) {
      configs[t.metadata.name] = {
        enabled: t.config.enabled,
        rateLimitPerMinute: t.config.rateLimitPerMinute,
        settings: t.config.settings,
      };
    }
    return NextResponse.json(configs);
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'FETCH_FAILED', message: error instanceof Error ? error.message : 'Failed to fetch configs' } },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const guard = await guardMcpRoute(request, { label: 'ToolConfig' });
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const body: Record<string, Partial<{ enabled: boolean; rateLimitPerMinute: number; settings: Record<string, any> }>> = await request.json();
    const registry = await getToolRegistry();
    for (const [toolName, updates] of Object.entries(body)) {
      await registry.updateToolConfig(toolName, updates);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'UPDATE_FAILED', message: error instanceof Error ? error.message : 'Failed to update configs' } },
      { status: 500 },
    );
  }
}
