import path from 'node:path'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { withCacheInvalidation } from './cache-invalidation'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  pragmasApplied: boolean | undefined
}

/**
 * Translate a Prisma-style `file:` URL into the absolute filesystem path that
 * better-sqlite3 expects.
 *
 * Prisma's convention: `file:./data/sound-suite.db` resolves *relative to the
 * directory containing schema.prisma* (= `prisma/`). The Rust query engine
 * baked this in. Prisma 7's driver adapters hand the URL straight to the
 * native driver, which has no concept of "relative to schema dir" — it
 * resolves against `process.cwd()` instead, silently creating a fresh empty
 * SQLite file at the wrong path. We do the translation explicitly here so
 * dev / build / runtime all hit the same physical file.
 */
function resolveSqlitePath(url: string): string {
  const stripped = url.startsWith('file:') ? url.slice('file:'.length) : url
  if (path.isAbsolute(stripped)) return stripped
  // Mirror Prisma 5 behaviour: relative paths are anchored at the prisma/ dir
  return path.resolve(process.cwd(), 'prisma', stripped)
}

/**
 * Construct the PrismaClient with the better-sqlite3 driver adapter.
 *
 * Prisma 7 deprecated the Rust query engine in favor of TypeScript-native
 * driver adapters. The better-sqlite3 adapter actually honors PRAGMAs at the
 * connection level (see prisma/prisma#2955), so WAL mode and busy_timeout
 * stop being best-effort.
 */
function makeClient(): PrismaClient {
  const url = process.env.DATABASE_URL ?? 'file:./data/sound-suite.db'
  const dbPath = resolveSqlitePath(url)
  // PrismaBetterSqlite3 expects `url` as a path the better-sqlite3 driver can
  // open directly. We pass the resolved absolute filesystem path.
  const adapter = new PrismaBetterSqlite3({ url: dbPath })
  return new PrismaClient({ adapter })
}

export const prisma = globalForPrisma.prisma ?? withCacheInvalidation(makeClient())

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/**
 * Apply SQLite PRAGMAs for performance and concurrency.
 * - WAL mode: allows reads while writes are in progress (fixes API hangs during ingestion)
 * - busy_timeout: writes queue for 5s instead of failing immediately on lock contention
 * Call this once at app startup; safe to call multiple times (idempotent).
 *
 * Under the better-sqlite3 adapter (Prisma 7+) these PRAGMAs take effect at
 * the connection layer rather than per-query — fixing the long-standing
 * Quaint driver behavior that ignored them silently.
 */
export async function applySqlitePragmas(): Promise<void> {
  if (globalForPrisma.pragmasApplied) return;
  try {
    await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
    globalForPrisma.pragmasApplied = true;
  } catch {
    // Ignore — may fail if DB not yet ready
  }
}

export { Prisma }
