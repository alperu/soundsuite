import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { parseProfileStrict } from '@/lib/mcp/research-types';
import { guardMcpRoute } from '@/lib/mcp/execute-auth';

/**
 * GET /api/mcp/claude-tools?variant=regex&eager=query_case_knowledge,scan_for_pattern
 *
 * Returns MCP tools formatted for Claude API's tool search feature.
 * Includes the tool search tool definition + all enabled MCP tools with defer_loading.
 *
 * Query params:
 *   variant  - "regex" (default) or "bm25" — which tool search variant to use
 *   eager    - comma-separated tool names to keep non-deferred (loaded immediately)
 *
 * Usage: Pass the returned `tools` array directly to Claude's Messages API
 * with beta header "advanced-tool-use-2025-11-20".
 *
 * Response:
 * {
 *   beta: "advanced-tool-use-2025-11-20",
 *   tools: [ { type: "tool_search_tool_...", name: "..." }, { name: "...", defer_loading: true, ... } ]
 * }
 */
export async function GET(request: NextRequest) {
  try {
    // Same gate as /api/mcp/tools — this is the same catalogue in another
    // shape, so it cannot be the unlocked door next to the locked one (R-1).
    const guard = await guardMcpRoute(request, { label: 'ClaudeTools' });
    if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

    const variant = request.nextUrl.searchParams.get('variant') || 'regex';
    const eagerParam = request.nextUrl.searchParams.get('eager') || '';
    const eagerSet = new Set(eagerParam.split(',').map(s => s.trim()).filter(Boolean));

    if (variant !== 'regex' && variant !== 'bm25') {
      return NextResponse.json(
        { error: { code: 'INVALID_PARAM', message: 'variant must be "regex" or "bm25"' } },
        { status: 400 },
      );
    }

    // `?profile=` filters like /api/mcp/tools: missing = `local`,
    // `all` = every tool (dashboard-only), anything else = 400.
    const rawProfile = request.nextUrl.searchParams.get('profile');
    const profile = parseProfileStrict(rawProfile);
    if (profile === null) {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_PROFILE',
            message: `Unknown profile "${rawProfile}". Expected "local", "routed" or "all".`,
          },
        },
        { status: 400 },
      );
    }

    const registry = await getToolRegistry();
    const allTools = registry
      .listTools(profile === 'all' ? undefined : profile)
      .filter(t => t.config.enabled);

    // Tool search tool definition
    const searchToolType = variant === 'regex'
      ? 'tool_search_tool_regex_20251119'
      : 'tool_search_tool_bm25_20251119';
    const searchToolName = variant === 'regex'
      ? 'tool_search_tool_regex'
      : 'tool_search_tool_bm25';

    const tools: any[] = [
      { type: searchToolType, name: searchToolName },
    ];

    // Convert MCP tools to Claude API format
    for (const t of allTools) {
      const isEager = eagerSet.has(t.metadata.name);
      const toolDef: any = {
        name: t.metadata.name,
        description: `[${t.metadata.category}] ${t.metadata.description}`,
        input_schema: t.metadata.inputSchema,
      };
      if (!isEager) {
        toolDef.defer_loading = true;
      }
      tools.push(toolDef);
    }

    // If no eager tools specified, keep the first 3 most commonly used non-deferred
    if (eagerSet.size === 0 && allTools.length > 3) {
      const sorted = [...allTools].sort((a, b) =>
        (b.stats.totalExecutions || 0) - (a.stats.totalExecutions || 0)
      );
      const topNames = new Set(sorted.slice(0, 3).map(t => t.metadata.name));
      for (const tool of tools) {
        if (tool.name && topNames.has(tool.name)) {
          delete tool.defer_loading;
        }
      }
    }

    return NextResponse.json({
      ...(profile ? { profile } : {}),
      beta: 'advanced-tool-use-2025-11-20',
      model: 'claude-opus-5',
      tools,
      tool_count: allTools.length,
      eager_count: tools.filter(t => !t.defer_loading && !t.type?.startsWith('tool_search')).length,
      deferred_count: tools.filter(t => t.defer_loading).length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: 'FETCH_FAILED', message: error instanceof Error ? error.message : 'Failed to build tool list' } },
      { status: 500 },
    );
  }
}
