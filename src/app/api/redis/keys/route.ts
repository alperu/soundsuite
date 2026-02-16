/**
 * GET /api/redis/keys — Returns all soundsuite:* keys grouped by type.
 */

import { NextResponse } from 'next/server';
import { getRedis, isRedisAvailable } from '@/lib/redis';

export const dynamic = 'force-dynamic';

interface RedisKeyInfo {
  key: string;
  type: string;
  ttl: number;
}

export async function GET() {
  try {
    if (!(await isRedisAvailable())) {
      return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
    }

    const redis = getRedis();
    const keys: string[] = [];

    // Scan for all soundsuite:* keys
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'soundsuite:*', 'COUNT', '200');
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    // Get type and TTL for each key
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.type(key);
      pipeline.ttl(key);
    }
    const results = await pipeline.exec();

    const keyInfos: RedisKeyInfo[] = [];
    for (let i = 0; i < keys.length; i++) {
      const typeResult = results?.[i * 2];
      const ttlResult = results?.[i * 2 + 1];
      keyInfos.push({
        key: keys[i],
        type: (typeResult?.[1] as string) || 'unknown',
        ttl: (ttlResult?.[1] as number) ?? -1,
      });
    }

    // Group by prefix
    const grouped: Record<string, RedisKeyInfo[]> = {};
    for (const info of keyInfos) {
      // Group by second segment: soundsuite:folder:counts → folder
      const parts = info.key.split(':');
      const group = parts.length >= 3 ? parts.slice(0, 3).join(':') : parts.slice(0, 2).join(':');
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(info);
    }

    return NextResponse.json({
      totalKeys: keys.length,
      groups: grouped,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to scan Redis keys' },
      { status: 500 }
    );
  }
}
