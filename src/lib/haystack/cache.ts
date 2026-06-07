/**
 * Process-wide in-memory LRU for haystack ref → label lookups.
 *
 * Extracted from `api/haystack/[op]/route.ts` so the cache is a single shared
 * instance no matter how many route/handler modules read it. If the haystack
 * route is later split into per-op sub-routes, a module-local Map would fork
 * into one cache per route module — this singleton avoids that correctness
 * trap (a write that busts a label in one module must be seen by reads in
 * another).
 *
 * Why a cache at all: the case-management UI hits /api/haystack/read on every
 * panel render; without caching a Motion row with 8 refs would issue 8 queries
 * per page-view. Capped at 5000 entries, 60s TTL (labels rarely change and
 * read-staleness here is acceptable).
 */
const LABEL_CACHE = new Map<string, { label: string; expiresAt: number }>()
const LABEL_CACHE_MAX = 5000
const LABEL_CACHE_TTL_MS = 60_000

export function cacheGet(key: string): string | undefined {
  const hit = LABEL_CACHE.get(key)
  if (!hit) return undefined
  if (hit.expiresAt < Date.now()) {
    LABEL_CACHE.delete(key)
    return undefined
  }
  // touch — refresh insertion order for naive LRU
  LABEL_CACHE.delete(key)
  LABEL_CACHE.set(key, hit)
  return hit.label
}

export function cacheSet(key: string, label: string): void {
  if (LABEL_CACHE.size >= LABEL_CACHE_MAX) {
    const firstKey = LABEL_CACHE.keys().next().value
    if (firstKey !== undefined) LABEL_CACHE.delete(firstKey)
  }
  LABEL_CACHE.set(key, { label, expiresAt: Date.now() + LABEL_CACHE_TTL_MS })
}

/** Drop a single cached label entry by its `${target}:${id}` key. */
export function cacheDelete(key: string): void {
  LABEL_CACHE.delete(key)
}
