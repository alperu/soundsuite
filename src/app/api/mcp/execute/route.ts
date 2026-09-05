import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { deriveSessionId, recordActivity } from '@/lib/admin/session-store';
import { parseProfile } from '@/lib/mcp/research-types';
import { enforceProvider, McpError } from '@/lib/mcp/llm-policy';
import {
  classifyOrigin,
  decideExecuteAuth,
  extractCredential,
  loadMcpApiKeys,
  parseStrictLoopback,
  parseTrustProxy,
} from '@/lib/mcp/execute-auth';
import type { ToolExecutionContext } from '@/lib/mcp/tool-types';

/**
 * API route for executing MCP tools from the Dashboard and the stdio bridge.
 * Routes through the ToolRegistry which handles config, readiness, rate-limiting and logging.
 *
 * `profile` selects the MCP policy (docs/tasks/06-mcp-two-profiles.md). A
 * missing or malformed value is `local` (fail-closed) — unlike the tools
 * listing, where a missing profile means "no filter". The dashboard sends
 * `profile: 'routed'` explicitly so its provider picker keeps working.
 *
 * Two gates run before the registry (report v4, stream C):
 *  - Authentication (`execute-auth.ts`): loopback stays open by default,
 *    non-loopback callers must present a configured API key.
 *  - The LLM policy, applied to the **raw** request fields: a `local` call
 *    naming a non-Ollama provider is refused with 403 `POLICY_VIOLATION`
 *    whether or not a `model` accompanied it (N-6). The registry's own
 *    `enforceProvider` on the context overlay stays as defence in depth.
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

    // --- Authentication (N-9 / M-5) — before any request validation, so an
    // unauthenticated caller learns nothing about the request shape. -------
    const origin = classifyOrigin({
      urlHostname: request.nextUrl?.hostname,
      hostHeader: request.headers.get('host'),
      forwardedFor: request.headers.get('x-forwarded-for'),
      realIp: request.headers.get('x-real-ip'),
      forwarded: request.headers.get('forwarded'),
      // M-5: without a declared proxy, an extra XFF hop / X-Real-IP /
      // Forwarded can no longer establish loopback. See classifyOrigin for
      // what that does and does not close.
      trustProxy: parseTrustProxy(process.env.MCP_TRUST_PROXY),
    });
    const auth = decideExecuteAuth({
      origin,
      modeRaw: process.env.MCP_AUTH_MODE,
      keys: await loadMcpApiKeys(),
      credential: extractCredential({
        authorization: request.headers.get('authorization'),
        apiKey: request.headers.get('x-api-key'),
      }),
      strictLoopback: parseStrictLoopback(process.env.MCP_AUTH_STRICT_LOOPBACK),
      profile,
    });
    if (!auth.ok) {
      console.warn(
        `[MCP Execute] auth refused: ${auth.code} origin=${auth.origin} mode=${auth.mode} tool=${tool} profile=${profile}`,
      );
      return NextResponse.json(
        { error: { code: auth.code, message: auth.message } },
        { status: auth.status ?? 401 },
      );
    }

    if (!tool || typeof tool !== 'string') {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'Missing or invalid tool name' } },
        { status: 400 },
      );
    }

    // --- LLM policy on the raw request fields (N-6) ----------------------
    // `contextOverride` below only carries `aiProvider` when a `model` came
    // with it, so enforcing on the overlay let `provider` alone slip through
    // and run locally with a 200. Enforce on what the caller actually sent.
    try {
      enforceProvider(profile, provider);
    } catch (err) {
      if (err instanceof McpError) {
        return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: 403 });
      }
      throw err;
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
