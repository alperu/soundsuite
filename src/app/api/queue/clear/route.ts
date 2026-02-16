/**
 * POST /api/queue/clear — Stop all processing and clear the queue.
 *
 * 1. Sets all QUEUED documents back to DISCOVERED (removes them from the queue)
 * 2. Sets all PROCESSING documents to STOPPED
 * 3. Returns counts of affected documents
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export async function POST() {
  try {
    // Move QUEUED → DISCOVERED (un-queue them)
    const dequeued = await prisma.document.updateMany({
      where: { status: 'QUEUED' },
      data: { status: 'DISCOVERED' },
    });

    // Move PROCESSING → STOPPED
    const stopped = await prisma.document.updateMany({
      where: { status: 'PROCESSING' },
      data: { status: 'STOPPED' },
    });

    return NextResponse.json({
      success: true,
      dequeued: dequeued.count,
      stopped: stopped.count,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear queue' },
      { status: 500 },
    );
  }
}
