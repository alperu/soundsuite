import path from 'node:path'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { withCacheInvalidation } from './cache-invalidation'
import { xetoValidate } from '@/lib/legal/prisma-extensions/validate'

// The exported `prisma` is the extended client (Prisma's
// `$extends` returns a structurally-distinct type), so we widen the
// global cache to `unknown` here and rely on the export site to set
// the type. This keeps the singleton stable across HMR reloads in dev.
const globalForPrisma = globalThis as unknown as {
  prisma: unknown
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

/**
 * Compose the Prisma client:
 *   raw client → withCacheInvalidation (memcache hooks) → $extends(xetoValidate)
 *
 * The XETO write-path validation MUST sit outside the cache-invalidation
 * wrapper so it sees the un-rewritten user args. Agent 3's repo layer
 * builds on `prisma` (the extended client) — see
 * `docs/xeto-haystack-research.md §12.2` for the layering rationale.
 */
function createPrismaClient() {
  return withCacheInvalidation(makeClient()).$extends(xetoValidate)
}

/**
 * The fully-extended client type. `$extends` returns a structurally-distinct
 * type, so we derive it from the factory rather than naming it by hand. The
 * global cache is `unknown` (set above), so we cast it back to this type at the
 * export site — otherwise `unknown ?? client` widens `prisma` to `{}` and every
 * `prisma.<model>` access fails to type-check.
 */
export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>

export const prisma: ExtendedPrismaClient =
  (globalForPrisma.prisma as ExtendedPrismaClient | undefined) ?? createPrismaClient()

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
