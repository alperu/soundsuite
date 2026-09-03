import { NextRequest, NextResponse } from 'next/server';
import { getJobResult, getJobStatus, parseJobKind } from '@/lib/mcp/research-jobs';

/**
 * GET /api/mcp/{research|report}/:id/result
 *
 * The value the job resolved with (EvidenceResult / ReportResult). 409 while
 * the job is still running, 410 when it errored or was cancelled.
 */

type Ctx = { params: Promise<{ kind: string; id: string }> };

export async function GET(_request: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  const kind = parseJobKind(params.kind);
  if (!kind) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'kind must be "research" or "report"' } }, { status: 404 });
  }

  const status = getJobStatus(params.id);
  if (!status || status.kind !== kind) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: `No ${kind} job "${params.id}"` } }, { status: 404 });
  }

  if (status.status === 'queued' || status.status === 'running') {
    return NextResponse.json(
      { error: { code: 'JOB_RUNNING', message: 'Job has not finished yet', status: status.status, cursor: status.cursor } },
      { status: 409 },
    );
  }
  if (status.status !== 'done') {
    return NextResponse.json(
      { error: { code: status.status === 'cancelled' ? 'JOB_CANCELLED' : 'JOB_FAILED', message: status.error ?? `Job ${status.status}` } },
      { status: 410 },
    );
  }

  return NextResponse.json({ id: params.id, kind, result: getJobResult(params.id) });
}
