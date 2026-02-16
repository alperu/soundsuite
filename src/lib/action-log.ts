/**
 * Action log helper — fire-and-forget persistence of action logs to the database.
 *
 * Usage (client-side):
 *   import { persistActionLog } from '@/lib/action-log';
 *   persistActionLog({ action: 'Run Parser', target: 'file.pdf', status: 'success', caseId: '...' });
 *
 * Usage (server-side):
 *   import { createActionLog } from '@/lib/action-log';
 *   await createActionLog({ action: 'document_added', target: 'file.pdf', caseId: '...', logType: 'document_added' });
 */

import { prisma } from '@/lib/db/prisma';

export interface ActionLogEntry {
  caseId?: string;
  action: string;
  target: string;
  status?: string;
  detail?: string;
  logType?: string;
}

/**
 * Server-side: create an action log entry directly via Prisma.
 */
export async function createActionLog(entry: ActionLogEntry) {
  return prisma.actionLog.create({
    data: {
      caseId: entry.caseId || null,
      action: entry.action,
      target: entry.target,
      status: entry.status || 'success',
      detail: entry.detail || null,
      logType: entry.logType || 'general',
    },
  });
}

/**
 * Client-side: fire-and-forget POST to the action-logs API.
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
