import 'dotenv/config'
import { defineConfig } from 'prisma/config'

/**
 * Prisma 7+ project config.
 *
 * Prisma 7 removed the `url` field from the schema's datasource block. The
 * runtime client gets its URL via the better-sqlite3 driver adapter in
 * `src/lib/db/prisma.ts`; the migration runner reads it from here.
 *
 * `dotenv/config` is imported explicitly because Prisma 7 stopped auto-loading
 * `.env` for the schema layer.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
})
