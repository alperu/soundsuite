LanceDB → PostgreSQL + pgvector: Assessment & Recommendation

Context

You asked whether to switch from LanceDB (file-based vectors) + SQLite (metadata)
to PostgreSQL + pgvector. A migration doc already exists at docs/postgress upgrade
path.md. This plan provides an honest assessment based on actual codebase usage
patterns and your current scale.

Recommendation: Don't migrate yet. Do quick wins instead.

Why Not Now

1. This is a single-user, local tool. No multi-user auth, no horizontal scaling, no
   multi-server deployment. PostgreSQL's concurrency advantages don't apply.
2. Adding PostgreSQL means running a separate database server (Docker or native
   install). Today npm run dev starts everything. That zero-config simplicity is a
   feature for a local tool.
3. The stated pain points are already mitigated:
- SQLite write lock → WAL mode + busy_timeout + retry logic in cachePageText
- Two databases to backup → BackupManager already handles both in one operation
- No FK between vectors and metadata → deleteByDocument() is called consistently
  before re-index
4. Migration surface is larger than the migration doc estimates. LanceDB is
   accessed directly (bypassing VectorStore) in 8+ locations, plus
   FilingTypeClassifier maintains its own separate filing-types LanceDB table.
   Realistic effort: 15-22 hours, not 11-16.

When to Revisit

Migrate when ANY of these become true:
- Multiple users need simultaneous read/write access
- App needs to run on a remote server (not just local)
- Scale exceeds ~10,000 documents
- Compliance requires audit logging or row-level security

 ---
Quick Wins (3-4 hours total, no PostgreSQL needed)

1. Centralize VectorStore access (1-2 hours)

Create src/lib/vector/get-vector-store.ts — a singleton factory like the existing
prisma.ts global pattern. Replace all 8+ scattered new VectorStore(...) / direct
lancedb.connect() calls:

Files to consolidate:
- src/app/api/vectors/stats/route.ts — direct lancedb.connect()
- src/app/api/vectors/route.ts — direct lancedb.connect()
- src/app/api/documents/[id]/clear-index/route.ts — new VectorStore()
- src/app/api/admin/cache/route.ts — new VectorStore()
- src/app/api/exhibits/route.ts — new VectorStore()
- src/app/case-explorer/exhibits/page.tsx — new VectorStore()
- src/app/exhibits/page.tsx — new VectorStore()
- src/lib/mcp/get-tool-registry.ts — new VectorStore()

This makes a future backend swap trivial (change one file, not 8+).

2. Add vector-metadata orphan check (1 hour)

Extend /api/vectors/stats to compare SQLite document.id values with LanceDB
document_id values. Flag orphaned vectors for cleanup. Addresses the no-FK concern
without schema changes.

3. Add LanceDB compaction (30 min)

Call table.optimize() periodically (e.g., in BackgroundScannerDaemon) to compact
fragment files and keep vector search performant as the dataset grows.

4. Increase busy_timeout for heavy ingestion (5 min)

Current 5000ms may be tight during large batch ingestion with multiple workers.
Increase to 10000ms or make configurable via env var in src/lib/db/prisma.ts.

 ---
Verification

- After Quick Win 1: npm run build succeeds, all vector search/browse/stats
  endpoints return same results
- After Quick Win 2: Admin dashboard shows orphan count (should be 0 for healthy
  DB)
- After Quick Win 3: Run ingestion of a large PDF, verify LanceDB directory doesn't
  bloat
- After Quick Win 4: Test concurrent ingestion with JOB_CONCURRENCY=2, verify no
  SQLITE_BUSY errors