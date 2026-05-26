/**
 * POST /api/haystack/read-grid
 *
 * Debug-visibility wrapper around the unified search pipeline. Used by the
 * in-app Haystack right-panel on /search to preview which records match the
 * currently-compiled boolean filter *before* the AI takes over.
 *
 * Routing (task #71): this endpoint uses `parseBooleanQuery` +
 * `extractFieldFilters` + `resolvePrismaFilters` directly — the same pipeline
 * the search side uses. The legacy `readByHaystack` translator is intentionally
 * NOT used here; it remained MCP-only and couldn't handle path traversal
 * (`case->judge->displayName`) or knew the LanceDB `caseRef→case_id` alias.
 *
 * Unlike `/api/haystack/[op]` this route:
 *   - Returns plain JSON (not Hayson) for easy client consumption.
 *   - Does not require the HAYSTACK_API_KEY header (same-origin debug surface).
 *   - Picks the Kysely table from the fields referenced in the parsed AST
 *     (with an optional `kind` hint as the tie-breaker).
 *
 * Body: { filter: string, kind?: string, limit?: number }
 * Response: {
 *   count, rows, table, filter,
 *   resolvedFilter: string,            // SQL WHERE the grid actually ran
 *   debug: {
 *     droppedClauses?: string[],       // clauses we dropped because the
 *                                       // target table doesn't have that column
 *     traversalCount: number,           // # prisma traversals run
 *     intermediateIds?: number,         // # case ids the traversals resolved
 *   }
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'kysely'
import { db, type DB } from '@/lib/legal/kysely'
import { prisma } from '@/lib/db/prisma'
import { parseBooleanQuery, type Node } from '@/lib/search/boolean-query'
import {
  extractFieldFilters,
  resolvePrismaFilters,
  FIELD_RESOLVERS,
  type LegalSchemaClient,
} from '@/lib/search/boolean-to-fts'
import { logger } from '@/lib/logger'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

type TableName = keyof DB

const VALID_TABLES: ReadonlySet<TableName> = new Set<TableName>([
  'Case',
  'Motion',
  'MotionEvent',
  'MotionAttachment',
  'Person',
  'PersonRole',
  'Hearing',
  'Document',
])

function normalizeKind(kind: string | undefined): TableName | null {
  if (!kind) return null
  const k = kind.toLowerCase()
  const map: Record<string, TableName> = {
    case: 'Case',
    motion: 'Motion',
    motionevent: 'MotionEvent',
    motionattachment: 'MotionAttachment',
    person: 'Person',
    personrole: 'PersonRole',
    hearing: 'Hearing',
    document: 'Document',
  }
  return map[k] ?? null
}

/**
 * LanceDB-style underscore-case columns referenced by `extractFieldFilters`
 * (see FIELD_RESOLVERS in boolean-to-fts.ts) mapped to the per-Prisma-table
 * column they correspond to.
 *
 * Each entry: lanceCol → { TableName: prismaCol | null }.
 * A `null` means the field simply isn't present on that table (so the clause
 * referencing it should be dropped with a `droppedClauses` note).
 *
 * Keep this list small: only columns FIELD_RESOLVERS can produce.
 */
const COLUMN_MAP: Record<string, Partial<Record<TableName, string | null>>> = {
  case_id: {
    Case: 'id',                     // Case's own primary key
    Motion: 'caseId',
    MotionEvent: 'caseId',
    MotionAttachment: 'caseId',
    Document: 'caseId',
    Hearing: 'caseId',
    PersonRole: null,                // polymorphic via scopeKind/scopeId
    Person: null,
  },
  case_number: {
    Case: 'caseNumber',
    Motion: null,
    MotionEvent: null,
    MotionAttachment: null,
    Document: null,
    Hearing: null,
    PersonRole: null,
    Person: null,
  },
  document_id: {
    Document: 'id',
    MotionEvent: 'documentId',
    MotionAttachment: 'documentId',
    Case: null, Motion: null, Person: null, PersonRole: null, Hearing: null,
  },
  filing_id: {
    Motion: 'filingId',
    Document: 'filingId',
    Case: null, MotionEvent: null, MotionAttachment: null,
    Person: null, PersonRole: null, Hearing: null,
  },
  filing_type: {
    // No 'filingType' on any of our grid tables — it lives on Filing.
    Case: null, Motion: null, MotionEvent: null, MotionAttachment: null,
    Document: null, Hearing: null, Person: null, PersonRole: null,
  },
  document_type: {
    Document: 'documentType',
    // `motionType` aliases to document_type in FIELD_RESOLVERS but there is
    // no documentType column on Motion — drop on Motion.
    Motion: null,
    Case: null, MotionEvent: null, MotionAttachment: null,
    Hearing: null, Person: null, PersonRole: null,
  },
  volume_number: {
    // Lives on Filing only — not on any grid table.
    Case: null, Motion: null, MotionEvent: null, MotionAttachment: null,
    Document: null, Hearing: null, Person: null, PersonRole: null,
  },
  chunk_index: {
    Case: null, Motion: null, MotionEvent: null, MotionAttachment: null,
    Document: null, Hearing: null, Person: null, PersonRole: null,
  },
  page_number: {
    Case: null, Motion: null, MotionEvent: null, MotionAttachment: null,
    Document: null, Hearing: null, Person: null, PersonRole: null,
  },
}

interface RewrittenClause {
  /** Original clause as emitted by the pipeline (LanceDB-style). */
  original: string
  /** Rewritten clause for the chosen table, or null when dropped. */
  rewritten: string | null
}

const CLAUSE_RE = /^([a-z_][a-z0-9_]*)\s+(=|!=|>=|<=|>|<|IN|NOT IN)\s+(.+)$/i

/**
 * Translate a single LanceDB-style where-clause to a per-table Prisma column,
 * leaving the operator + value untouched (the value is already SQL-escaped
 * by `boolean-to-fts.ts`).
 *
 * Returns { rewritten:null } when the column doesn't map to the table.
 */
function translateClauseForTable(clause: string, table: TableName): RewrittenClause {
  const m = clause.match(CLAUSE_RE)
  if (!m) {
    // Unparseable — pass through unchanged. This can only happen if
    // extractFieldFilters changes its output format; we keep the clause as
    // a safety net so the SQL still runs (or fails loudly).
    return { original: clause, rewritten: clause }
  }
  const [, col, op, rhs] = m
  const mapping = COLUMN_MAP[col]
  if (!mapping) {
    // Column not in our map at all → drop with a log.
    logger?.warn?.('read-grid: unknown LanceDB column — dropping clause', { col, table })
    return { original: clause, rewritten: null }
  }
  const prismaCol = mapping[table]
  if (prismaCol === undefined) {
    // Not declared for this table; conservatively drop.
    return { original: clause, rewritten: null }
  }
  if (prismaCol === null) {
    return { original: clause, rewritten: null }
  }
  return { original: clause, rewritten: `"${prismaCol}" ${op} ${rhs}` }
}

/**
 * Walk the AST and collect every TERM's first path segment.
 * Used to pick the target table when no `kind` hint is given.
 */
function collectFieldsReferenced(node: Node | null): string[] {
  const out = new Set<string>()
  const visit = (n: Node) => {
    if (n.op === 'TERM') {
      if (n.path && n.path.length > 0) out.add(n.path[0])
      return
    }
    if (n.op === 'NOT') return visit(n.child)
    for (const c of n.children) visit(c)
  }
  if (node) visit(node)
  return [...out]
}

/**
 * Decide the grid's target table.
 *
 * Strategy:
 *   1. Honour an explicit `kind` hint from the body.
 *   2. Scan the parsed AST (the OUTPUT of extractFieldFilters — i.e. the
 *      strippedAst — plus the lifted prisma requests + lanceWhereClauses) for
 *      fields that strongly imply a table.
 *   3. Default to Case — the broadest, most useful baseline grid.
 *
 * Heuristics here are intentionally simple and explicit. Adding a field?
 * Update one row in the table below.
 */
function pickTable(
  fieldsReferenced: string[],
  lanceWhereClauses: string[],
  kindHint: TableName | null,
): TableName {
  if (kindHint) return kindHint

  // documentType-bearing → Document.
  if (
    fieldsReferenced.includes('documentType') ||
    lanceWhereClauses.some((c) => c.startsWith('document_type'))
  ) return 'Document'

  // motionType / motion-specific fields → Motion (motionType maps to
  // document_type in FIELD_RESOLVERS but for the grid we want Motion rows).
  if (fieldsReferenced.includes('motionType')) return 'Motion'

  // Multi-segment paths or judge/movant/respondent traversals usually want a
  // Motion-rooted grid (each motion has the judge/movant column).
  if (fieldsReferenced.some((f) => f === 'judgeRef' || f === 'movantRef' || f === 'respondentRef'))
    return 'Motion'

  // Person-only fields.
  if (fieldsReferenced.some((f) => f === 'displayName' || f === 'email' || f === 'barNumber'))
    return 'Person'

  return 'Case'
}

/**
 * Detect an OR-only subtree of same-field equality leaves and lift them to
 * `<col> IN (...)`. This complements `extractFieldFilters`, which refuses to
 * lift field-qualified terms under an OR ancestor (correct for the LanceDB
 * FTS arm, irrelevant for the SQL grid arm).
 *
 * The function walks the AST, finds OR nodes whose children are all
 * field-eq TERMs on the SAME field, lifts them into a single SQL clause, and
 * returns the residual AST (with the lifted OR-subtree removed if its parent
 * is AND or the OR was the root).
 */
function liftOrSameField(node: Node | null): {
  whereClauses: string[]
  ast: Node | null
} {
  const whereClauses: string[] = []
  if (!node) return { whereClauses, ast: null }

  // Lift a self-contained OR subtree of same-field equality leaves into
  // `col IN (...)`. Returns null if subtree doesn't qualify.
  function tryLiftOrSubtree(n: Node): string | null {
    if (n.op !== 'OR') return null
    let field: string | null = null
    let resolverCol: string | null = null
    const values: string[] = []
    for (const c of n.children) {
      if (c.op !== 'TERM') return null
      if (!c.path || c.path.length !== 1) return null
      const cmp = c.compareOp ?? '=='
      if (cmp !== '==') return null
      const f = c.path[0]
      const resolver = FIELD_RESOLVERS[f]
      if (!resolver) return null
      let col: string | null = null
      if (resolver.kind === 'lance-scalar') col = resolver.column
      else if (resolver.kind === 'lance-scalar-ref') col = resolver.column
      else return null   // prisma-traverse OR is out of scope here
      if (field === null) { field = f; resolverCol = col }
      else if (field !== f || resolverCol !== col) return null
      values.push(c.value)
    }
    if (!resolverCol || values.length === 0) return null
    const quoted = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')
    return `${resolverCol} IN (${quoted})`
  }

  function visit(n: Node): Node | null {
    if (n.op === 'OR') {
      const lifted = tryLiftOrSubtree(n)
      if (lifted) {
        whereClauses.push(lifted)
        return null
      }
      // Recurse — but field-eq leaves under non-liftable OR remain in AST.
      const kids: Node[] = []
      for (const c of n.children) {
        const r = visit(c)
        if (r) kids.push(r)
      }
      if (kids.length === 0) return null
      if (kids.length === 1) return kids[0]
      return { op: 'OR', children: kids }
    }
    if (n.op === 'AND') {
      const kids: Node[] = []
      for (const c of n.children) {
        const r = visit(c)
        if (r) kids.push(r)
      }
      if (kids.length === 0) return null
      if (kids.length === 1) return kids[0]
      return { op: 'AND', children: kids }
    }
    if (n.op === 'NOT') {
      // Don't peel apart NOTs — same reasoning as extractFieldFilters.
      return n
    }
    return n
  }

  const ast = visit(node)
  return { whereClauses, ast }
}

export async function POST(req: NextRequest) {
  let body: { filter?: unknown; kind?: unknown; limit?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const filter: string = typeof body?.filter === 'string' ? body.filter.trim() : ''
  const kindHint: TableName | null = normalizeKind(
    typeof body?.kind === 'string' ? body.kind : undefined,
  )
  const limit: number = Math.min(
    Math.max(1, Number(body?.limit) || DEFAULT_LIMIT),
    MAX_LIMIT,
  )

  if (!filter) {
    const table = kindHint ?? 'Case'
    return NextResponse.json({
      count: 0,
      rows: [],
      table,
      filter: '',
      resolvedFilter: '',
      debug: { traversalCount: 0 },
    })
  }

  // 1. Parse.
  const parse = parseBooleanQuery(filter)
  if (!parse.ok) {
    return NextResponse.json(
      { error: parse.error, position: parse.position, filter },
      { status: 400 },
    )
  }

  // 2a. SQL-only pre-pass: lift OR-of-same-field equality (caseRef==@u1 or
  // caseRef==@u2 ...) into `col IN (...)`. Runs BEFORE extractFieldFilters so
  // the field metadata is still on the TERM nodes — extractFieldFilters would
  // degrade them under an OR ancestor.
  const { whereClauses: orInClauses, ast: afterOrLift } = liftOrSameField(parse.ast)

  // 2b. Lift LanceDB-style scalar clauses + collect prisma-traverse requests.
  const { whereClauses: lanceClauses, prismaRequests, ast: residualAst } =
    afterOrLift
      ? extractFieldFilters(afterOrLift)
      : { whereClauses: [], prismaRequests: [], ast: null }

  // 3. Resolve prisma-traverses to `case_id IN (...)` predicates.
  let prismaClauses: string[] = []
  let intermediateIds = 0
  if (prismaRequests.length > 0) {
    try {
      const { whereClauses } = await resolvePrismaFilters(
        prismaRequests,
        prisma as unknown as LegalSchemaClient,
      )
      prismaClauses = whereClauses
      // Count resolved IDs across all `case_id IN ('...', ...)` predicates.
      for (const c of whereClauses) {
        const m = c.match(/case_id (?:NOT )?IN \((.+)\)$/)
        if (m) intermediateIds += m[1].split(',').length
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return NextResponse.json(
        { error: `Prisma traversal failed: ${message}`, filter },
        { status: 500 },
      )
    }
  }

  // 4. Pick the target table.
  const fields = collectFieldsReferenced(residualAst)
  const allLanceClauses = [...lanceClauses, ...orInClauses, ...prismaClauses]
  const table = pickTable(fields, allLanceClauses, kindHint)

  // 5. Translate every clause to per-table columns; drop the ones that don't
  // map to a column on the chosen table.
  const droppedClauses: string[] = []
  const sqlPieces: string[] = []
  for (const clause of allLanceClauses) {
    const { rewritten, original } = translateClauseForTable(clause, table)
    if (rewritten === null) {
      droppedClauses.push(original)
    } else {
      sqlPieces.push(rewritten)
    }
  }

  // Notable: the residualAst may still contain literal text TERMs that were
  // degraded (unknown fields, NOT'd path traversals, etc.). We do NOT push
  // those into the SQL grid — they were free-text fallbacks for the FTS arm.
  // For the grid we surface them via droppedClauses so the operator can see
  // why their query may be wider than expected.
  if (residualAst) {
    const lit = collectDegradedLiterals(residualAst)
    for (const l of lit) droppedClauses.push(`text~="${l}"`)
  }

  const whereSql = sqlPieces.length > 0 ? sqlPieces.join(' AND ') : '1 = 1'

  // 6. Execute via Kysely raw SQL. We've already SQL-escaped values; column
  // names came from our static map (no user data).
  try {
    const stmt = sql<Record<string, unknown>>`
      SELECT * FROM ${sql.ref(table)}
      WHERE ${sql.raw(whereSql)}
      LIMIT ${sql.lit(limit)}
    `
    const result = await stmt.execute(db)
    const rows = result.rows ?? []
    return NextResponse.json({
      count: rows.length,
      rows,
      table,
      filter,
      resolvedFilter: whereSql,
      debug: {
        traversalCount: prismaRequests.length,
        intermediateIds: prismaRequests.length > 0 ? intermediateIds : undefined,
        droppedClauses: droppedClauses.length > 0 ? droppedClauses : undefined,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      {
        error: message,
        table,
        filter,
        resolvedFilter: whereSql,
        debug: { traversalCount: prismaRequests.length },
      },
      { status: 500 },
    )
  }
}

// Collect leaf TERM values from the residual AST (degraded literals). These
// were left in the FTS arm when the pipeline couldn't lift them — surfaced
// here only so the operator knows the grid is not enforcing them.
function collectDegradedLiterals(node: Node): string[] {
  const out: string[] = []
  const visit = (n: Node) => {
    if (n.op === 'TERM') { out.push(n.value); return }
    if (n.op === 'NOT') { visit(n.child); return }
    for (const c of n.children) visit(c)
  }
  visit(node)
  return out
}
