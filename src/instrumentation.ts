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

  // Fire-and-forget — server must always start regardless of worker init outcome
  import('./services/worker-init')
    .then(({ getWorkerManager }) => getWorkerManager())
    .catch((err) => {
      console.error('[instrumentation] Failed to auto-start worker pool:', err);
    });
}
