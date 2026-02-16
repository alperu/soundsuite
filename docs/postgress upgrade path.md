# Migrate to PostgreSQL + pgvector (Unified SQL + Vector DB)

## Context

The app currently uses **SQLite** (via Prisma) for metadata and **LanceDB** (file-based) for vector embeddings. This works for single-user local use but breaks down for multi-user enterprise:

- SQLite has a single-writer lock — concurrent writes from multiple users cause `SQLITE_BUSY`
- LanceDB stores vectors on local disk — no shared access across servers
- Redis is used only for ephemeral progress tracking, not as a core data store
- No row-level security, user isolation, or connection pooling

## Recommendation: PostgreSQL + pgvector

**PostgreSQL with the pgvector extension** is the best fit for this application. It unifies SQL metadata and vector search into a single database with:

- **ACID transactions** across both relational and vector data
- **Multi-user concurrency** — row-level locking, connection pooling, roles/permissions
- **pgvector 0.8+** — HNSW and IVFFlat indexes, L2/cosine/inner-product distance, filtered vector queries
- **Prisma native support** — just change `provider = "sqlite"` to `"postgresql"` in schema
- **40-60% lower TCO** than running separate SQL + vector databases (for datasets under 500M vectors)
- **Enterprise features** — replication, backups, PITR, audit logging, SSL/TLS
- Eliminates LanceDB, simplifies deployment to a single database dependency

### Deployment Options (pick based on needs)

| Option | Best For | Self-Host? | Notes |
|--------|----------|------------|-------|
| **Self-hosted PostgreSQL + pgvector** | Full control, on-prem, data sovereignty | Yes | Docker or bare metal. Most flexible. |
| **Supabase** | Managed PG + auth + realtime + pgvector built-in | Cloud or self-host | Has row-level security, auth, realtime subscriptions. HIPAA compliant. |
| **Neon** | Serverless, auto-scaling, branching | Cloud only | Great for dev/staging with instant DB branches. Pay-per-query. |
| **AWS RDS / Azure / GCP Cloud SQL** | Enterprise cloud with SLAs | Cloud only | Standard managed PG with pgvector extension. |

**Recommendation for a large company:** **Self-hosted PostgreSQL + pgvector** (Docker) if data sovereignty matters, or **Supabase** if you want managed infrastructure with built-in auth and realtime.

---

## Migration Plan

### 1. Update Prisma schema for PostgreSQL

**File:** `prisma/schema.prisma`

- Change `provider = "sqlite"` to `provider = "postgresql"`
- Update `DATABASE_URL` to PostgreSQL connection string
- Add a new `ChunkVector` model to store embeddings directly in PostgreSQL:

```prisma
model ChunkVector {
  id          String   @id @default(uuid())
  documentId  String
  caseId      String
  text        String
  pageNumber  Int
  chunkIndex  Int
  isExhibit   Boolean  @default(false)
  exhibitPath String?
  createdAt   DateTime @default(now())

  document    Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  case        Case     @relation(fields: [caseId], references: [id], onDelete: Cascade)

  @@index([documentId])
  @@index([caseId])
}
```

- The `vector` column must be added via a custom migration (Prisma doesn't natively support pgvector types yet):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "ChunkVector" ADD COLUMN embedding vector(384);
CREATE INDEX ON "ChunkVector" USING hnsw (embedding vector_l2_ops);
```

### 2. Replace VectorStore with PostgreSQL implementation

**File:** `src/lib/vector/vector-store.ts`

Replace the LanceDB-based `VectorStore` class with a PostgreSQL implementation that:

- Uses `$queryRawUnsafe` or `$executeRawUnsafe` for pgvector operations
- `insertChunks()` → `INSERT INTO "ChunkVector" (id, documentId, caseId, text, embedding, ...) VALUES (...)`
- `search()` → `SELECT *, embedding <-> $1 AS distance FROM "ChunkVector" ORDER BY distance LIMIT $2` (with optional WHERE filters)
- `deleteByDocument()` → `DELETE FROM "ChunkVector" WHERE "documentId" = $1`
- Keep the same `VectorStore` interface so the rest of the app doesn't change

### 3. Update database configuration

**Files:** `src/lib/db/config.ts`, `src/lib/db/prisma.ts`

- Remove SQLite-specific pragmas (WAL mode, busy_timeout)
- Add PostgreSQL connection pooling configuration
- Update `DATABASE_URL` format: `postgresql://user:pass@host:5432/legallens`

### 4. Remove LanceDB dependency

- Remove `@lancedb/lancedb` from `package.json`
- Remove from `serverExternalPackages` in `next.config.ts`
- Delete `data/lancedb/` directory references

### 5. Data migration script

Create `scripts/migrate-to-postgres.ts`:

- Read existing SQLite data using Prisma
- Read existing LanceDB vectors
- Insert both into PostgreSQL
- Verify counts match

### 6. Update Docker/deployment

- Add PostgreSQL + pgvector service to `docker-compose.yml`
- Update environment variables documentation
- Add connection string to `.env.example`

---

## Files to Modify

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Change provider, add ChunkVector model, add relations |
| `src/lib/vector/vector-store.ts` | Replace LanceDB with pgvector SQL queries |
| `src/lib/db/prisma.ts` | Remove SQLite pragmas, add PG pool config |
| `src/lib/db/config.ts` | Update connection handling |
| `next.config.ts` | Remove `@lancedb/lancedb` from serverExternalPackages |
| `package.json` | Remove `@lancedb/lancedb`, add `pg` if needed |
| `docker-compose.yml` (new) | Add PostgreSQL + pgvector service |
| `scripts/migrate-to-postgres.ts` (new) | Data migration script |
| `.env.example` | Add PostgreSQL connection string |

---

## Verification

1. `npx prisma migrate dev` — schema migrates cleanly to PostgreSQL
2. `npx jest src/lib/vector/` — vector store tests pass with PG backend
3. `npx jest src/lib/ingestion/` — ingestion pipeline works end-to-end
4. Manual test — upload a PDF, verify it indexes, search returns results
5. Multi-user test — two browser sessions uploading/searching simultaneously

---

## Sources

- [pgvector: Key features and guide (2026)](https://www.instaclustr.com/education/vector-database/pgvector-key-features-tutorial-and-pros-and-cons-2026-guide/)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Prisma ORM 6.13.0 — pgvector for Prisma Postgres](https://www.prisma.io/blog/orm-6-13-0-ci-cd-workflows-and-pgvector-for-prisma-postgres)
- [Prisma PostgreSQL extensions docs](https://www.prisma.io/docs/postgres/database/postgres-extensions)
- [Supabase Vector (pgvector)](https://supabase.com/modules/vector)
- [Neon pgvector docs](https://neon.com/docs/extensions/pgvector)
- [pgvector enterprise strategy (Percona)](https://www.percona.com/blog/pgvector-the-critical-postgresql-component-for-your-enterprise-ai-strategy/)
- [State of Databases 2026](https://devnewsletter.com/p/state-of-databases-2026/)
- [Best Vector Databases 2025 comparison](https://www.firecrawl.dev/blog/best-vector-databases-2025)