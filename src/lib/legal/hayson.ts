/**
 * Hayson (Haystack JSON, version 4) encoder/decoder.
 *
 * Hand-rolled per the Haystack 4 spec so we don't depend on a particular
 * haystack-core export shape. The shapes we emit:
 *
 *   Grid:   { _kind: "grid", meta: {...}, cols: [{name, meta?}], rows: [{...}] }
 *   Ref:    { _kind: "ref", val: "case-1234", dis?: "..." }
 *   Date:   { _kind: "date", val: "2026-05-20" }
 *   DateTime: { _kind: "dateTime", val: "2026-05-20T12:00:00Z", tz?: "UTC" }
 *   Marker: { _kind: "marker" }
 *   NA / Remove similar
 *
 * Plain JSON values (string, number, bool, null) pass through unchanged.
 *
 * `err` is signalled per Haystack convention: the grid meta carries a marker
 * named "err" plus `dis` (display) and optional `errTrace` strings. HTTP
 * status stays 200; clients check the marker.
 */

export const HAYSON_MIME = 'application/vnd.haystack+json;version=4'

export type HaysonValue =
  | string
  | number
  | boolean
  | null
  | { _kind: 'ref'; val: string; dis?: string }
  | { _kind: 'date'; val: string }
  | { _kind: 'dateTime'; val: string; tz?: string }
  | { _kind: 'marker' }
  | { _kind: 'remove' }
  | { _kind: 'na' }
  | { _kind: 'grid'; meta: Record<string, HaysonValue>; cols: HaysonCol[]; rows: HaysonRow[] }
  | { [k: string]: HaysonValue }
  | HaysonValue[]

export interface HaysonCol {
  name: string
  meta?: Record<string, HaysonValue>
}

export type HaysonRow = Record<string, HaysonValue>

export const MARKER: HaysonValue = { _kind: 'marker' }
export const ref = (val: string, dis?: string): HaysonValue =>
  dis ? { _kind: 'ref', val: val.replace(/^@/, ''), dis }
      : { _kind: 'ref', val: val.replace(/^@/, '') }
export const date = (val: string): HaysonValue => ({ _kind: 'date', val })
export const dateTime = (val: string, tz?: string): HaysonValue =>
  tz ? { _kind: 'dateTime', val, tz } : { _kind: 'dateTime', val }

/**
 * Convert an arbitrary JS value into a Hayson-safe value. Recognises Date
 * objects, raw `@x` ref strings, and nested objects/arrays. Strings that
 * look like ISO dates remain plain strings — the caller should wrap them
 * with `date()` / `dateTime()` if the type matters.
 */
export function toHayson(v: any): HaysonValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    if (/^@[A-Za-z0-9._:-]+$/.test(v)) return ref(v)
    return v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return dateTime(v.toISOString(), 'UTC')
  if (Array.isArray(v)) return v.map(toHayson) as HaysonValue[]
  if (typeof v === 'object') {
    // Pass through already-tagged Hayson kinds verbatim
    if (typeof v._kind === 'string') return v as HaysonValue
    const out: Record<string, HaysonValue> = {}
    for (const k of Object.keys(v)) out[k] = toHayson(v[k])
    return out
  }
  return String(v)
}

/**
 * Build a grid from an array of rows. Columns are inferred from the union of
 * keys across rows in insertion order. Tag values are filtered into the row
 * — rows whose `tags` column is a JSON string get parsed and flattened.
 */
export function encodeGrid(
  rows: any[],
  meta: Record<string, HaysonValue> = {},
): string {
  const flat = rows.map(flattenTags)
  const colSet = new Set<string>()
  for (const r of flat) for (const k of Object.keys(r)) colSet.add(k)
  const cols: HaysonCol[] = Array.from(colSet).map((name) => ({ name }))
  const grid: HaysonValue = {
    _kind: 'grid',
    meta: { ver: '4.0', ...meta },
    cols,
    rows: flat.map((r) => {
      const out: HaysonRow = {}
      for (const k of Object.keys(r)) out[k] = toHayson(r[k])
      return out
    }),
  }
  return JSON.stringify(grid)
}

/**
 * Flatten a row's `tags` JSON column into top-level keys (tags take precedence
 * over base columns if a name collides). The original `tags` field is dropped.
 */
function flattenTags(row: any): Record<string, any> {
  if (!row || typeof row !== 'object') return row
  const { tags, ...base } = row
  let parsed: Record<string, any> | undefined
  if (typeof tags === 'string' && tags.length) {
    try { parsed = JSON.parse(tags) } catch { /* ignore */ }
  } else if (tags && typeof tags === 'object') {
    parsed = tags
  }
  return { ...base, ...(parsed ?? {}) }
}

/** Error grid (Haystack convention: HTTP 200, meta carries `err` marker). */
export function errGrid(message: string, trace?: string): string {
  const meta: Record<string, HaysonValue> = {
    ver: '4.0',
    err: MARKER,
    dis: message,
  }
  if (trace) meta.errTrace = trace
  return JSON.stringify({ _kind: 'grid', meta, cols: [{ name: 'empty' }], rows: [] })
}

/** OK grid with no payload — used for ops like `close`. */
export function okGrid(): string {
  return JSON.stringify({
    _kind: 'grid',
    meta: { ver: '4.0' },
    cols: [{ name: 'empty' }],
    rows: [],
  })
}

/** Single-row grid built from a flat object. */
export function singletonGrid(
  row: Record<string, any>,
  meta: Record<string, HaysonValue> = {},
): string {
  return encodeGrid([row], meta)
}
