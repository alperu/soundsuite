import { NextRequest, NextResponse } from 'next/server';
import { listJobs, parseJobKind } from '@/lib/mcp/research-jobs';
import { parseProfile } from '@/lib/mcp/research-types';
import { McpError } from '@/lib/mcp/llm-policy';
import { startResearchJob } from '@/lib/mcp/research/start-research-job';
import { startReportJob } from '@/lib/mcp/routed/start-report-job';
import { guardMcpRoute } from '@/lib/mcp/execute-auth';

/**
 * /api/mcp/{research|report}
 *
 * POST — start a job. Placeholder until the research/report tools wire it:
 *        TODO(local-stream / routed-stream): replace the 501 body with a call
 *        to `startJob({ kind, profile, query, sessionId, run })` that invokes
 *        gatherEvidence() (research) or the report pipeline (report).
 * GET  — list jobs (optionally scoped to the `mcp-session-id` header).
 *
 * Routing note: Next.js resolves static segments before dynamic ones, so this
 * `[kind]` folder never shadows the sibling static routes (tools, execute,
 * stats, tool-config, claude-tools, execution-history, tool-health, local,
 * routed). `kind` is validated to research|report; anything else is 404.
 */

type Ctx = { params: Promise<{ kind: string }> };

function invalidKind() {
  return NextResponse.json(
    { error: { code: 'NOT_FOUND', message: 'kind must be "research" or "report"' } },
    { status: 404 },
  );
}

export async function POST(request: NextRequest, ctx: Ctx) {
  const params = await ctx.params;

  // Auth first — starting a job is the most expensive thing on this surface
  // (a routed report spends API credit and sends case text to a third party).
  // The body is read before the gate only to learn the profile, so
  // MCP_AUTH_STRICT_LOOPBACK=routed can apply; nothing acts on it yet.
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* empty body */ }
  const profile = parseProfile(body.profile);
  const guard = await guardMcpRoute(request, { profile, label: 'Job' });
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

  const kind = parseJobKind(params.kind);
  if (!kind) return invalidKind();

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) {
    return NextResponse.json({ error: { code: 'INVALID_PARAMS', message: 'query is required' } }, { status: 400 });
  }

  // `report` jobs spend API credit and send case text to a third party, so
  // they are only ever started under the routed profile. Missing profile →
  // local (fail-closed), which refuses `report`.
  if (kind === 'report' && profile !== 'routed') {
    return NextResponse.json(
      { error: { code: 'POLICY_VIOLATION', message: 'report jobs require profile "routed"' } },
      { status: 403 },
    );
  }

  const sessionId = request.headers.get('mcp-session-id') ?? undefined;
  const { query: _q, profile: _p, ...rest } = body;
  const input = { query, profile, sessionId, params: rest };

  try {
    const job = kind === 'research' ? await startResearchJob(input) : await startReportJob(input);
    return NextResponse.json(job, { status: 202 });
  } catch (err) {
    if (err instanceof McpError) {
      const status = err.code === 'NOT_IMPLEMENTED' ? 501 : err.code === 'POLICY_VIOLATION' ? 403 : 400;
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status });
    }
    return NextResponse.json(
      { error: { code: 'EXECUTION_FAILED', message: err instanceof Error ? err.message : 'failed to start job' } },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const guard = await guardMcpRoute(request, { label: 'Job' });
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status });

  const params = await ctx.params;
  const kind = parseJobKind(params.kind);
  if (!kind) return invalidKind();

  const sessionId = request.headers.get('mcp-session-id') ?? undefined;
  const scoped = request.nextUrl.searchParams.get('all') === '1' ? undefined : sessionId;
  const jobs = listJobs(scoped).filter((j) => j.kind === kind);
  return NextResponse.json({ kind, jobs });
}
