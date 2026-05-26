/**
 * HaystackPreviewGrid
 *
 * Right-panel debug-visibility tab on /search. Shows a LIVE grid of records
 * matching the user's compiled Haystack filter, before the AI takes over.
 * Purpose: "see what we're sending out" — let the operator inspect the
 * structural filter and the records it resolves to.
 *
 * Props:
 *   - filter: compiled Haystack filter string (from buildHaystackFilter().filter)
 *   - kind:   optional `impliedKind` hint to pick which table to query
 *   - disabled: when true, renders empty state without firing requests
 *
 * Backed by POST /api/haystack/read-grid which wraps the legal SQL translator.
 */

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  filter: string
  kind?: string
  disabled?: boolean
}

interface GridResponse {
  count: number
  rows: any[]
  table: string
  filter: string
  resolvedFilter?: string
  debug?: {
    traversalCount: number
    intermediateIds?: number
    droppedClauses?: string[]
  }
  error?: string
}

// Hand-picked default columns by table — used when row keys aren't obvious.
const DEFAULT_COLUMNS: Record<string, string[]> = {
  Motion: ['id', 'motionType', 'caseRef', 'judgeRef', 'dueBy', 'hearingDate'],
  Case: ['id', 'caseNumber', 'caseName'],
  MotionEvent: ['id', 'motionRef', 'courtFilingDate', 'eventType'],
  MotionAttachment: ['id', 'motionRef', 'kind', 'filename'],
  Person: ['id', 'name', 'firstName', 'lastName'],
  PersonRole: ['id', 'personRef', 'caseRef', 'role'],
  Hearing: ['id', 'caseRef', 'hearingDate', 'department'],
}

function zeroStateMessage(data: GridResponse): string {
  const tc = data.debug?.traversalCount ?? 0
  const ii = data.debug?.intermediateIds
  const dropped = data.debug?.droppedClauses ?? []
  if (tc > 0 && ii === 0) {
    return 'Traversed records but found no matching case IDs.'
  }
  if (tc > 0 && (ii ?? 0) > 0) {
    return `Found ${ii} matching case${ii === 1 ? '' : 's'} but no records in ${data.table}.`
  }
  if (dropped.length > 0) {
    return `Some constraints couldn't be applied to ${data.table}: ${dropped.join(', ')}.`
  }
  return 'No records matched the compiled query.'
}

function shortId(v: any): string {
  if (v == null) return ''
  const s = String(v)
  return s.length > 12 ? s.slice(0, 8) + '…' : s
}

function formatCell(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    // Haystack ref `@id` or {_kind:'ref', val}
    if (v._kind === 'ref' && typeof v.val === 'string') return shortId(v.val)
    if (v._kind === 'dateTime' && typeof v.val === 'string') return v.val
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}

export function HaystackPreviewGrid({ filter, kind, disabled }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<GridResponse | null>(null)
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [reqNonce, setReqNonce] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  const trimmedFilter = (filter ?? '').trim()
  const isEmpty = !trimmedFilter || disabled

  // Debounced fetch on filter change.
  useEffect(() => {
    if (isEmpty) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const handle = setTimeout(() => {
      const ctrl = new AbortController()
      abortRef.current?.abort()
      abortRef.current = ctrl
      setLoading(true)
      setError(null)
      fetch('/api/haystack/read-grid', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter: trimmedFilter, kind, limit: 50 }),
      })
        .then(async (res) => {
          const json = await res.json().catch(() => ({ error: 'Invalid JSON response' }))
          if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
          return json as GridResponse
        })
        .then((json) => {
          setData(json)
          setLoading(false)
        })
        .catch((err) => {
          if (err?.name === 'AbortError') return
          setError(String(err?.message ?? err))
          setLoading(false)
          setData(null)
        })
    }, 500)
    return () => clearTimeout(handle)
  }, [trimmedFilter, kind, isEmpty, reqNonce])

  const columns = useMemo(() => {
    if (!data || !data.rows.length) {
      return DEFAULT_COLUMNS[data?.table ?? 'Motion'] ?? ['id']
    }
    const first = data.rows[0]
    const preferred = DEFAULT_COLUMNS[data.table] ?? []
    const present = preferred.filter((k) => k in first)
    if (present.length >= 2) return present
    return Object.keys(first).slice(0, 6)
  }, [data])

  const sortedRows = useMemo(() => {
    if (!data) return []
    if (!sortKey) return data.rows
    const out = [...data.rows]
    out.sort((a, b) => {
      const av = formatCell(a?.[sortKey])
      const bv = formatCell(b?.[sortKey])
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return out
  }, [data, sortKey, sortDir])

  function toggleSort(col: string) {
    if (sortKey === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(col)
      setSortDir('asc')
    }
  }

  // Empty state
  if (isEmpty) {
    return (
      <div className="p-4">
        <div className="text-center py-10">
          <p className="text-sm text-gray-400 font-medium">No filter compiled</p>
          <p className="text-xs text-gray-400 mt-1">
            Compose a filter (chips or `key:value`) to preview matching records.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Filter preview block */}
      <div className="border-b border-gray-200 p-2.5 bg-gray-50 sticky top-0 z-10">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
            Compiled filter
          </span>
          <button
            type="button"
            onClick={() => setReqNonce((n) => n + 1)}
            className="text-[11px] text-blue-600 hover:text-blue-800 font-medium"
            disabled={loading}
            data-testid="hpg-refresh"
          >
            {loading ? '…' : 'Refresh'}
          </button>
        </div>
        <pre className="text-[11px] font-mono text-gray-800 bg-white border border-gray-200 rounded px-2 py-1 overflow-x-auto whitespace-pre">
{trimmedFilter}
        </pre>
        {data?.resolvedFilter ? (
          <div className="mt-1" data-testid="hpg-resolved">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-0.5">
              SQL (resolved)
            </div>
            <pre className="text-[11px] font-mono text-gray-700 bg-white border border-gray-200 rounded px-2 py-1 overflow-x-auto whitespace-pre">
{data.resolvedFilter}
            </pre>
          </div>
        ) : null}
        <div className="text-[10px] text-gray-500 mt-1 flex justify-between">
          <span>Table: <span className="font-mono">{data?.table ?? '—'}</span></span>
          <span data-testid="hpg-count">
            {loading ? 'Loading…' : data ? `${data.count} record${data.count === 1 ? '' : 's'}` : '—'}
          </span>
        </div>
      </div>

      {/* Error bar */}
      {error && (
        <div
          className="bg-red-50 border-b border-red-200 text-red-700 text-xs px-3 py-2"
          data-testid="hpg-error"
        >
          {error}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        {loading && !data ? (
          <div className="flex justify-center items-center py-8">
            <div className="w-5 h-5 border-2 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        ) : data && data.rows.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-8" data-testid="hpg-zero">
            {zeroStateMessage(data)}
          </div>
        ) : data ? (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-white border-b border-gray-200 z-[1]">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    onClick={() => toggleSort(col)}
                    className="text-left px-2 py-1.5 font-semibold text-gray-600 cursor-pointer hover:bg-gray-50 whitespace-nowrap"
                  >
                    {col}
                    {sortKey === col && (sortDir === 'asc' ? ' ▲' : ' ▼')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, i) => (
                <tr
                  key={row.id ?? i}
                  className="border-b border-gray-100 hover:bg-blue-50/30"
                  data-testid="hpg-row"
                >
                  {columns.map((col) => (
                    <td
                      key={col}
                      className="px-2 py-1 font-mono text-gray-700 align-top"
                      title={formatCell(row?.[col])}
                    >
                      {col === 'id'
                        ? shortId(row?.[col])
                        : formatCell(row?.[col]).slice(0, 60)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  )
}

export default HaystackPreviewGrid
