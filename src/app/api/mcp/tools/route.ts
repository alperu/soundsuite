import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { parseProfileStrict } from '@/lib/mcp/research-types';
import { profilePolicyDescription, providersAllowed } from '@/lib/mcp/llm-policy';

/**
 * API route for listing available MCP tools.
 * Returns full tool metadata including category, version, dependencies, readiness.
 *
 * `?profile=local|routed` filters the list to that profile and stamps the
 * response with `{ profile, policy, providersAllowed }` (the bridge sends it).
 *
 * Profile handling:
 *   - MISSING `profile` → `local`. Same default as POST /api/mcp/execute, so a
 *     bridge that forgot to send a profile can only ever advertise the local
 *     set (it used to see every tool, which let it advertise `routed` tools).
 *   - `profile=all` → every tool, no policy stamp, `profile: 'all'`. This is
 *     the dashboard's MCP tool manager's explicit opt-in; the bridge never
 *     sends it.
 *   - Any other value → 400 INVALID_PROFILE. Listing rejects rather than
 *     coercing so a typo can't be silently mislabeled as `local`.
 */

export async function GET(request?: NextRequest) {
  try {
    const rawProfile = request?.nextUrl?.searchParams.get('profile') ?? null;
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
    await registry.refreshDependencies();

    if (profile === 'all') {
      return NextResponse.json({ profile: 'all', tools: registry.listTools() });
    }
    const tools = registry.listTools(profile);
    return NextResponse.json({
      profile,
      policy: profilePolicyDescription(profile),
      providersAllowed: providersAllowed(profile),
      tools,
    });
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
