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

function nodeType(n: AnyNode): string {
  // haystack-core uses `type` or `nodeType`; sometimes a class with `.constructor.name`.
  return (
    n?.type ??
    n?.nodeType ??
    n?.kind ??
    n?.constructor?.name ??
    ''
  ).toString().toLowerCase()
}

function asPathName(n: AnyNode): string | null {
  // Path nodes either expose .name, .segments[0].name, or .path as string
  if (typeof n === 'string') return n
  if (n?.name) return String(n.name)
  if (Array.isArray(n?.segments) && n.segments.length) {
    const s = n.segments[0]
    return s?.name ?? (typeof s === 'string' ? s : null)
  }
  if (n?.path && typeof n.path === 'string') return n.path
  if (Array.isArray(n?.paths) && n.paths.length) return String(n.paths[0])
  return null
}

function literalValue(n: AnyNode): { sql: Expression<any>; raw: any } {
  // Refs: `@case-1`. haystack-core may give { _kind: 'ref', val: 'case-1' } or HRef instance.
  if (n == null) return { sql: sql`NULL`, raw: null }
  if (typeof n === 'string') return { sql: sql.lit(n), raw: n }
  if (typeof n === 'number') return { sql: sql.lit(n), raw: n }
  if (typeof n === 'boolean') return { sql: sql.lit(n ? 1 : 0), raw: n }
  // Common haystack-core literal wrappers
  if (n.value !== undefined && typeof n.value !== 'object') return literalValue(n.value)
  if (n.val !== undefined && typeof n.val !== 'object') {
    // Ref literal
    if (nodeType(n).includes('ref') || n._kind === 'ref') {
      const refStr = '@' + String(n.val)
      return { sql: sql.lit(refStr), raw: refStr }
    }
    return literalValue(n.val)
  }
  // Date / DateTime — compare as ISO string
  if (n.iso) return { sql: sql.lit(String(n.iso)), raw: String(n.iso) }
  if (typeof n.toJSON === 'function') {
    const j = n.toJSON()
    if (typeof j === 'string') return { sql: sql.lit(j), raw: j }
    if (j && typeof j.val === 'string') {
      const v = j._kind === 'ref' ? '@' + j.val : j.val
      return { sql: sql.lit(v), raw: v }
    }
  }
  // Last resort
  return { sql: sql.lit(String(n)), raw: String(n) }
}

// ---------- compiler --------------------------------------------------------

function compileNode(
  node: AnyNode,
  eb: ExpressionBuilder<DB, any>,
): Expression<any> {
  const t = nodeType(node)

  // and / or — children in .children, .nodes, .args, or .lhs/.rhs
  if (t === 'and' || t === 'condand') {
    const kids = childrenOf(node).map((c) => compileNode(c, eb))
    return eb.and(kids)
  }
  if (t === 'or' || t === 'condor') {
    const kids = childrenOf(node).map((c) => compileNode(c, eb))
    return eb.or(kids)
  }
  if (t === 'not' || t === 'isnot' || t === 'neg') {
    const k = childrenOf(node)[0]
    return eb.not(compileNode(k, eb))
  }
  if (t === 'parens' || t === 'group') {
    return compileNode(childrenOf(node)[0], eb)
  }

  // has / missing
  if (t === 'has' || t === 'present') {
    const name = asPathName(node.path ?? node.name ?? node)
    if (!name) throw new Error(`has-node missing tag name: ${JSON.stringify(node)}`)
    return eb(tagPath(name), 'is not', null as any)
  }
  if (t === 'missing' || t === 'absent') {
    const name = asPathName(node.path ?? node.name ?? node)
    if (!name) throw new Error(`missing-node has no tag name`)
    return eb(tagPath(name), 'is', null as any)
  }

  // Comparators
  const cmp = comparatorOf(t)
  if (cmp) {
    const lhs = node.path ?? node.lhs ?? node.left ?? node.name
    const rhs = node.val ?? node.rhs ?? node.right ?? node.value
    const name = asPathName(lhs)
    if (!name) throw new Error(`Comparator node missing lhs path: ${JSON.stringify(node)}`)
    const lit = literalValue(rhs)
    return eb(tagPath(name) as any, cmp, lit.sql as any)
  }

  throw new Error(`Unsupported Haystack filter node: ${t || JSON.stringify(node)}`)
}

function childrenOf(node: AnyNode): AnyNode[] {
  if (Array.isArray(node?.children)) return node.children
  if (Array.isArray(node?.nodes)) return node.nodes
  if (Array.isArray(node?.args)) return node.args
  if (node?.lhs && node?.rhs) return [node.lhs, node.rhs]
  if (node?.left && node?.right) return [node.left, node.right]
  if (node?.condition) return [node.condition]
  if (node?.operand) return [node.operand]
  if (node?.value) return [node.value]
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
