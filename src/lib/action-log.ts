/**
 * Action log helper — fire-and-forget persistence of action logs to the database.
 *
 * Client-safe: this module is intentionally free of server-only imports
 * (no Prisma, no Node native bindings) so client components like the
 * case-management page can import it without dragging the DB driver into
 * the client bundle. Writes go through the /api/admin/action-logs endpoint.
 *
 * Usage:
 *   import { persistActionLog } from '@/lib/action-log';
 *   persistActionLog({ action: 'Run Parser', target: 'file.pdf', status: 'success', caseId: '...' });
 */

export interface ActionLogEntry {
  caseId?: string;
  action: string;
  target: string;
  status?: string;
  detail?: string;
  logType?: string;
}

/**
 * Fire-and-forget POST to the action-logs API. Safe to call from client
 * components — uses fetch, never imports the database driver directly.
 */
export function persistActionLog(entry: ActionLogEntry) {
  fetch('/api/admin/action-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  }).catch(() => {
    // silent — action log persistence should never block UI
  });
}
