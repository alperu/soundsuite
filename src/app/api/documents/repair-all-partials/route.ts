import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import {
  repairDocument,
  listPartialDocumentIds,
  type DocumentRepairResult,
} from '@/lib/ingestion/partial-repair-runner';

const logger = createLogger('repair-all-partials');

/**
 * POST /api/documents/repair-all-partials
 *
 * Streams Server-Sent Events while repairing every partially-indexed
 * document in turn. Streaming rather than a single JSON response because the
 * work is minutes long: a real corpus run took 6 minutes for 16 documents,
 * and one 665-page volume alone needs 41 pages of OCR. A request that only
 * answers at the end looks identical to a hang, which is the exact confusion
 * this feature set has already produced once.
 *
 * Events:
 *   start     { total, documentIds }
 *   document  DocumentRepairResult
 *   done      { totals }
 *   error     { message }
 *
 * Stopping: the runner checks `request.signal` between documents, so the
 * client aborting the fetch stops the run at the next document boundary. It
 * deliberately does not interrupt a document mid-repair — reindex-pages
 * deletes a page's old vectors before inserting new ones, so killing it
 * mid-flight is how you lose coverage rather than gain it.
 */

let inFlight = false;

export async function POST(request: NextRequest) {
  if (inFlight) {
    return new Response(
      JSON.stringify({ error: { message: 'A repair run is already in progress' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }

  let body: { documentIds?: string[]; includeZeroIndexed?: boolean; resetTerminal?: boolean } = {};
  try { body = await request.json(); } catch { /* defaults */ }

  const origin = request.nextUrl.origin;
  const encoder = new TextEncoder();
  inFlight = true;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* client gone */ }
      };

      try {
        const ids = body.documentIds?.length
          ? body.documentIds
          : await listPartialDocumentIds({ baseUrl: origin });

        send('start', { total: ids.length, documentIds: ids });
        logger.info('Repair run starting', { documents: ids.length });

        const results: DocumentRepairResult[] = [];
        for (let i = 0; i < ids.length; i++) {
          if (request.signal.aborted) {
            logger.info('Repair run stopped by client', { completed: i, total: ids.length });
            break;
          }
          const result = await repairDocument(
            {
              baseUrl: origin,
              includeZeroIndexed: body.includeZeroIndexed,
              resetTerminal: body.resetTerminal ?? true,
              shouldStop: () => request.signal.aborted,
            },
            ids[i],
          );
          results.push(result);
          send('document', { ...result, index: i, total: ids.length });
          logger.info('Repair run: document done', {
            documentId: result.documentId, verdict: result.verdict,
            before: result.pagesBefore, after: result.pagesAfter,
            unverified: result.unverified.length,
          });
        }

        send('done', {
          totals: {
            documents: results.length,
            pagesMissingBefore: results.reduce((s, r) => s + r.pagesBefore, 0),
            pagesMissingAfter: results.reduce((s, r) => s + r.pagesAfter, 0),
            pagesRepaired: results.reduce((s, r) => s + r.repaired.length, 0),
            pagesUnverified: results.reduce((s, r) => s + r.unverified.length, 0),
            documentsFixed: results.filter((r) => r.verdict === 'fixed').length,
            documentsNeedingReingest: results.filter((r) => r.verdict === 'needs-reingest').length,
            stopped: request.signal.aborted,
          },
        });
      } catch (error) {
        logger.error('Repair run failed', error);
        send('error', { message: error instanceof Error ? error.message : String(error) });
      } finally {
        inFlight = false;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() {
      inFlight = false;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
