/**
 * Next.js instrumentation hook — runs once on server start.
 *
 * Auto-starts the PID worker pool so documents don't get stuck in
 * QUEUED status waiting for a manual API hit.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Enable WAL mode + busy_timeout before any queries run
  import('./lib/db/prisma')
    .then(({ applySqlitePragmas }) => applySqlitePragmas())
    .catch((err) => {
      console.error('[instrumentation] Failed to apply SQLite pragmas:', err);
    });

  // Seed the role registry on first run (idempotent; no-op once seeded).
  import('./lib/db/role-registry-seed')
    .then(({ seedRoleRegistry }) => seedRoleRegistry())
    .catch((err) => {
      console.error('[instrumentation] Role registry seed failed:', err);
    });

  // Fire-and-forget — server must always start regardless of worker init outcome
  import('./services/worker-init')
    .then(({ getWorkerManager }) => getWorkerManager())
    .catch((err) => {
      console.error('[instrumentation] Failed to auto-start worker pool:', err);
    });

  // Reranker deep-health watchdog — auto-restarts deadlocked vLLM workers.
  // Idempotent; safe across HMR reloads.
  import('./lib/search/reranker-watchdog')
    .then(({ startRerankerWatchdog }) => startRerankerWatchdog())
    .catch((err) => {
      console.error('[instrumentation] Failed to start reranker watchdog:', err);
    });
}
