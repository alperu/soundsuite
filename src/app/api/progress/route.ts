import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

interface ProgressStats {
  total: number;
  /** indexed + error — everything the pipeline is finished with. */
  processed: number;
  /** Successfully indexed only. Reported separately so a failure is never
   *  presented as an indexed document. */
  indexed: number;
  queued: number;
  processing: number;
  error: number;
  rate: number;
  eta: number | null;
  isComplete: boolean;
}

// Track processing history for rate calculation
const processingHistory: Array<{ timestamp: number; processed: number }> = [];
const HISTORY_WINDOW_MS = 60000; // 1 minute window for rate calculation

async function calculateProgressStats(caseId?: string): Promise<ProgressStats> {
  // Count only documents a filing references — the same predicate
  // `src/app/page.tsx` and `/api/documents` use for the case document list.
  //
  // Without it this banner is the one surface still reporting the folder sweep:
  // a case whose list showed 6 documents reported "195 of 258 documents
  // indexed", because every unfiled PDF the watcher found under the case
  // directory counted towards the denominator. Two numbers for the same case,
  // differing by 40×, with nothing on screen to explain the gap.
  //
  // `filingId` rather than a status filter, for the reason recorded on
  // /api/documents: bulk promotion is deliberately unfiled, so the unwanted
  // rows span every status.
  const whereClause = caseId
    ? { caseId, filingId: { not: null } }
    : { filingId: { not: null } };

  // Get document counts by status
  const [total, queued, processing, indexed, error] = await Promise.all([
    prisma.document.count({ where: whereClause }),
    prisma.document.count({ where: { ...whereClause, status: 'QUEUED' } }),
    prisma.document.count({ where: { ...whereClause, status: 'PROCESSING' } }),
    prisma.document.count({ where: { ...whereClause, status: 'INDEXED' } }),
    prisma.document.count({ where: { ...whereClause, status: 'ERROR' } }),
  ]);

  const processed = indexed + error; // Both indexed and error are "processed"
  const isComplete = queued === 0 && processing === 0;

  // Calculate processing rate (documents per minute)
  const now = Date.now();
  
  // Add current state to history
  processingHistory.push({ timestamp: now, processed });
  
  // Remove old entries outside the time window
  while (
    processingHistory.length > 0 && 
    processingHistory[0].timestamp < now - HISTORY_WINDOW_MS
  ) {
    processingHistory.shift();
  }

  // Calculate rate based on history
  let rate = 0;
  if (processingHistory.length >= 2) {
    const oldest = processingHistory[0];
    const newest = processingHistory[processingHistory.length - 1];
    const timeDiffMinutes = (newest.timestamp - oldest.timestamp) / 60000;
    const docsDiff = newest.processed - oldest.processed;
    
    if (timeDiffMinutes > 0) {
      rate = docsDiff / timeDiffMinutes;
    }
  }

  // Calculate ETA (estimated time remaining in seconds)
  let eta: number | null = null;
  if (rate > 0 && queued > 0) {
    const minutesRemaining = queued / rate;
    eta = minutesRemaining * 60;
  }

  return {
    total,
    processed,
    indexed,
    queued,
    processing,
    error,
    rate,
    eta,
    isComplete,
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const caseId = searchParams.get('caseId') || undefined;

  // Set up SSE headers
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      // Send initial data immediately
      try {
        const stats = await calculateProgressStats(caseId);
        const data = `data: ${JSON.stringify(stats)}\n\n`;
        controller.enqueue(encoder.encode(data));
      } catch (error) {
        console.error('Error calculating progress stats:', error);
      }

      // Set up interval to send updates every 2 seconds
      const intervalId = setInterval(async () => {
        try {
          const stats = await calculateProgressStats(caseId);
          const data = `data: ${JSON.stringify(stats)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch (error) {
          console.error('Error calculating progress stats:', error);
          clearInterval(intervalId);
          controller.close();
        }
      }, 2000);

      // Clean up on connection close
      request.signal.addEventListener('abort', () => {
        clearInterval(intervalId);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
