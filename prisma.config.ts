import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'prisma/config'

/**
 * Profiles (docs/tasks/54-profiles.md). Once `data/<name>/profile.json`
 * exists, the CLI targets the active profile's database — `SS_PROFILE=<name>`
 * or `data/profiles.json` — unless DATABASE_URL points at an ABSOLUTE file,
 * which `scripts/manage.mjs db:migrate` and `lib/profiles/create.ts` set to
 * name a profile explicitly. A relative DATABASE_URL (the .env default) is
 * the pre-profiles layout and is only used when no profile exists.
 */
function profileDatabaseUrl(): string | undefined {
  const explicit = process.env.DATABASE_URL
  if (explicit && /^file:\//.test(explicit)) return explicit
  const dataRoot = path.resolve(process.cwd(), 'data')
  let profiles: string[] = []
  try {
    profiles = fs
      .readdirSync(dataRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dataRoot, e.name, 'profile.json')))
      .map((e) => e.name)
  } catch {
    /* no data dir */
  }
  if (profiles.length === 0) return explicit
  let active = process.env.SS_PROFILE
  if (!active || !profiles.includes(active)) {
    try {
      active = JSON.parse(fs.readFileSync(path.join(dataRoot, 'profiles.json'), 'utf8')).active
    } catch {
      /* none */
    }
  }
  if (!active || !profiles.includes(active)) active = profiles[0]
  return `file:${path.join(dataRoot, active, 'sound-suite.db')}`
}

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
    url: profileDatabaseUrl(),
  },
})
