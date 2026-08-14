import { useSyncExternalStore } from 'react';
import { getPreference, setPreference } from '@/lib/indexed-db';

/**
 * "Show all links" — the preference that restores the old view.
 *
 * Ref edges are hidden at rest (#67): with kind columns a filing's chain is
 * legible on hover, and 90 permanent lines were what made the canvas hard to
 * read in the first place. This toggle brings them all back for the user who
 * wants the whole picture at once, and it is a preference rather than a mode:
 * nothing else about the canvas changes while it is on.
 *
 * A store rather than a prop because the consumer is the per-edge component
 * rete renders — plumbing it through the canvas would mean rebuilding every
 * connection to flip a boolean.
 *
 * It persists like every other view preference in the app: a reader who wants
 * the whole web wants it on the next visit too, and a session-only toggle
 * would be the odd one out beside the scope settings.
 */

const PREFERENCE_KEY = 'scope.showAllLinks';

let showAll = false;
const listeners = new Set<() => void>();

export function setShowAllLinks(next: boolean) {
  if (showAll === next) return;
  showAll = next;
  for (const listener of listeners) listener();
  void setPreference(PREFERENCE_KEY, next).catch(() => {
    /* a preference that failed to save is not worth interrupting a canvas for */
  });
}

let hydrated = false;

/**
 * Read the stored preference once per page load. Both tabs call it; the guard
 * makes the second call free rather than a second round trip that could land
 * after the user has already toggled.
 */
export function hydrateShowAllLinks() {
  if (hydrated) return;
  hydrated = true;
  void getPreference<boolean>(PREFERENCE_KEY)
    .then(value => {
      if (typeof value === 'boolean' && value !== showAll) {
        showAll = value;
        for (const listener of listeners) listener();
      }
    })
    .catch(() => {
      /* no preference store, no preference */
    });
}

export function currentShowAllLinks(): boolean {
  return showAll;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return showAll;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useShowAllLinks(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
