import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { deriveSessionId, recordActivity } from '@/lib/admin/session-store';
import { parseProfile } from '@/lib/mcp/research-types';
import type { ToolExecutionContext } from '@/lib/mcp/tool-types';

/**
 * API route for executing MCP tools from the Dashboard and the stdio bridge.
 * Routes through the ToolRegistry which handles config, readiness, rate-limiting and logging.
 *
 * `profile` selects the MCP policy (docs/tasks/06-mcp-two-profiles.md). A
 * missing or malformed value is `local` (fail-closed) — unlike the tools
 * listing, where a missing profile means "no filter". The dashboard sends
 * `profile: 'routed'` explicitly so its provider picker keeps working.
 */

interface ExecuteRequest {
  tool: string;
  params: Record<string, any>;
  provider?: string;
  model?: string;
  profile?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: ExecuteRequest = await request.json();
    const { tool, params, provider, model } = body;
    const profile = parseProfile(body.profile);

    if (!tool || typeof tool !== 'string') {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Missing or invalid tool name' } },
        { status: 400 },
      );
    }

    const headerSessionId = request.headers.get('mcp-session-id');

    // Session capture for the admin Sessions tab — one upsert; bookkeeping
    // failures never block tool execution, but a revoked session is refused.
    try {
      const userAgent = request.headers.get('user-agent') ?? '';
      const ipAddress =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
      const session = await recordActivity({
        sessionId: headerSessionId || deriveSessionId(ipAddress, userAgent),
        source: headerSessionId ? 'mcp' : 'dashboard',
        userAgent,
        ipAddress,
      });
      if (session.revokedAt) {
        return NextResponse.json(
          { error: { code: 'SESSION_REVOKED', message: 'This session has been revoked' } },
          { status: 403 },
        );
      }
    } catch (sessionErr) {
      console.warn('[MCP Execute] session capture failed:', (sessionErr as Error).message);
    }

    if (provider && model) {
      console.log(`[MCP Execute] Provider override via context: ${provider}/${model} for tool=${tool} profile=${profile}`);
    } else {
      console.log(`[MCP Execute] No provider override (provider=${provider}, model=${model}), using auto-select for tool=${tool} profile=${profile}`);
    }

    const registry = await getToolRegistry();
    await registry.refreshDependencies();

    // Pass provider/model through a context overlay so it reaches callLLM()
    // without relying on a module-level global variable (which can be a
    // different module instance under Turbopack/HMR). The registry applies
    // the profile policy on top of this overlay.
    const contextOverride: Partial<ToolExecutionContext> | undefined =
      (provider && model) || headerSessionId
        ? {
            ...(provider && model ? { aiProvider: provider, aiModel: model } : {}),
            ...(headerSessionId ? { sessionId: headerSessionId } : {}),
          }
        : undefined;
    const result = await registry.execute(tool, params || {}, contextOverride, profile);

    if (!result.success) {
      const statusMap: Record<string, number> = {
        TOOL_NOT_FOUND: 404,
        TOOL_NOT_IN_PROFILE: 404,
        TOOL_DISABLED: 403,
        POLICY_VIOLATION: 403,
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
