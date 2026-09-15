/**
 * Document.status is a plain `String` in prisma/schema.prisma — NOT an enum.
 * Every value below is written somewhere in the app today; this module is the
 * one place that enumerates them so a new value cannot silently vanish from a
 * list again.
 *
 * History worth knowing: 'DISCOVERED' (written by file-watcher.ts) appeared in
 * none of the four hand-copied status unions, so documents in that state
 * already disappear from the document grid, count towards no badge, and render
 * with `undefined` class names. Treat an unknown status as *displayable*, never
 * as a reason to drop a row — hence the `?? fallback` helpers here rather than
 * closed `as const` lookup maps.
 */

export const DOCUMENT_STATUSES = [
  'DISCOVERED',
  'QUEUED',
  'PROCESSING',
  'INDEXED',
  'FIXING_PARTIAL',
  'ERROR',
  'STOPPED',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Runtime membership test — `documents` come from the DB as bare strings. */
export function isKnownStatus(status: string): status is DocumentStatus {
  return (DOCUMENT_STATUSES as readonly string[]).includes(status);
}

/**
 * Display label. FIXING_PARTIAL must never render as the raw DB token, and a
 * partially-indexed INDEXED document reads as PARTIAL (a derived display state,
 * not a stored status).
 */
const LABELS: Record<string, string> = {
  FIXING_PARTIAL: 'FIXING',
  DISCOVERED: 'DISCOVERED',
};

export function statusLabel(status: string, isPartial = false): string {
  if (isPartial && status === 'INDEXED') return 'PARTIAL';
  return LABELS[status] ?? status;
}

/**
 * The document is being worked on right now, so destructive/re-ingest actions
 * must be disabled and cancel must be offered. FIXING_PARTIAL belongs here: a
 * full re-ingest started mid-repair races the repair over the same LanceDB rows.
 */
export function isBusyStatus(status: string): boolean {
  return status === 'PROCESSING' || status === 'QUEUED' || status === 'FIXING_PARTIAL';
}

/** A page repair is in flight (subset of isBusyStatus). */
export function isRepairing(status: string): boolean {
  return status === 'FIXING_PARTIAL';
}

/**
 * The document's chunks are live and searchable. A page repair does not remove
 * the good pages, so FIXING_PARTIAL counts as indexed for corpus denominators,
 * document pickers and anything scoped to "has vectors".
 */
export function hasLiveChunks(status: string): boolean {
  return status === 'INDEXED' || status === 'FIXING_PARTIAL';
}

/** Tailwind class fragments, open-ended so an unknown status still renders. */
export const STATUS_BG: Record<string, string> = {
  DISCOVERED: 'bg-slate-50',
  QUEUED: 'bg-gray-50',
  PROCESSING: 'bg-yellow-50',
  INDEXED: 'bg-green-50',
  FIXING_PARTIAL: 'bg-blue-50',
  ERROR: 'bg-red-50',
  STOPPED: 'bg-gray-100',
};

export const STATUS_DOT: Record<string, string> = {
  DISCOVERED: 'bg-slate-400',
  QUEUED: 'bg-gray-400',
  PROCESSING: 'bg-yellow-400',
  INDEXED: 'bg-green-500',
  FIXING_PARTIAL: 'bg-blue-500 animate-pulse',
  ERROR: 'bg-red-500',
  STOPPED: 'bg-gray-500',
};

export const STATUS_TEXT: Record<string, string> = {
  DISCOVERED: 'text-slate-600',
  QUEUED: 'text-gray-700',
  PROCESSING: 'text-yellow-700',
  INDEXED: 'text-green-700',
  FIXING_PARTIAL: 'text-blue-700',
  ERROR: 'text-red-700',
  STOPPED: 'text-gray-700',
};

export const STATUS_PILL: Record<string, string> = {
  DISCOVERED: 'bg-slate-100 text-slate-600',
  QUEUED: 'bg-gray-200 text-gray-700',
  PROCESSING: 'bg-yellow-100 text-yellow-700',
  INDEXED: 'bg-green-100 text-green-700',
  FIXING_PARTIAL: 'bg-blue-100 text-blue-700',
  ERROR: 'bg-red-100 text-red-700',
  STOPPED: 'bg-gray-200 text-gray-600',
};
