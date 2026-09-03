import { NextRequest, NextResponse } from 'next/server';
import { cancelJob, getJobStatus, parseJobKind } from '@/lib/mcp/research-jobs';

/**
 * /api/mcp/{research|report}/:id
 *
 * GET    — job status; `?cursor=N` returns only evidence with index >= N and
 *          the new cursor to pass back next time.
 * DELETE — cancel (aborts the job's signal).
 */

type Ctx = { params: Promise<{ kind: string; id: string }> };

function notFound(message: string) {
  return NextResponse.json({ error: { code: 'NOT_FOUND', message } }, { status: 404 });
}

export async function GET(request: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  const kind = parseJobKind(params.kind);
  if (!kind) return notFound('kind must be "research" or "report"');

  const rawCursor = Number(request.nextUrl.searchParams.get('cursor') ?? '0');
  const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : 0;

  const status = getJobStatus(params.id, cursor);
  if (!status || status.kind !== kind) return notFound(`No ${kind} job "${params.id}"`);
  return NextResponse.json(status);
}

export async function DELETE(_request: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  const kind = parseJobKind(params.kind);
  if (!kind) return notFound('kind must be "research" or "report"');

  const status = getJobStatus(params.id);
  if (!status || status.kind !== kind) return notFound(`No ${kind} job "${params.id}"`);

  const cancelled = cancelJob(params.id);
  return NextResponse.json({ id: params.id, cancelled, status: getJobStatus(params.id)?.status ?? status.status });
}
