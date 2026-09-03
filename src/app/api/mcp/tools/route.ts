import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';
import { parseProfile } from '@/lib/mcp/research-types';
import { profilePolicyDescription, providersAllowed } from '@/lib/mcp/llm-policy';

/**
 * API route for listing available MCP tools.
 * Returns full tool metadata including category, version, dependencies, readiness.
 *
 * `?profile=local|routed` filters the list to that profile and stamps the
 * response with `{ profile, policy, providersAllowed }` (the bridge sends it).
 *
 * Profile asymmetry — deliberate:
 *   - Here, a MISSING `profile` means "no filter": the dashboard's MCP tool
 *     manager calls this endpoint bare and must keep seeing every tool.
 *   - On POST /api/mcp/execute a missing `profile` means `local`
 *     (fail-closed): listing is harmless, executing is not.
 * A PRESENT but malformed value is parsed fail-closed to `local` in both.
 */

export async function GET(request?: NextRequest) {
  try {
    const rawProfile = request?.nextUrl?.searchParams.get('profile') ?? null;
    const profile = rawProfile === null ? undefined : parseProfile(rawProfile);

    const registry = await getToolRegistry();
    await registry.refreshDependencies();
    const tools = registry.listTools(profile);

    if (!profile) {
      return NextResponse.json({ tools });
    }
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
