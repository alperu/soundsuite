/**
 * Workers API Route
 * 
 * GET  /api/workers — returns current worker status
 * POST /api/workers — adjust worker count { count: number }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkerManager } from '@/services/worker-init';

export async function GET() {
  try {
    const manager = await getWorkerManager();
    return NextResponse.json({
      workerCount: manager.getWorkerCount(),
      workers: manager.getStatus(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to get worker status' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const count = parseInt(body.count, 10);

    if (isNaN(count) || count < 0 || count > 10) {
      return NextResponse.json(
        { error: 'count must be a number between 0 and 10' },
        { status: 400 }
      );
    }

    const manager = await getWorkerManager();
    await manager.setWorkerCount(count);

    // Persist to config DB
    const { setConfigValue } = await import('@/lib/db/config');
    await setConfigValue('parsing.workerCount', String(count));

    return NextResponse.json({
      success: true,
      workerCount: manager.getWorkerCount(),
      workers: manager.getStatus(),
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to update worker count' },
      { status: 500 }
    );
  }
}
