import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { withCacheInvalidation } from './cache-invalidation'
import { xetoValidate } from '@/lib/legal/prisma-extensions/validate'
import { activeProfile, activeProfileName, dataRoot, listProfiles, profilePaths } from '@/lib/profiles/registry'

// Per-profile clients live on globalThis so the map survives HMR reloads in
// dev; the exported `prisma` is a proxy over the active one (see below).
const globalForPrisma = globalThis as unknown as {
  prismaClients: unknown
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
  // Mirror Prisma 5 behaviour: relative paths are anchored at the prisma/ dir.
  // `turbopackIgnore` stops Turbopack's build tracer from treating this dynamic
  // path as a static dependency — without it the tracer copies the ENTIRE
  // prisma/ dir (the dev DB + every sound-suite.db.bak.*, ~26 GB) into
  // .next/standalone. The database is opened at runtime, never bundled.
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), 'prisma', stripped)
}

/**
 * Construct the PrismaClient with the better-sqlite3 driver adapter.
 *
 * Prisma 7 deprecated the Rust query engine in favor of TypeScript-native
 * driver adapters. The better-sqlite3 adapter actually honors PRAGMAs at the
 * connection level (see prisma/prisma#2955), so WAL mode and busy_timeout
 * stop being best-effort.
 */
function makeClient(dbPath: string): PrismaClient {
  // PrismaBetterSqlite3 expects `url` as a path the better-sqlite3 driver can
  // open directly. We pass the resolved absolute filesystem path.
  const adapter = new PrismaBetterSqlite3({ url: dbPath })
  return new PrismaClient({ adapter })
}

/**
 * Where the active profile's database lives. Profiles (`lib/profiles`) own
 * this once `data/<name>/profile.json` exists; before that, the legacy
 * `DATABASE_URL` resolution above applies unchanged.
 */
function activeSqlitePath(): string {
  const p = activeProfile()
  if (!p.legacy) return p.sqlite
  return resolveSqlitePath(process.env.DATABASE_URL ?? 'file:./data/sound-suite.db')
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
function createPrismaClient(dbPath: string) {
  return withCacheInvalidation(makeClient(dbPath)).$extends(xetoValidate)
}

/**
 * The fully-extended client type. `$extends` returns a structurally-distinct
 * type, so we derive it from the factory rather than naming it by hand.
 */
export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>

/**
 * One client per profile, cached on globalThis so HMR reloads and the
 * profile switch both reuse an open connection instead of leaking one.
 */
const clients: Map<string, { dbPath: string; client: ExtendedPrismaClient; pragmas: boolean }> =
  (globalForPrisma.prismaClients as Map<string, { dbPath: string; client: ExtendedPrismaClient; pragmas: boolean }> | undefined) ??
  new Map()
globalForPrisma.prismaClients = clients

function clientForActiveProfile(): ExtendedPrismaClient {
  const name = activeProfileName()
  const dbPath = activeSqlitePath()
  const cached = clients.get(name)
  // Legacy mode can change its path if DATABASE_URL changes under it (the
  // migration script does exactly that); a profile's path never moves.
  if (cached && cached.dbPath === dbPath) return cached.client
  const client = createPrismaClient(dbPath)
  clients.set(name, { dbPath, client, pragmas: false })
  return client
}

/**
 * Models that describe the MACHINE, not a case set — the GPU fleet's role
 * assignments and provisioning, the sidecar command queue, model downloads,
 * admin logins and MCP sessions. They live in one shared `data/system.db`
 * and do not follow the active profile: switching to a demo profile must not
 * empty the role-assignment page (docs/tasks/56-system-db.md).
 *
 * Everything else — cases, documents, the tag graph, `Config` (embedding
 * model choice is bound to the profile's LanceDB), chat, presets — is
 * per-profile.
 */
export const SYSTEM_MODELS: ReadonlySet<string> = new Set([
  'sidecarCommand',
  'hostProvisioning',
  'hostRoleAssignment',
  'adminUser',
  'mcpSession',
  'modelDownload',
])

/** Table names of `SYSTEM_MODELS`, for the one-time seed and the docs. */
export const SYSTEM_TABLES = ['SidecarCommand', 'HostProvisioning', 'HostRoleAssignment', 'AdminUser', 'McpSession', 'ModelDownload'] as const

export function isSystemModel(prop: PropertyKey): boolean {
  return typeof prop === 'string' && SYSTEM_MODELS.has(prop)
}

const SYSTEM_KEY = '__system__'

/**
 * The shared client. Legacy mode (no profiles on disk) has no split: the one
 * database holds everything, as it always did. With profiles, the system file
 * is created on first use by cloning the active profile's schema and seeding
 * the system tables from EVERY profile (`INSERT OR IGNORE`), so a fleet
 * configured before this split is not lost whichever profile is active.
 */
function systemClient(): ExtendedPrismaClient {
  const active = activeProfile()
  if (active.legacy) return clientForActiveProfile()
  const dbPath = systemSqlitePath()
  const cached = clients.get(SYSTEM_KEY)
  if (cached && cached.dbPath === dbPath) return cached.client
  ensureSystemDatabase(dbPath)
  const client = createPrismaClient(dbPath)
  clients.set(SYSTEM_KEY, { dbPath, client, pragmas: false })
  return client
}

export function systemSqlitePath(): string {
  return path.join(dataRoot(), 'system.db')
}

function ensureSystemDatabase(dbPath: string): void {
  if (fs.existsSync(dbPath)) return
  // Lazy require: `lib/profiles/create` pulls better-sqlite3, which is only
  // needed on this one-time path.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cloneSchema, copyTableRows } = require('@/lib/profiles/create') as typeof import('@/lib/profiles/create')
  const sources = listProfiles()
    .map((p) => profilePaths(p.name).sqlite)
    .filter((p) => fs.existsSync(p))
  const template = fs.existsSync(activeProfile().sqlite) ? activeProfile().sqlite : sources[0]
  if (!template) throw new Error('cannot create system.db: no profile has a database to clone the schema from')
  cloneSchema(template, dbPath)
  for (const src of sources) {
    for (const table of SYSTEM_TABLES) copyTableRows(src, dbPath, table)
  }
}

/**
 * The application's Prisma client — a stable proxy over WHICHEVER profile is
 * active, with the system models routed to the shared system database. The
 * 100+ importers keep `import { prisma }` and never learn about profiles; a
 * switch (`lib/profiles/switch.ts`) changes what the proxy forwards to,
 * in-process, with no restart.
 *
 * Every property access resolves the client, so a `$transaction` callback or
 * a model delegate captured before a switch keeps using the client it was
 * taken from — which is the correct behaviour mid-write.
 */
export const prisma: ExtendedPrismaClient = new Proxy({} as ExtendedPrismaClient, {
  get(_target, prop) {
    const target = (isSystemModel(prop) ? systemClient() : clientForActiveProfile()) as unknown as Record<PropertyKey, unknown>
    const value = target[prop]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
  has(_target, prop) {
    return prop in (clientForActiveProfile() as unknown as object)
  },
})

/**
 * Disconnect and forget the client for `profileName`. Called by the profile
 * switch AFTER the registry points elsewhere, so nothing re-creates it.
 */
export async function releasePrismaClient(profileName: string): Promise<void> {
  const entry = clients.get(profileName)
  if (!entry) return
  clients.delete(profileName)
  try {
    await entry.client.$disconnect()
  } catch {
    /* already closed */
  }
}

/** The SQLite file the proxy currently forwards to. */
export function currentSqlitePath(): string {
  return activeSqlitePath()
}

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
  const entry = clients.get(activeProfileName())
  if (entry?.pragmas) return;
  try {
    await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
    const after = clients.get(activeProfileName())
    if (after) after.pragmas = true
  } catch {
    // Ignore — may fail if DB not yet ready
  }
}

export { Prisma }
