/**
 * GET /api/worker-pool/state — Returns current WorkerPoolService state.
 */

import { NextResponse } from 'next/server';
import { isRedisAvailable } from '@/lib/redis';
import { WorkerPoolService } from '@/services/worker-pool-service';

export async function GET() {
  try {
    if (!(await isRedisAvailable())) {
      return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
    }

    const pool = await WorkerPoolService.fromConfig();
    const state = await pool.getState();
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get worker pool state' },
      { status: 500 }
    );
  }
}
