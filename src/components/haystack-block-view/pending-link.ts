import { useSyncExternalStore } from 'react';

/**
 * A link being made in two steps: mark one end, then the other.
 *
 * The answer to the problem kind columns created — a drag needs both ends on
 * screen at an aimable zoom, and across seven columns and five case bands they
 * often aren't. "Link from here" on one block, pan or search your way to the
 * other, "Link to here". The picker solves the same problem from a list; this
 * solves it for the user who would rather go and look at the target.
 *
 * Deliberately NOT persisted: a half-made link is a thought in progress, not a
 * preference. Surviving a reload would mean restoring an intent whose context
 * the user no longer has in front of them.
 */

export interface PendingLink {
  sourceKey: string;
  /** The slot the eventual write lands in; omitted lets the rules choose. */
  slot?: string;
  /** What to call it in the canvas pill. */
  label: string;
}

let pending: PendingLink | null = null;
const listeners = new Set<() => void>();

export function setPendingLink(next: PendingLink | null) {
  pending = next;
  for (const listener of listeners) listener();
}

export function currentPendingLink(): PendingLink | null {
  return pending;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PendingLink | null {
  return pending;
}

function getServerSnapshot(): PendingLink | null {
  return null;
}

export function usePendingLink(): PendingLink | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
