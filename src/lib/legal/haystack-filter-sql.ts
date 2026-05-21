/**
 * Haystack filter → Kysely SQL compiler.
 *
 * Walks the AST returned by `HFilter.parse(filterStr)` from `haystack-core`
 * and emits `Expression<boolean>` nodes that compare `json_extract(tags, '$.x')`
 * paths. The exact `json_extract(tags, '$.X')` text is critical — Agent 1's
 * migrations install VIRTUAL generated columns with matching expressions so
 * SQLite can plan against ordinary indexes (see §12.2 of the research doc).
 *
 * Supported AST nodes:
 *   - has X                          (presence)
 *   - missing X                      (negated presence)
 *   - X == lit | X != lit            (eq, neq)
 *   - X < lit | <= | > | >=          (comparators; date strings + numbers)
 *   - a and b                        (and)
 *   - a or b                         (or)
 *   - not a / !a                     (not)
 *
 * Ref literals (`@case-1234`) are stored as the literal `@case-1234` string
 * in the JSON, so equality is a straight string compare.
 *
 * `haystack-core`'s AST node names vary slightly across versions; we accept
 * common synonyms. If the AST cannot be parsed, the function throws —
 * `repo.ts` / the route handler converts that to an err grid.
 */
import { Kysely, sql, ExpressionBuilder, Expression } from 'kysely'
import type { DB } from './kysely'

// `haystack-core` is a runtime dep; we import lazily so the build doesn't fail
// in environments where it's not yet installed.
type AnyNode = any

async function parseFilter(filterStr: string): Promise<AnyNode> {
  const mod: any = await import('haystack-core')
  const HFilter = mod.HFilter ?? mod.default?.HFilter
  if (!HFilter || typeof HFilter.parse !== 'function') {
    throw new Error('haystack-core HFilter.parse not available')
  }
  return HFilter.parse(filterStr)
}

/** Path to a JSON-extracted tag. Must match Agent 1's VIRTUAL column expressions. */
export function tagPath(tag: string) {
  // tag must be a bare identifier; haystack tag names are [a-zA-Z][a-zA-Z0-9_]*
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) {
    throw new Error(`Invalid Haystack tag identifier: ${tag}`)
  }
  return sql`json_extract(tags, ${'$.' + tag})`
}

// ---------- AST helpers -----------------------------------------------------

/**
 * Resolve a haystack-core node's type to a canonical string tag.
 *
 * `haystack-core`'s parser returns nodes whose `.type` getter is the numeric
 * `NodeType` enum (0=condOr, 1=condAnd, 2=has, 3=missing, 4=parens, 5=cmp,
 * 6=isa, 7=rel, 8=wildcardEq). The compiler used to read `.type` and lowercase
 * the resulting number, which yielded `'0'`, `'1'`, … and matched nothing —
 * EVERY filter failed with "Unsupported Haystack filter node: 0". Map the enum
 * back to its label, falling back to the constructor name for resilience.
 */
const NODE_TYPE_LABEL: Record<number, string> = {
  0: 'condor',
  1: 'condand',
  2: 'has',
  3: 'missing',
  4: 'parens',
  5: 'cmp',
  6: 'isa',
  7: 'rel',
  8: 'wildcardeq',
}

function nodeType(n: AnyNode): string {
  if (n && typeof n === 'object') {
    const rawType = (n as any).type
    if (typeof rawType === 'number' && NODE_TYPE_LABEL[rawType]) return NODE_TYPE_LABEL[rawType]
    if (typeof rawType === 'string') return rawType.toLowerCase()
    const ctor = (n as any).constructor?.name
    if (typeof ctor === 'string') {
      // CondOrNode → condor, HasNode → has, CmpNode → cmp, etc.
      return ctor.replace(/Node$/, '').toLowerCase()
    }
  }
  return ''
}

/**
 * Extract the tag identifier from a path-like node. `haystack-core` parses
 * `has X` as a HasNode whose `.path` getter returns either:
 *   - a TokenObj `{ type: 1, text: 'X' }` (single-segment path)
 *   - a paths object `{ type: 'paths', paths: ['X','Y'] }` (X->Y chained ref)
 *   - or raw string in older AST shapes.
 *
 * We only support single-segment paths against `json_extract(tags, '$.X')`;
 * chained paths (X->Y) would require a JOIN and are deferred. For chained
 * paths we return the FIRST segment so `case->name` becomes `has case` — a
 * benign degradation that keeps the picker working.
 */
function asPathName(n: AnyNode): string | null {
  if (n == null) return null
  if (typeof n === 'string') return n
  // TokenObj — most common shape from haystack-core
  if (typeof n.text === 'string' && n.text.length) return n.text
  if (typeof n.name === 'string' && n.name.length) return n.name
  // paths node
  if (Array.isArray((n as any).paths) && (n as any).paths.length) {
    const p0 = (n as any).paths[0]
    if (typeof p0 === 'string') return p0
    if (p0 && typeof p0.text === 'string') return p0.text
  }
  if (Array.isArray((n as any).segments) && (n as any).segments.length) {
    const s = (n as any).segments[0]
    return s?.text ?? s?.name ?? (typeof s === 'string' ? s : null)
  }
  return null
}

/**
 * Resolve a CmpNode's operator from its tokens. `haystack-core` doesn't
 * expose `.op` directly — the operator lives as the middle TokenObj in
 * `.tokens`, with a `type` string like `'equals'` / `'notEquals'` /
 * `'lessThan'` / `'lessThanOrEqual'` / `'greaterThan'` / `'greaterThanOrEqual'`.
 */
function cmpOperatorFromNode(n: AnyNode): '=' | '!=' | '<' | '<=' | '>' | '>=' | null {
  const cmpOp = (n as any).cmpOp
  const opText: string | undefined =
    typeof cmpOp?.text === 'string' ? cmpOp.text :
    typeof cmpOp?.type === 'string' ? cmpOp.type :
    undefined
  if (opText) {
    if (opText === '==' || opText === 'equals') return '='
    if (opText === '!=' || opText === 'notEquals') return '!='
    if (opText === '<=' || opText === 'lessThanOrEqual') return '<='
    if (opText === '>=' || opText === 'greaterThanOrEqual') return '>='
    if (opText === '<' || opText === 'lessThan') return '<'
    if (opText === '>' || opText === 'greaterThan') return '>'
  }
  // Fall back to scanning tokens for the comparator middle token
  const tokens = (n as any).tokens
  if (Array.isArray(tokens)) {
    for (const t of tokens) {
      const txt = t?.text
      if (txt === '==' || txt === '!=' || txt === '<=' || txt === '>=' || txt === '<' || txt === '>') {
        return txt as any
      }
    }
  }
  return null
}

/**
 * Extract the literal value from a CmpNode's rhs. The rhs is a TokenValue
 * `{ type: <number>, value: HVal }` whose embedded haystack value (HStr, HNum,
 * HRef, HDate, HBool, …) carries the actual data. We unwrap layered
 * representations defensively.
 */
function literalValue(n: AnyNode): { sql: Expression<any>; raw: any } {
  if (n == null) return { sql: sql`NULL`, raw: null }
  if (typeof n === 'string') return { sql: sql.lit(n), raw: n }
  if (typeof n === 'number') return { sql: sql.lit(n), raw: n }
  if (typeof n === 'boolean') return { sql: sql.lit(n ? 1 : 0), raw: n }
  // TokenValue { type, value: HVal } — recurse into .value
  if (n.value !== undefined) {
    // HRef / HStr / HNum etc. typically expose `.value` again or a JSON shape
    const v = n.value
    if (v && typeof v === 'object') {
      // Refs: HRef.value is the bare id; we want `@id`
      const ctor = v.constructor?.name ?? ''
      if (ctor === 'HRef') {
        const id = typeof v.value === 'string' ? v.value : String(v.value ?? '')
        const refStr = '@' + id.replace(/^@/, '')
        return { sql: sql.lit(refStr), raw: refStr }
      }
      if (ctor === 'HStr') {
        const s = typeof v.value === 'string' ? v.value : String(v.value ?? '')
        return { sql: sql.lit(s), raw: s }
      }
      if (ctor === 'HNum') {
        const num = typeof v.value === 'number' ? v.value : Number(v.value ?? 0)
        return { sql: sql.lit(num), raw: num }
      }
      if (ctor === 'HBool') {
        const b = !!v.value
        return { sql: sql.lit(b ? 1 : 0), raw: b }
      }
      if (ctor === 'HDate' || ctor === 'HDateTime') {
        const iso =
          typeof v.iso === 'function' ? v.iso() :
          typeof v.iso === 'string' ? v.iso :
          typeof v.value === 'string' ? v.value :
          String(v.value ?? '')
        return { sql: sql.lit(iso), raw: iso }
      }
      // Generic JSON fall-through
      if (typeof v.toJSON === 'function') {
        const j = v.toJSON()
        if (typeof j === 'string') return { sql: sql.lit(j), raw: j }
        if (j && typeof j.val === 'string') {
          const out = j._kind === 'ref' ? '@' + j.val : j.val
          return { sql: sql.lit(out), raw: out }
        }
      }
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      return literalValue(v)
    }
  }
  // Older shape: { val: 'abc', _kind: 'ref' } / etc.
  if (n.val !== undefined && typeof n.val !== 'object') {
    if (nodeType(n).includes('ref') || n._kind === 'ref') {
      const refStr = '@' + String(n.val).replace(/^@/, '')
      return { sql: sql.lit(refStr), raw: refStr }
    }
    return literalValue(n.val)
  }
  if (n.iso) return { sql: sql.lit(String(n.iso)), raw: String(n.iso) }
  if (typeof n.toJSON === 'function') {
    const j = n.toJSON()
    if (typeof j === 'string') return { sql: sql.lit(j), raw: j }
    if (j && typeof j.val === 'string') {
      const out = j._kind === 'ref' ? '@' + j.val : j.val
      return { sql: sql.lit(out), raw: out }
    }
  }
  // Last resort — TokenObj `{ text: '...' }`
  if (typeof n.text === 'string') return { sql: sql.lit(n.text), raw: n.text }
  return { sql: sql.lit(String(n)), raw: String(n) }
}

// ---------- compiler --------------------------------------------------------

function compileNode(
  node: AnyNode,
  eb: ExpressionBuilder<DB, any>,
): Expression<any> {
  const t = nodeType(node)

  // and / or
  if (t === 'and' || t === 'condand') {
    const kids = childrenOf(node).map((c) => compileNode(c, eb))
    if (kids.length === 0) return sql<boolean>`1=1` as any
    if (kids.length === 1) return kids[0]
    return eb.and(kids)
  }
  if (t === 'or' || t === 'condor') {
    const kids = childrenOf(node).map((c) => compileNode(c, eb))
    if (kids.length === 0) return sql<boolean>`1=1` as any
    if (kids.length === 1) return kids[0]
    return eb.or(kids)
  }
  if (t === 'not' || t === 'isnot' || t === 'neg') {
    const k = childrenOf(node)[0]
    return eb.not(compileNode(k, eb))
  }
  if (t === 'parens' || t === 'group') {
    const k = childrenOf(node)[0]
    return compileNode(k, eb)
  }

  // has / missing — path lives in node.path (TokenObj) for haystack-core,
  // or node.name on older shapes.
  if (t === 'has' || t === 'present') {
    const name = asPathName((node as any).path ?? (node as any).name)
    if (!name) throw new Error(`has-node missing tag name: ${JSON.stringify(node)}`)
    return eb(tagPath(name) as any, 'is not', null as any)
  }
  if (t === 'missing' || t === 'absent') {
    const name = asPathName((node as any).path ?? (node as any).name)
    if (!name) throw new Error(`missing-node has no tag name`)
    return eb(tagPath(name) as any, 'is', null as any)
  }

  // Comparators — `cmp` node in haystack-core 4.x. Operator lives in node.cmpOp
  // (TokenObj) or as the middle of node.tokens.
  if (t === 'cmp') {
    const op = cmpOperatorFromNode(node)
    if (!op) throw new Error(`cmp-node missing operator: ${JSON.stringify(node)}`)
    const name = asPathName((node as any).path ?? (node as any).lhs ?? (node as any).left)
    if (!name) throw new Error(`cmp-node missing lhs path: ${JSON.stringify(node)}`)
    const rhs = (node as any).val ?? (node as any).rhs ?? (node as any).right ?? (node as any).value
    const lit = literalValue(rhs)
    return eb(tagPath(name) as any, op, lit.sql as any)
  }

  // Fall-through: legacy comparator labels (eq/ne/lt/le/gt/ge) — kept for
  // resilience against older haystack-core minor versions.
  const cmp = comparatorOf(t)
  if (cmp) {
    const lhs = (node as any).path ?? (node as any).lhs ?? (node as any).left ?? (node as any).name
    const rhs = (node as any).val ?? (node as any).rhs ?? (node as any).right ?? (node as any).value
    const name = asPathName(lhs)
    if (!name) throw new Error(`Comparator node missing lhs path: ${JSON.stringify(node)}`)
    const lit = literalValue(rhs)
    return eb(tagPath(name) as any, cmp, lit.sql as any)
  }

  // `isa` and `rel` are Haystack 4 concepts we don't model in SQL (they
  // require traversal across kinds). Treat them as a no-op true so an
  // ambient `isa case` clause doesn't crash the read — the marker check
  // already narrowed us to the right table.
  if (t === 'isa' || t === 'rel' || t === 'wildcardeq') {
    return sql<boolean>`1=1` as any
  }

  throw new Error(`Unsupported Haystack filter node: ${t || JSON.stringify(node)}`)
}

function childrenOf(node: AnyNode): AnyNode[] {
  // haystack-core exposes children as `.nodes` (a getter backed by `$nodes`).
  if (Array.isArray(node?.nodes)) return node.nodes
  if (Array.isArray(node?.$nodes)) return node.$nodes
  if (Array.isArray(node?.children)) return node.children
  if (Array.isArray(node?.args)) return node.args
  if (node?.lhs && node?.rhs) return [node.lhs, node.rhs]
  if (node?.left && node?.right) return [node.left, node.right]
  if (node?.condition) return [node.condition]
  if (node?.operand) return [node.operand]
  return []
}

function comparatorOf(t: string): '=' | '!=' | '<' | '<=' | '>' | '>=' | null {
  if (t === 'eq' || t === 'equals' || t === '==') return '='
  if (t === 'ne' || t === 'neq' || t === 'notequal' || t === '!=') return '!='
  if (t === 'lt' || t === '<') return '<'
  if (t === 'le' || t === 'lte' || t === '<=') return '<='
  if (t === 'gt' || t === '>') return '>'
  if (t === 'ge' || t === 'gte' || t === '>=') return '>='
  return null
}

// ---------- public API ------------------------------------------------------

/**
 * Compile a Haystack filter string into a Kysely expression callback suitable
 * for `.where(eb => ...)`.
 */
export async function compileFilter(
  filterStr: string,
): Promise<(eb: ExpressionBuilder<DB, any>) => Expression<any>> {
  const ast = await parseFilter(filterStr)
  // Some parsers wrap the root in { filter: ... } or { expr: ... }
  const root = ast?.filter ?? ast?.expr ?? ast?.ast ?? ast
  return (eb) => compileNode(root, eb)
}

/**
 * Read rows from the given table matching a Haystack filter.
 * Errors (parse failure, missing column, missing table) bubble up so the
 * route handler can convert them to an err grid.
 */
export async function readByHaystack<T extends keyof DB>(
  db: Kysely<DB>,
  table: T,
  filterStr: string,
  limit?: number,
): Promise<DB[T][]> {
  const whereFn = await compileFilter(filterStr)
  let q = db.selectFrom(table as any).where(whereFn as any).selectAll()
  if (typeof limit === 'number' && limit > 0) q = q.limit(limit)
  const rows = await q.execute()
  return rows as DB[T][]
}
