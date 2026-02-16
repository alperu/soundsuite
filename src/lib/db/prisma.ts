import { PrismaClient, Prisma } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  pragmasApplied: boolean | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/**
 * Apply SQLite PRAGMAs for performance and concurrency.
 * - WAL mode: allows reads while writes are in progress (fixes API hangs during ingestion)
 * - busy_timeout: writes queue for 5s instead of failing immediately on lock contention
 * Call this once at app startup; safe to call multiple times (idempotent).
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
