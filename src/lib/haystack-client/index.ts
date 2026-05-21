/**
 * Browser-side fetch wrapper for the same-origin Haystack proxy.
 *
 * - Targets `/api/haystack-proxy/[op]` so no bearer token is required.
 * - Returns parsed Hayson grids ({ _kind: 'grid', meta, cols, rows }).
 * - `read({ filter, id })` is the most common path for the tag panel.
 * - `defs()` is memoized at module level for 60 s — the XETO namespace is
 *   effectively static at runtime, so re-fetching on every panel mount is waste.
 *
 * A failure mode worth noting: the server returns HTTP 200 with an `err`
 * marker in `meta` for domain errors (per Haystack convention). Callers must
 * inspect `grid.meta.err` rather than HTTP status.
 */

export interface HaysonGrid {
  _kind?: 'grid'
  meta?: Record<string, unknown> & { err?: unknown; dis?: string }
  cols?: Array<{ name: string }>
  rows?: Array<Record<string, unknown>>
}

const BASE = '/api/haystack-proxy'

async function jsonFetch(url: string, init?: RequestInit): Promise<HaysonGrid> {
  const res = await fetch(url, init)
  if (!res.ok) {
    throw new Error(`Haystack ${url} → HTTP ${res.status}`)
  }
  return (await res.json()) as HaysonGrid
}

export function gridHasError(g: HaysonGrid | null | undefined): string | null {
  if (!g) return 'no response'
  const meta = g.meta ?? {}
  if (meta.err != null) return String(meta.dis ?? 'haystack err')
  return null
}

export function firstRow<T = Record<string, unknown>>(g: HaysonGrid | null | undefined): T | null {
  if (!g || !Array.isArray(g.rows) || !g.rows.length) return null
  return g.rows[0] as T
}

export async function read(opts: { filter: string; id?: string; limit?: number }): Promise<HaysonGrid> {
  const qs = new URLSearchParams()
  qs.set('filter', opts.filter)
  if (opts.id) qs.set('id', opts.id.startsWith('@') ? opts.id : `@${opts.id}`)
  if (opts.limit != null) qs.set('limit', String(opts.limit))
  return jsonFetch(`${BASE}/read?${qs.toString()}`)
}

export async function commit(payload: {
  id: string
  kind: string
  patch: Record<string, unknown>
}): Promise<HaysonGrid> {
  return jsonFetch(`${BASE}/commit`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/**
 * Create a new entity via Haystack commit. Equivalent to calling `commit`
 * with `id: 'new'`. The server INSERTs and returns a single-row grid
 * containing the assigned `id`. Use `firstRow(grid)` to read it back.
 */
export async function create(payload: {
  kind: string
  patch: Record<string, unknown>
}): Promise<HaysonGrid> {
  return jsonFetch(`${BASE}/commit`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'new', kind: payload.kind, patch: payload.patch }),
  })
}

// --- defs cache -------------------------------------------------------------

let defsCache: { at: number; data: HaysonGrid } | null = null
const DEFS_TTL_MS = 60_000

export async function defs(): Promise<HaysonGrid> {
  const now = Date.now()
  if (defsCache && now - defsCache.at < DEFS_TTL_MS) return defsCache.data
  const data = await jsonFetch(`${BASE}/defs`)
  defsCache = { at: now, data }
  return data
}

/** Build a `{ name: doc }` map from the `defs` grid for tooltip lookups. */
export function defsToDocMap(g: HaysonGrid | null | undefined): Record<string, string> {
  const map: Record<string, string> = {}
  if (!g || !Array.isArray(g.rows)) return map
  for (const row of g.rows) {
    const r = row as { def?: unknown; name?: unknown; doc?: unknown }
    // Server emits rows like { def: 'lib::name', lib, doc }. Extract the bare name.
    let name: string | null = null
    if (typeof r.def === 'string') {
      const m = /(?:::)?([A-Za-z_][A-Za-z0-9_]*)$/.exec(r.def)
      name = m ? m[1] : r.def
    } else if (typeof r.name === 'string') {
      name = r.name
    }
    if (name && typeof r.doc === 'string') map[name] = r.doc
  }
  return map
}
