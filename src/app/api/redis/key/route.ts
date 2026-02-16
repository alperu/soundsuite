/**
 * GET /api/redis/key?k=<key> — Returns the value for a specific Redis key.
 * Handles all Redis types: string, hash, list, set, zset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRedis, isRedisAvailable } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    if (!(await isRedisAvailable())) {
      return NextResponse.json({ error: 'Redis not available' }, { status: 503 });
    }

    const key = request.nextUrl.searchParams.get('k');
    if (!key) {
      return NextResponse.json({ error: 'Missing key parameter' }, { status: 400 });
    }

    // Security: only allow soundsuite:* keys
    if (!key.startsWith('soundsuite:')) {
      return NextResponse.json({ error: 'Only soundsuite:* keys are accessible' }, { status: 403 });
    }

    const redis = getRedis();
    const type = await redis.type(key);
    const ttl = await redis.ttl(key);

    let value: unknown;
    let size = 0;

    switch (type) {
      case 'string': {
        const raw = await redis.get(key);
        size = raw ? Buffer.byteLength(raw) : 0;
        // Try to detect if it's gzipped binary (content keys)
        if (raw && key.includes(':content:')) {
          const buf = await redis.getBuffer(key);
          size = buf ? buf.length : 0;
          value = `[gzipped binary, ${size} bytes]`;
        } else {
          value = raw;
        }
        break;
      }
      case 'hash': {
        const all = await redis.hgetall(key);
        size = Object.keys(all).length;
        // Limit to 200 fields for large hashes
        const entries = Object.entries(all);
        if (entries.length > 200) {
          value = {
            _truncated: true,
            _totalFields: entries.length,
            fields: Object.fromEntries(entries.slice(0, 200)),
          };
        } else {
          value = all;
        }
        break;
      }
      case 'list': {
        const len = await redis.llen(key);
        size = len;
        // Get first 100 items
        const items = await redis.lrange(key, 0, 99);
        value = { _totalItems: len, items };
        break;
      }
      case 'set': {
        const card = await redis.scard(key);
        size = card;
        const members = await redis.smembers(key);
        value = { _totalMembers: card, members: members.slice(0, 200) };
        break;
      }
      case 'zset': {
        const card = await redis.zcard(key);
        size = card;
        // Get top 100 by score descending with scores
        const membersWithScores = await redis.zrevrange(key, 0, 99, 'WITHSCORES');
        const pairs: Array<{ member: string; score: number }> = [];
        for (let i = 0; i < membersWithScores.length; i += 2) {
          pairs.push({ member: membersWithScores[i], score: parseFloat(membersWithScores[i + 1]) });
        }
        value = { _totalMembers: card, entries: pairs };
        break;
      }
      default:
        value = null;
    }

    return NextResponse.json({ key, type, ttl, size, value });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get key value' },
      { status: 500 }
    );
  }
}
