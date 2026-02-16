/**
 * SSE endpoint for real-time folder change notifications.
 *
 * GET /api/cases/[id]/watch
 *
 * Registers a watcher in Redis, polls the filesystem for changes,
 * and pushes delta events (added/removed/modified) to the SSE stream.
 * Also subscribes to Redis pub/sub for document status changes.
 */

import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getRedis, isRedisAvailable } from '@/lib/redis';
import { SSE_CHANNELS } from '@/lib/sse-events';
import { FolderIndexService, CachedFileEntry } from '@/services/folder-index-service';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const WATCHER_SET_KEY = 'soundsuite:watchers';
const POLL_INTERVAL = 3000; // 3 seconds
const HEARTBEAT_INTERVAL = 15000; // 15 seconds

interface FileSnapshot {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

async function scanFlat(dirPath: string): Promise<FileSnapshot[]> {
  const results: FileSnapshot[] = [];
  try {
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        results.push({ name: item.name, path: full, size: 0, mtime: 0 });
        continue;
      }
      if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
        try {
          const stat = await fs.stat(full);
          results.push({ name: item.name, path: full, size: stat.size, mtime: stat.mtimeMs });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return results;
}

function computeHash(snapshots: FileSnapshot[]): string {
  const data = snapshots.map(s => `${s.path}:${s.size}:${s.mtime}`).join('|');
  return crypto.createHash('md5').update(data).digest('hex');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const caseRecord = await prisma.case.findUnique({ where: { id } });
  if (!caseRecord) {
    return new Response('Case not found', { status: 404 });
  }

  const watcherId = crypto.randomUUID();
  const casePath = caseRecord.path;

  // Set up SSE stream
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { closed = true; }
      };

      // Register watcher in Redis
      const redisAvail = await isRedisAvailable();
      if (redisAvail) {
        const redis = getRedis();
        await redis.zadd(WATCHER_SET_KEY, Date.now(), `${id}:${watcherId}`);
      }

      // Send initial connected event
      send('connected', { watcherId, caseId: id });

      // Take initial snapshot
      let prevSnapshot = await scanFlat(casePath);
      let prevHash = computeHash(prevSnapshot);

      // Subscribe to all SSE event channels via Redis pub/sub
      let subscriber: ReturnType<typeof getRedis> | null = null;
      if (redisAvail) {
        try {
          // Create a separate connection for subscribing
          const Redis = (await import('ioredis')).default;
          const host = process.env.REDIS_HOST || '127.0.0.1';
          const port = parseInt(process.env.REDIS_PORT || '6379', 10);
          const password = process.env.REDIS_PASSWORD || undefined;
          subscriber = new Redis({ host, port, password, maxRetriesPerRequest: 3 }) as ReturnType<typeof getRedis>;

          subscriber.subscribe(
            SSE_CHANNELS.DOC_STATUS,
            SSE_CHANNELS.FILING_EVENTS,
            SSE_CHANNELS.DOCUMENT_EVENTS
          );
          subscriber.on('message', (channel: string, message: string) => {
            try {
              const payload = JSON.parse(message);
              if (payload.caseId !== id) return;

              if (channel === SSE_CHANNELS.DOC_STATUS) {
                send('doc_status', payload);
              } else if (channel === SSE_CHANNELS.FILING_EVENTS) {
                // Forward as the specific filing event type (filing_created, filing_updated, filing_deleted)
                send(payload.type, payload);
              } else if (channel === SSE_CHANNELS.DOCUMENT_EVENTS) {
                // Forward as the specific document event type (document_added, document_status_changed)
                send(payload.type, payload);
              }
            } catch { /* ignore malformed */ }
          });
        } catch { /* Redis sub failed, continue without */ }
      }

      // Filesystem polling loop
      const pollTimer = setInterval(async () => {
        if (closed) {
          clearInterval(pollTimer);
          return;
        }

        try {
          const currentSnapshot = await scanFlat(casePath);
          const currentHash = computeHash(currentSnapshot);

          if (currentHash !== prevHash) {
            // Compute delta
            const prevMap = new Map(prevSnapshot.map(s => [s.path, s]));
            const currMap = new Map(currentSnapshot.map(s => [s.path, s]));

            const added: FileSnapshot[] = [];
            const removed: FileSnapshot[] = [];
            const modified: FileSnapshot[] = [];

            for (const [p, snap] of currMap) {
              const prev = prevMap.get(p);
              if (!prev) {
                added.push(snap);
              } else if (prev.size !== snap.size || prev.mtime !== snap.mtime) {
                modified.push(snap);
              }
            }
            for (const [p, snap] of prevMap) {
              if (!currMap.has(p)) {
                removed.push(snap);
              }
            }

            send('delta', { added, removed, modified });

            prevSnapshot = currentSnapshot;
            prevHash = currentHash;

            // Update Redis cache if available
            if (redisAvail) {
              try {
                const indexService = new FolderIndexService();
                const entries: CachedFileEntry[] = currentSnapshot.map(s => ({
                  name: s.name,
                  path: s.path,
                  type: s.size > 0 ? 'file' as const : 'folder' as const,
                  size: s.size,
                  mtime: s.mtime,
                }));
                await indexService.setFolderContent(casePath, entries, currentHash);
                await indexService.setCount(casePath, currentSnapshot.filter(s => s.size > 0).length);
              } catch { /* cache update failed, non-critical */ }
            }
          }

          // Heartbeat to keep watcher alive in Redis
          if (redisAvail) {
            await getRedis().zadd(WATCHER_SET_KEY, Date.now(), `${id}:${watcherId}`);
          }
        } catch {
          // Poll error, will retry next interval
        }
      }, POLL_INTERVAL);

      // Heartbeat to keep connection alive
      const heartbeatTimer = setInterval(() => {
        if (closed) {
          clearInterval(heartbeatTimer);
          return;
        }
        send('heartbeat', { ts: Date.now() });
      }, HEARTBEAT_INTERVAL);

      // Cleanup on abort
      request.signal.addEventListener('abort', async () => {
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);

        // Unregister watcher
        if (redisAvail) {
          try {
            await getRedis().zrem(WATCHER_SET_KEY, `${id}:${watcherId}`);
          } catch { /* ignore */ }
        }

        // Close subscriber
        if (subscriber) {
          try {
            subscriber.unsubscribe();
            subscriber.disconnect();
          } catch { /* ignore */ }
        }

        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
