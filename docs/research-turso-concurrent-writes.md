# Turso & Concurrent Writes Research

**Date:** 2026-02-17
**Context:** Large document ingestion (400-735+ pages) causes SQLite write contention — OCR workers + PageCache inserts block API read queries.

## Problem

SQLite's single-writer limitation causes:
1. `SQLITE_BUSY` / timeout errors when multiple OCR workers write to PageCache concurrently
2. API read queries (`/api/documents`) hang indefinitely while ingestion holds write locks

### Current Mitigation (Applied)

- **WAL mode** (`PRAGMA journal_mode = WAL`) — allows concurrent reads during writes
- **busy_timeout = 5000** — writers queue for 5s instead of failing immediately
- **Retry with backoff** on PageCache upserts (3 attempts, 200ms/400ms delays)
- **Batch inserts** via `createMany({ skipDuplicates })` instead of parallel upserts

This solves the read-blocking problem and reduces write failures, but doesn't enable true concurrent writes.

## Turso Overview

[Turso](https://turso.tech/) is a database built on **libSQL**, a fork of SQLite. It can run locally (embedded) or as a remote/edge database service.

### Concurrent Writes via MVCC

Turso implements concurrent writes using Multi-Version Concurrency Control (MVCC):
- Each transaction gets a snapshot of the database at a point in time
- Writers don't block readers, readers don't block writers
- Conflicts are checked only at commit time (optimistic concurrency)
- Claims **up to 4x write throughput** vs standard SQLite
- Eliminates `SQLITE_BUSY` errors entirely

**Implementation status:** [Issue #86](https://github.com/tursodatabase/turso/issues/86) is closed as completed (milestone 0.2, 100% done as of Oct 2025). The blog post still describes it as an "early technology preview" — feature-complete but not yet production-hardened.

**How to enable:**
```bash
tursodb --experimental-mvcc database.db
```
Then use `BEGIN CONCURRENT;` for transactions.

### Known Limitations (as of Feb 2026)

- `--experimental-mvcc` flag required (not default behavior)
- No `CREATE INDEX` support within MVCC transactions
- Inefficient row version storage (stores complete row copies in memory)
- Row version management lacks wait-free guarantees
- No asynchronous I/O support
- `BEGIN CONCURRENT` syntax must be used explicitly per transaction

## ORM / Query Builder Compatibility

| Tool | Type | Turso Integration | Concurrent Writes | Notes |
|------|------|-------------------|-------------------|-------|
| **Prisma** | Full ORM | `@prisma/adapter-libsql` | No — can't use `BEGIN CONCURRENT` natively | `prisma migrate dev` doesn't work (HTTP transport). Must use `prisma migrate diff` + Turso CLI. Heaviest option. |
| **Drizzle ORM** | Full ORM | First-class via `drizzle-orm/libsql` | Possible via raw SQL / custom transaction wrappers | ~7.4kb, zero deps, type-safe, built-in migrations via `drizzle-kit`. Turso's recommended ORM. |
| **Kysely** | Query builder | `@libsql/kysely-libsql` dialect | Possible via raw SQL | Type-safe SQL query builder. Thinner than ORM — write SQL-like chains. |

### Drizzle ORM (Recommended Alternative)

If migrating away from Prisma, Drizzle is the strongest candidate:
- Lightweight (~7.4kb minified+gzipped), tree-shakeable, zero dependencies
- Works in edge runtimes (Cloudflare Workers, Vercel Edge, etc.)
- Direct libSQL driver support (no adapter layer needed)
- Schema defined in TypeScript (similar concept to Prisma schema but in code)
- Own migration system (`drizzle-kit generate` / `drizzle-kit push`)
- Could use `BEGIN CONCURRENT` via `db.run(sql\`BEGIN CONCURRENT\`)` or custom transaction wrapper

**Drizzle + Turso setup:**
```typescript
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';

const client = createClient({
  url: 'file:./data/sound-suite.db', // local file
  // or url: 'libsql://your-db.turso.io', authToken: '...' for remote
});

const db = drizzle(client);
```

### Kysely

- Type-safe query builder (not a full ORM)
- Lower abstraction than Drizzle — closer to raw SQL
- Good for projects that want SQL control with type safety
- Turso dialect available: `@libsql/kysely-libsql`

## Migration Path (Future)

If/when Turso's concurrent writes exits experimental:

1. **Swap SQLite for libSQL** — drop-in compatible, same file format
2. **Replace Prisma with Drizzle** — convert `schema.prisma` to Drizzle schema files
3. **Enable MVCC** — `--experimental-mvcc` flag on the libSQL instance
4. **Use `BEGIN CONCURRENT`** in ingestion pipeline for parallel PageCache writes
5. **Remove WAL/retry workarounds** — MVCC handles concurrency natively

### Estimated Effort

- Schema conversion: ~2 hours (mechanical translation)
- Query rewriting: ~4-8 hours (Prisma queries to Drizzle syntax)
- Migration tooling: ~1 hour (switch from `prisma migrate` to `drizzle-kit`)
- Testing: ~4 hours

## Decision

**For now: stay with Prisma + SQLite WAL mode.** The current mitigations solve the immediate problems. Revisit when:
- Turso concurrent writes drops the `--experimental-mvcc` flag (becomes default)
- `CREATE INDEX` limitation is resolved
- Prisma becomes a bottleneck that Drizzle would solve

## References

- [Beyond the Single-Writer Limitation with Turso's Concurrent Writes](https://turso.tech/blog/beyond-the-single-writer-limitation-with-tursos-concurrent-writes)
- [tursodatabase/turso#86 — BEGIN CONCURRENT](https://github.com/tursodatabase/turso/issues/86)
- [How Turso Eliminates SQLite's Single-Writer Bottleneck](https://betterstack.com/community/guides/databases/turso-explained/)
- [Drizzle + Turso docs](https://docs.turso.tech/sdk/ts/orm/drizzle)
- [Drizzle ORM — Drizzle with Turso](https://orm.drizzle.team/docs/tutorials/drizzle-with-turso)
- [Prisma + Turso docs](https://docs.turso.tech/sdk/ts/orm/prisma)
- [Prisma Turso Documentation](https://www.prisma.io/docs/orm/overview/databases/turso)
- [Kysely](https://kysely.dev/)
