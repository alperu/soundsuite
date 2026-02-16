/**
 * POST /api/worker-pool/cache-clear — Clears all Redis folder cache.
 */

import { NextResponse } from 'next/server';
import { isRedisAvailable } from '@/lib/redis';
import { FolderIndexService } from '@/services/folder-index-service';

export async function POST() {
  try {
    if (!(await isRedisAvailable())) {
      return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
    }

    const indexService = new FolderIndexService();
    await indexService.clearAll();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to clear cache' },
      { status: 500 }
    );
  }
}
