/**
 * Module-scoped chat session identity.
 *
 * The Deep/Compare toggles navigate between route segments
 * (/search/ai ↔ /search/ai/deep), which REMOUNTS SearchInterface. Component
 * state resets and — before this module existed — a fresh `session-${now}` id
 * was minted on every mount. The singleton runners still held the completed
 * turns, but their mirror effects gate on `snapshot.sessionId ===
 * currentSessionId`, and the freshly minted id could never match, so the
 * conversation appeared wiped (permanently: toggling back minted yet another
 * id).
 *
 * Keeping the id at module scope — like the runners themselves — means a
 * remount resumes the same session and the mirror effects rehydrate the turns
 * from the runner snapshots.
 */

let currentId: string | null = null;

/** Current chat session id, minting one on first use per page load. */
export function getChatSessionId(): string {
  if (!currentId) currentId = `session-${Date.now()}`;
  return currentId;
}

/** Write-through from every place that changes the session (New Chat, history
 *  load, case-scope change) so remounts resume the right session. */
export function setChatSessionId(id: string): void {
  currentId = id;
}
