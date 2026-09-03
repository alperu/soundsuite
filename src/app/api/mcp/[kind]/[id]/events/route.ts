import { NextRequest, NextResponse } from 'next/server';
import {
  getJobStatus,
  isJobFinished,
  parseJobKind,
  readEvents,
  subscribe,
} from '@/lib/mcp/research-jobs';
import type { ResearchJobEvent } from '@/lib/mcp/research-types';

/**
 * GET /api/mcp/{research|report}/:id/events?from=N
 *
 * NDJSON: replays every event with seq >= `from`, then tails live events
 * until the job reaches a terminal status or the client disconnects. Same
 * writer discipline as /api/search/deep (safeClose + abort listener).
 */

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ kind: string; id: string }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  const params = await ctx.params;
  const kind = parseJobKind(params.kind);
  if (!kind) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'kind must be "research" or "report"' } }, { status: 404 });
  }
  const status = getJobStatus(params.id);
  if (!status || status.kind !== kind) {
    return NextResponse.json({ error: { code: 'NOT_FOUND', message: `No ${kind} job "${params.id}"` } }, { status: 404 });
  }

  const rawFrom = Number(request.nextUrl.searchParams.get('from') ?? '0');
  const from = Number.isFinite(rawFrom) && rawFrom > 0 ? Math.floor(rawFrom) : 0;
  const id = params.id;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => {};
      const safeClose = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        request.signal.removeEventListener('abort', onAbort);
        try { controller.close(); } catch { /* already closed */ }
      };
      const send = (e: ResearchJobEvent) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(e) + '\n')); }
        catch { closed = true; }
      };
      const onAbort = () => safeClose();
      request.signal.addEventListener('abort', onAbort);

      // Replay, then tail. Subscribe BEFORE replaying so nothing emitted in
      // between is lost; dedupe by seq.
      let lastSeq = from - 1;
      const deliver = (e: ResearchJobEvent) => {
        if (e.seq <= lastSeq) return;
        lastSeq = e.seq;
        send(e);
        if (e.type === 'result' || e.type === 'error' || e.type === 'cancelled') safeClose();
      };
      unsubscribe = subscribe(id, deliver);
      for (const e of readEvents(id, from)) deliver(e);

      if (!closed && isJobFinished(id)) safeClose();
    },
    cancel() {
      /* handled by the abort listener */
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
