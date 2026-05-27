// Convert parsed boolean AST → LanceDB FullTextQuery.
// LanceDB 0.26.x has no MatchAllQuery, so NOT must always attach as a
// MustNot clause inside an enclosing AND/OR — a lone top-level NOT is
// rejected here (the caller should fall back to legacy in that case).
//
// Field-qualified terms (`field<op>value` from the parser) are handled in a
// separate pre-pass: `extractFieldFilters` walks the AST, lifts field terms
// whose every ancestor is AND (so the filter can be safely AND'd to the
// LanceDB query via `.where()`), and returns the SQL predicates plus a
// rewritten AST with those leaves removed.
//
// Architectural note: LanceDB 0.26.x's BooleanQuery cannot mix FTS clauses
// (MatchQuery on the FTS-indexed `text` column) with scalar-column predicates
// (e.g. `case_id = '...'`) — the FTS tree only operates on FTS columns. So
// when a field-qualified term sits under an OR ancestor, we cannot push it
// as a scalar predicate (which is AND-only via `.where()`). In that case we
// degrade: the term is rewritten as a bare MatchQuery on `text` with the
// literal `field==value` string. Unknown fields take the same degradation
// path. A `logger.warn` is emitted for both.
//
// Task #54: extended with prisma-traverse support. The sync extractor collects
// deferred resolution requests for ref-typed Person fields (judgeRef, etc.)
// and multi-segment paths (`case->jurisdiction`). `resolvePrismaFilters`
// runs those against the legal schema and returns an additional set of
// where-clauses (typically `case_id IN ('...', '...')`) to AND into the
// LanceDB pre-filter.

import { Node, CompareOp } from './boolean-query';
import {
  MatchQuery,
  PhraseQuery,
  BooleanQuery,
  Occur,
  FullTextQuery,
} from '../vector/vector-store';
import { logger } from '@/lib/logger';

export class BooleanFtsConversionError extends Error {}

// Field-resolver registry.
// Every user-facing field maps to either a LanceDB scalar column (denormalized
// onto chunks at ingestion — see vector-store.ts LanceDBRow schema) or a
// Prisma traversal that resolves to a caseId set.
//
// Discriminator:
//   - `lance-scalar`: equality/comparison against a LanceDB scalar column.
//   - `lance-scalar-ref`: ref-typed scalar column. Value is a bare uuid
//     (the `@` has already been stripped by the parser when `isRef: true`).
//     Used for fields whose ref column IS denormalized onto chunks:
//     caseRef, filingRef, documentRef.
//   - `prisma-traverse`: multi-hop traversal. Resolves to a caseId set via
//     the legal schema, pre-filtered onto chunks as `case_id IN (...)`.
//     Used for Person-typed refs (judgeRef/lawyerRef/etc. — these live on
//     Motion, not on chunks) and Case-attribute paths (`case->jurisdiction`,
//     `case->state`, etc.).
//
// The traversal kind specifies (a) which legal-schema entity to query and
// (b) which Person role tag to require, if any. The shape is intentionally
// data-driven so the orchestrator stays generic.
export type FieldResolver =
  | { kind: 'lance-scalar'; column: string }
  | { kind: 'lance-scalar-ref'; column: string }
  | {
      kind: 'prisma-traverse';
      // Where to start the traversal.
      via: 'motion-person' | 'case-attribute' | 'case-direct';
      // For motion-person: the column on Motion (e.g. 'judgeId', 'movantId').
      motionColumn?: string;
      // For motion-person: optional Person.tags marker required (e.g. 'lawyer')
      // when the column doesn't already encode the role (lawyer/clerk/reporter
      // aren't dedicated columns on Motion).
      personTag?: string;
      // For case-attribute: the path segment(s) AFTER the leading `case` segment
      // that are accepted, mapped to the underlying Prisma field/column.
      caseAttributeAllowlist?: Record<string, string>;
    };

export const FIELD_RESOLVERS: Record<string, FieldResolver> = {
  // — lance-scalar (denormalized columns on chunks) —
  case: { kind: 'lance-scalar', column: 'case_number' },
  caseNumber: { kind: 'lance-scalar', column: 'case_number' },
  caseId: { kind: 'lance-scalar', column: 'case_id' },
  documentId: { kind: 'lance-scalar', column: 'document_id' },
  filingId: { kind: 'lance-scalar', column: 'filing_id' },
  filingType: { kind: 'lance-scalar', column: 'filing_type' },
  documentType: { kind: 'lance-scalar', column: 'document_type' },
  // `motionType` doesn't have a dedicated column — closest is `document_type`.
  motionType: { kind: 'lance-scalar', column: 'document_type' },
  // Numeric scalar columns on chunks
  volumeNumber: { kind: 'lance-scalar', column: 'volume_number' },
  chunkIndex: { kind: 'lance-scalar', column: 'chunk_index' },
  pageNumber: { kind: 'lance-scalar', column: 'page_number' },

  // — lance-scalar-ref (ref columns denormalized on chunks) —
  // The parser strips the leading `@` and sets isRef:true; we lift to `=`.
  caseRef: { kind: 'lance-scalar-ref', column: 'case_id' },
  filingRef: { kind: 'lance-scalar-ref', column: 'filing_id' },
  documentRef: { kind: 'lance-scalar-ref', column: 'document_id' },

  // — prisma-traverse: Person-typed refs (live on Motion, not on chunks) —
  // judge/movant/respondent: have dedicated columns on Motion.
  judgeRef:      { kind: 'prisma-traverse', via: 'motion-person', motionColumn: 'judgeId' },
  movantRef:     { kind: 'prisma-traverse', via: 'motion-person', motionColumn: 'movantId' },
  respondentRef: { kind: 'prisma-traverse', via: 'motion-person', motionColumn: 'respondentId' },
  // lawyer/clerk/reporter: no dedicated Motion columns. Resolve via the
  // PersonRole join with a tag marker — defer to repo helper at execution time.
  lawyerRef:   { kind: 'prisma-traverse', via: 'motion-person', personTag: 'lawyer' },
  clerkRef:    { kind: 'prisma-traverse', via: 'motion-person', personTag: 'courtClerk' },
  reporterRef: { kind: 'prisma-traverse', via: 'motion-person', personTag: 'courtReporter' },
};

// Task #66: XETO marker-tag allowlist. These names appear on `Case.tags`
// JSON (and analogous Motion.tags) as `markerName: true` presence flags.
// The list is intentionally finite — we mirror the marker dictionary used in
// production XETO ingestion (`src/lib/legal/types.ts:CaseTags`) plus the
// US-jurisdiction markers used in case-management seed data
// (`jurisdictionCa`, `jurisdictionTx`, etc.). Adding a marker here is a
// one-line change.
//
// Validation invariants:
//   - Members are camelCase identifiers — `[A-Za-z][A-Za-z0-9]*` — so they
//     can be safely interpolated into a Prisma `path` array without risk of
//     SQL or JSON-path injection.
//   - The marker name itself is the JSON key on `tags`. We never coerce it.
const US_JURISDICTION_CODES = [
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks',
  'ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny',
  'nc','nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv',
  'wi','wy','dc','pr','vi','gu','as','mp',
];

const CASE_MARKER_ALLOWLIST: Set<string> = new Set([
  // Core XETO Case markers (see CaseTags in src/lib/legal/types.ts)
  'case', 'site',
  // Jurisdiction markers — one per US state/territory, camelCase suffix
  ...US_JURISDICTION_CODES.map(
    (c) => `jurisdiction${c.charAt(0).toUpperCase()}${c.slice(1)}`,
  ),
]);

/** Exported for the filter-logic-panel docs. Top-N marker names. */
export const CASE_MARKER_NAMES: string[] = Array.from(CASE_MARKER_ALLOWLIST);

// Defensive regex — the parser already enforces this shape, but we re-check
// at the resolver boundary to make the SQL-injection guarantee local.
const SAFE_MARKER_NAME_RE = /^[A-Za-z][A-Za-z0-9]*$/;

// Allowed second segments after a leading `case` root. The allowlist guards
// SQL injection and prevents accidental traversal into unknown columns. Each
// entry maps the user-typed segment to the actual Prisma field.
const CASE_ATTRIBUTE_ALLOWLIST: Record<string, string> = {
  jurisdiction: 'jurisdiction',
  state:        'state',
  county:       'county',
  country:      'country',
  name:         'name',
  caseNumber:   'caseNumber',
  // Path through Person via Motion (`case->judge->name`) is the only 3-hop we
  // accept; handled separately below.
};

// Allowed third segments after `case->judge|movant|respondent`. Walked when a
// 3-hop path comes through, e.g. `case->judge->displayName=="Roberts"`.
const PERSON_ATTRIBUTE_ALLOWLIST: Record<string, string> = {
  displayName: 'displayName',
  name:        'displayName',   // alias
  email:       'email',
  barNumber:   'barNumber',
};

// 3-hop case->personRole->attribute roles. Maps the middle segment to the
// Motion column that joins Case→Person.
const CASE_PERSON_HOPS: Record<string, string> = {
  judge:      'judgeId',
  movant:     'movantId',
  respondent: 'respondentId',
};

// A deferred prisma-traverse request collected by the sync extractor.
// `resolvePrismaFilters` (async) walks these and emits `case_id IN (...)`
// where-clauses.
export interface PrismaTraversalRequest {
  // The literal string we'd render if we have to degrade to text match.
  literal: string;
  phrase: boolean;
  // What to resolve.
  path: string[];
  cmp: CompareOp;
  value: string;     // already-stripped (bare uuid for refs, bare string otherwise)
  isRef: boolean;
  // Set to true when the request was lifted from a NOT'd leaf — invert the
  // emitted predicate (`case_id NOT IN (...)`).
  negate?: boolean;
}

function sqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

// Rebuild the surface literal for a degraded TERM. Uses canonical Axon syntax
// (`field==value`, `field->field==value`, `field==@uuid`) so round-trip stays
// stable through astSerialize.
function reconstructLiteral(
  path: string[],
  cmp: CompareOp,
  value: string,
  isRef: boolean,
): string {
  const lhs = path.join('->');
  const rhs = isRef ? `@${value}` : value;
  return `${lhs}${cmp}${rhs}`;
}

/**
 * Walk the AST and lift field-qualified terms whose every ancestor is AND.
 *
 * Returns:
 *   - whereClauses: SQL conditions to AND into the LanceDB pre-filter (from
 *     lance-scalar and lance-scalar-ref resolvers).
 *   - prismaRequests: deferred resolution requests (caller passes to
 *     resolvePrismaFilters to produce additional where-clauses).
 *   - ast: rewritten AST with lifted terms removed; degraded terms (unknown
 *     field, unsupported op, or field-term under an OR ancestor) are
 *     rewritten to a bare MatchQuery against `text` with the literal
 *     `field==value` string.
 */
export function extractFieldFilters(input: Node): {
  whereClauses: string[];
  prismaRequests: PrismaTraversalRequest[];
  ast: Node | null;
} {
  const whereClauses: string[] = [];
  const prismaRequests: PrismaTraversalRequest[] = [];

  function visit(node: Node, underOr: boolean, negated: boolean, frozen: boolean = false): Node | null {
    if (node.op === 'TERM') {
      const path = node.path;
      if (!path || path.length === 0) return node;
      if (frozen) {
        // Inside a NOT-compound — never lift; if this is a field-term,
        // degrade to a bare text TERM so the FTS arm preserves the literal.
        const cmp = node.compareOp ?? '==';
        const isRef = !!node.isRef;
        const literal = reconstructLiteral(path, cmp, node.value, isRef);
        return { op: 'TERM', value: literal, phrase: node.phrase };
      }
      const cmp: CompareOp = node.compareOp ?? '==';
      const isRef = !!node.isRef;
      const literal = reconstructLiteral(path, cmp, node.value, isRef);

      // Multi-segment paths are always prisma-traverse — handled below.
      if (path.length > 1) {
        if (underOr) {
          logger?.warn?.('Path-traversal term under OR ancestor — degrading', {
            path, op: cmp, value: node.value,
          });
          return { op: 'TERM', value: literal, phrase: node.phrase };
        }
        // Validate the path against the allowlists; degrade unknown shapes.
        const ok = validateTraversalPath(path);
        if (!ok) {
          logger?.warn?.('Unknown traversal path — degrading to bare text match', {
            path, op: cmp, value: node.value,
          });
          return { op: 'TERM', value: literal, phrase: node.phrase };
        }
        prismaRequests.push({
          literal, phrase: node.phrase, path: [...path],
          cmp, value: node.value, isRef, negate: negated,
        });
        return null;
      }

      // Ref-shaped values (`@uuid`) on a non-ref field redirect to the field's
      // ref alias. e.g. `case==@uuid` should resolve to `case_id`, not
      // `case_number`. Same for judge/lawyer/movant/respondent/clerk/reporter
      // → their *Ref siblings.
      const REF_ALIAS: Record<string, string> = {
        case: 'caseRef',
        document: 'documentRef',
        filing: 'filingRef',
        judge: 'judgeRef',
        lawyer: 'lawyerRef',
        movant: 'movantRef',
        respondent: 'respondentRef',
        clerk: 'clerkRef',
        reporter: 'reporterRef',
      };
      const rawField = path[0];
      const field = (isRef && REF_ALIAS[rawField] && FIELD_RESOLVERS[REF_ALIAS[rawField]])
        ? REF_ALIAS[rawField]
        : rawField;
      const resolver = FIELD_RESOLVERS[field];
      if (!resolver) {
        logger?.warn?.('Unknown field in boolean query — degrading to bare text match', {
          field, op: cmp, value: node.value,
        });
        return { op: 'TERM', value: literal, phrase: node.phrase };
      }
      if (underOr) {
        logger?.warn?.('Field-qualified term under OR ancestor — degrading to bare text match', {
          field, op: cmp, value: node.value,
        });
        return { op: 'TERM', value: literal, phrase: node.phrase };
      }

      // Ref-typed resolver: lift to scalar `=` on the denormalized column.
      if (resolver.kind === 'lance-scalar-ref') {
        if (cmp !== '==' && cmp !== '!=') {
          logger?.warn?.('Ref field with non-equality op — degrading to text match', {
            field, op: cmp, value: node.value,
          });
          return { op: 'TERM', value: literal, phrase: node.phrase };
        }
        // Negation handled by the NOT branch: if this leaf is under a NOT,
        // the caller will pop the last clause (legacy behavior). For ref-eq
        // we DO emit a negative predicate now — invert if negated.
        const sqlOp = (cmp === '==') === !negated ? '=' : '!=';
        whereClauses.push(`${resolver.column} ${sqlOp} '${sqlEscape(node.value)}'`);
        return null;
      }

      if (resolver.kind === 'prisma-traverse') {
        // Single-segment prisma-traverse (e.g. `judgeRef==@uuid`).
        prismaRequests.push({
          literal, phrase: node.phrase, path: [...path],
          cmp, value: node.value, isRef, negate: negated,
        });
        return null;
      }

      // lance-scalar: equality (==) → SQL `=`; everything else uses its
      // direct SQL counterpart.
      if (cmp === '==') {
        const op = negated ? '!=' : '=';
        whereClauses.push(`${resolver.column} ${op} '${sqlEscape(node.value)}'`);
        return null;
      }
      const sqlOp = cmp === '!=' ? '!='
        : cmp === '>=' ? '>='
        : cmp === '<=' ? '<='
        : cmp === '>'  ? '>'
        :                 '<'; // '<'
      // Numeric values pass through unquoted; everything else gets quoted.
      const safeNumeric = /^-?\d+(\.\d+)?$/.test(node.value);
      const rhs = safeNumeric ? node.value : `'${sqlEscape(node.value)}'`;
      whereClauses.push(`${resolver.column} ${sqlOp} ${rhs}`);
      return null;
    }
    if (node.op === 'NOT') {
      // Negation lift: ONLY when the immediate child is a TERM. For compound
      // children (NOT(A AND B), NOT(A OR B)) we'd have to apply De Morgan's
      // and propagate negation into both branches — that's correct only if
      // EVERY leaf can lift, otherwise the FTS arm and the SQL arm diverge
      // (NOT(A AND B) = NOT A OR NOT B; we'd need to OR a SQL clause with
      // an FTS clause and LanceDB can't mix those). Safer: keep the NOT
      // intact, don't lift anything from inside it.
      if (node.child.op === 'TERM') {
        const lifted = visit(node.child, underOr, true);
        if (!lifted) return null; // negated clause emitted, wrapper dropped
        return { op: 'NOT', child: lifted };
      }
      // Compound subtree under NOT — visit it with `frozen=true` so no
      // leaf inside is lifted (De Morgan's would require mixing SQL+FTS
      // under an OR, which LanceDB can't do). Whole subtree stays in FTS.
      const inner = visit(node.child, underOr, false, true);
      if (!inner) return null;
      return { op: 'NOT', child: inner };
    }
    // AND / OR. Note: the `negated` flag is NEVER propagated past a compound
    // operator — only direct TERM children of a NOT carry it (handled above).
    //
    // OR over uniform scalar/ref columns — collapse to a single
    // `(col1 IN (v1, v2) OR col2 IN (v3, v4))` SQL clause instead of
    // degrading each leaf to a text match. Safe because all leaves resolve
    // to LanceDB scalar columns that live on chunks.
    if (node.op === 'OR' && !frozen && !underOr) {
      const groups = new Map<string, string[]>();
      let allEligible = true;
      for (const c of node.children) {
        if (c.op !== 'TERM' || !c.path || c.path.length !== 1) { allEligible = false; break; }
        const cmp: CompareOp = c.compareOp ?? '==';
        if (cmp !== '==') { allEligible = false; break; }
        const isRef = !!c.isRef;
        const rawField = c.path[0];
        // Apply the same REF_ALIAS used in the TERM branch — refs typed as
        // `case`/`judge`/etc. with @uuid values redirect to their *Ref column.
        const REF_ALIAS: Record<string, string> = {
          case: 'caseRef', document: 'documentRef', filing: 'filingRef',
          judge: 'judgeRef', lawyer: 'lawyerRef', movant: 'movantRef',
          respondent: 'respondentRef', clerk: 'clerkRef', reporter: 'reporterRef',
        };
        const field = (isRef && REF_ALIAS[rawField] && FIELD_RESOLVERS[REF_ALIAS[rawField]])
          ? REF_ALIAS[rawField]
          : rawField;
        const resolver = FIELD_RESOLVERS[field];
        if (!resolver) { allEligible = false; break; }
        if (resolver.kind !== 'lance-scalar' && resolver.kind !== 'lance-scalar-ref') {
          allEligible = false; break;
        }
        const arr = groups.get(resolver.column) ?? [];
        arr.push(c.value);
        groups.set(resolver.column, arr);
      }
      if (allEligible && groups.size > 0) {
        const parts: string[] = [];
        for (const [col, values] of groups) {
          const escaped = values.map((v) => `'${sqlEscape(v)}'`).join(', ');
          parts.push(`${col} IN (${escaped})`);
        }
        whereClauses.push(parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`);
        return null;
      }
    }

    const childUnderOr = underOr || node.op === 'OR';
    const newChildren: Node[] = [];
    for (const c of node.children) {
      const rewritten = visit(c, childUnderOr, false, frozen);
      if (rewritten) newChildren.push(rewritten);
    }
    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0];
    return { op: node.op, children: newChildren };
  }

  const ast = visit(input, false, false);
  return { whereClauses, prismaRequests, ast };
}

// Validate a multi-segment path against the per-root allowlists. Returns
// true if the path can be resolved by `resolvePrismaFilters`. SQL injection
// guard: every segment must come from a known allowlist; we never embed a
// user-typed segment into SQL.
function validateTraversalPath(path: string[]): boolean {
  if (path.length < 2) return true; // caller handles single-segment
  const root = path[0];
  // case->X (2-hop case-attribute) or case->{judge|movant|respondent}->Y (3-hop)
  if (root === 'case') {
    if (path.length === 2) {
      // Column-backed attribute OR XETO marker tag (#66).
      return (
        path[1] in CASE_ATTRIBUTE_ALLOWLIST ||
        CASE_MARKER_ALLOWLIST.has(path[1])
      );
    }
    if (path.length === 3) {
      return path[1] in CASE_PERSON_HOPS && path[2] in PERSON_ATTRIBUTE_ALLOWLIST;
    }
    return false;
  }
  // judgeRef->displayName etc. — 2-hop ref-to-attribute.
  if (FIELD_RESOLVERS[root]?.kind === 'prisma-traverse' && path.length === 2) {
    return path[1] in PERSON_ATTRIBUTE_ALLOWLIST;
  }
  return false;
}

// Minimum surface the resolver needs from the legal-schema client. The
// orchestrator hands us either `@/lib/db/prisma`'s singleton or a test mock.
export interface LegalSchemaClient {
  case: {
    findMany(args: { where: any; select?: any }): Promise<any[]>;
  };
  motion: {
    findMany(args: { where: any; select?: any }): Promise<any[]>;
  };
  person: {
    findMany(args: { where: any; select?: any }): Promise<any[]>;
  };
  // Added in #58 for clerk/reporter (FK on MotionEvent).
  motionEvent: {
    findMany(args: { where: any; select?: any }): Promise<any[]>;
  };
  // Added in #58 for lawyer (via PersonRole.tags.lawyer).
  personRole: {
    findMany(args: { where: any; select?: any }): Promise<any[]>;
  };
}

const FANOUT_CAP = 2000;

/**
 * Resolve deferred prisma-traverse requests into LanceDB where-clauses.
 *
 * Each request yields a `case_id IN (...)` (or `case_id NOT IN (...)`)
 * predicate. If an intermediate id set exceeds FANOUT_CAP, we log a warning
 * and truncate; the user-visible effect is partial recall on that filter
 * (documented in the search docs panel).
 *
 * For 3-hop paths like `case->judge->name=="Roberts"`:
 *   1. person.findMany({where:{displayName:"Roberts"}}) → personIds
 *   2. motion.findMany({where:{judgeId:{in:personIds}}}) → caseIds
 *   3. emit `case_id IN (caseIds)`
 *
 * For Person-tagged refs (lawyerRef/clerkRef/reporterRef) we can't query by
 * a Motion column — we'd need a join through MotionEvent/PersonRole. Phase 1
 * scope cut: those degrade to text match with a logged warning (see report).
 */
export async function resolvePrismaFilters(
  requests: PrismaTraversalRequest[],
  client: LegalSchemaClient,
): Promise<{ whereClauses: string[]; degraded: PrismaTraversalRequest[] }> {
  const whereClauses: string[] = [];
  const degraded: PrismaTraversalRequest[] = [];

  for (const req of requests) {
    try {
      const ids = await resolveOne(req, client);
      if (ids === null) {
        degraded.push(req);
        continue;
      }
      if (ids.length === 0) {
        // Filter resolves to nothing — emit an always-false predicate so the
        // outer AND short-circuits to empty results. Use a sentinel that can't
        // collide with a real uuid.
        whereClauses.push(
          req.negate ? `1 = 1` : `case_id = '__no_match__'`,
        );
        continue;
      }
      const quoted = ids.map(id => `'${sqlEscape(id)}'`).join(', ');
      const op = req.negate ? 'NOT IN' : 'IN';
      whereClauses.push(`case_id ${op} (${quoted})`);
    } catch (err) {
      logger?.warn?.('Prisma traversal failed — degrading to bare text match', {
        path: req.path, op: req.cmp, value: req.value,
        error: err instanceof Error ? err.message : String(err),
      });
      degraded.push(req);
    }
  }

  return { whereClauses, degraded };
}

async function resolveOne(
  req: PrismaTraversalRequest,
  client: LegalSchemaClient,
): Promise<string[] | null> {
  const { path, cmp, value, isRef } = req;

  // — Single-segment: Person-typed ref (judgeRef==@uuid etc.) —
  if (path.length === 1) {
    const resolver = FIELD_RESOLVERS[path[0]];
    if (!resolver || resolver.kind !== 'prisma-traverse') return null;
    if (cmp !== '==' && cmp !== '!=') return null;
    if (!isRef) {
      // Equality against a non-uuid value is meaningless for a Person ref.
      return null;
    }
    if (resolver.motionColumn) {
      // Motion.judgeId / movantId / respondentId
      const motions = await client.motion.findMany({
        where: { [resolver.motionColumn]: value },
        select: { caseId: true },
      });
      const caseIds = uniqueNonNull(motions.map(m => m.caseId as string | null));
      return capFanout(caseIds, req);
    }
    if (resolver.personTag) {
      // lawyerRef / clerkRef / reporterRef — #58.
      const caseIds = await resolvePersonTagFilter([value], resolver.personTag, client);
      return capFanout(caseIds, req);
    }
    return null;
  }

  // — 2-hop: case->attribute or case->markerTag (Task #66) —
  if (path[0] === 'case' && path.length === 2) {
    const seg = path[1];
    // Marker-tag form: `case->markerName == true|false`. The JSON predicate
    // `tags.path = [seg].equals = bool` is well-supported by Prisma's SQLite
    // driver. Marker names are validated against the allowlist + a defensive
    // regex so we never embed a user-typed key into a query.
    if (CASE_MARKER_ALLOWLIST.has(seg) && SAFE_MARKER_NAME_RE.test(seg)) {
      if (cmp !== '==' && cmp !== '!=') return null;
      const truthy = value === 'true' || value === '1';
      const falsy = value === 'false' || value === '0';
      if (!truthy && !falsy) return null;
      const want = (cmp === '==') ? truthy : !truthy; // `!=true` ⇒ want false
      const where: { tags: { path: string[]; equals: boolean } } = {
        tags: { path: [seg], equals: want },
      };
      try {
        const cases = await client.case.findMany({ where, select: { id: true } });
        return capFanout(cases.map((c) => c.id as string), req);
      } catch (err) {
        logger?.warn?.('Prisma JSON marker filter failed — degrading', {
          marker: seg, op: cmp, error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }
    const prismaField = CASE_ATTRIBUTE_ALLOWLIST[seg];
    if (!prismaField) return null;
    const where = buildScalarWhere(prismaField, cmp, value);
    if (!where) return null;
    const cases = await client.case.findMany({ where, select: { id: true } });
    return capFanout(cases.map(c => c.id as string), req);
  }

  // — 2-hop: judgeRef->attribute (or other Person ref->attribute) —
  if (path.length === 2) {
    const resolver = FIELD_RESOLVERS[path[0]];
    if (!resolver || resolver.kind !== 'prisma-traverse') return null;
    const attr = PERSON_ATTRIBUTE_ALLOWLIST[path[1]];
    if (!attr) return null;
    const personWhere = buildScalarWhere(attr, cmp, value);
    if (!personWhere) return null;
    const persons = await client.person.findMany({ where: personWhere, select: { id: true } });
    const personIds = persons.map(p => p.id as string);
    if (personIds.length === 0) return [];
    if (!resolver.motionColumn) {
      // lawyerRef/clerkRef/reporterRef 2-hop — #58.
      if (!resolver.personTag) return null;
      const caseIds = await resolvePersonTagFilter(personIds, resolver.personTag, client);
      return capFanout(caseIds, req);
    }
    const motions = await client.motion.findMany({
      where: { [resolver.motionColumn]: { in: personIds } },
      select: { caseId: true },
    });
    return capFanout(uniqueNonNull(motions.map(m => m.caseId as string | null)), req);
  }

  // — 3-hop: case->judge|movant|respondent->attribute —
  if (path[0] === 'case' && path.length === 3) {
    const motionCol = CASE_PERSON_HOPS[path[1]];
    if (!motionCol) return null;
    const attr = PERSON_ATTRIBUTE_ALLOWLIST[path[2]];
    if (!attr) return null;
    const personWhere = buildScalarWhere(attr, cmp, value);
    if (!personWhere) return null;
    const persons = await client.person.findMany({ where: personWhere, select: { id: true } });
    const personIds = persons.map(p => p.id as string);
    if (personIds.length === 0) return [];
    const motions = await client.motion.findMany({
      where: { [motionCol]: { in: personIds } },
      select: { caseId: true },
    });
    return capFanout(uniqueNonNull(motions.map(m => m.caseId as string | null)), req);
  }

  return null;
}

/**
 * Resolve a Person-tagged ref filter (lawyer/clerk/reporter) to a caseId set.
 * Schema (#58):
 *   - courtClerk / courtReporter: dedicated FK columns on MotionEvent. Each
 *     event row carries a caseId, so one findMany is enough.
 *   - lawyer: tracked via PersonRole.tags.lawyer with a polymorphic
 *     (scopeKind, scopeId). scopeKind='motion' rows resolve to a Motion which
 *     then carries caseId; scopeKind='case' rows give the caseId directly.
 *
 * Returns the union of caseIds. Empty array means no match.
 */
async function resolvePersonTagFilter(
  personIds: string[],
  tag: string,
  client: LegalSchemaClient,
): Promise<string[]> {
  if (personIds.length === 0) return [];

  if (tag === 'courtClerk' || tag === 'courtReporter') {
    const fkCol = tag === 'courtClerk' ? 'courtClerkId' : 'courtReporterId';
    const events = await client.motionEvent.findMany({
      where: { [fkCol]: { in: personIds } },
      select: { caseId: true },
    });
    return uniqueNonNull(events.map((e) => (e.caseId as string | null) ?? null));
  }

  if (tag === 'lawyer') {
    // PersonRole rows are typically a small set per person, so we don't try
    // to push the tag predicate into Prisma's JSON path filter (Prisma's
    // JSON support varies by datasource; SQLite is the conservative ceiling).
    // Fetch all roles for the candidate personIds, then post-filter in JS.
    const roles = await client.personRole.findMany({
      where: { personId: { in: personIds } },
      select: { scopeKind: true, scopeId: true, tags: true },
    });
    const motionIds: string[] = [];
    const caseIds: string[] = [];
    for (const r of roles) {
      const tags = (r.tags as Record<string, unknown> | null) ?? null;
      if (!tags || tags[tag] !== true) continue;
      const kind = r.scopeKind as string | null;
      const scopeId = r.scopeId as string | null;
      if (!kind || !scopeId) continue;
      if (kind === 'motion') motionIds.push(scopeId);
      else if (kind === 'case') caseIds.push(scopeId);
    }
    if (motionIds.length > 0) {
      const motions = await client.motion.findMany({
        where: { id: { in: motionIds } },
        select: { caseId: true },
      });
      for (const m of motions) {
        const cid = m.caseId as string | null;
        if (cid) caseIds.push(cid);
      }
    }
    return [...new Set(caseIds)];
  }

  // Unknown tag — caller's resolver claimed personTag but we don't know how
  // to walk it. Treat as no-match rather than fabricating results.
  logger?.warn?.('Unknown personTag in resolvePersonTagFilter', { tag });
  return [];
}

function buildScalarWhere(field: string, cmp: CompareOp, value: string): any {
  // Numeric comparisons pass through unquoted; equality/inequality use the
  // raw value. We never embed `value` in SQL — Prisma parameterizes it.
  if (cmp === '==') return { [field]: value };
  if (cmp === '!=') return { [field]: { not: value } };
  const numeric = /^-?\d+(\.\d+)?$/.test(value);
  const v: any = numeric ? Number(value) : value;
  if (cmp === '>=') return { [field]: { gte: v } };
  if (cmp === '<=') return { [field]: { lte: v } };
  if (cmp === '>')  return { [field]: { gt:  v } };
  if (cmp === '<')  return { [field]: { lt:  v } };
  return null;
}

function uniqueNonNull(xs: (string | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    if (x && !seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

function capFanout(ids: string[], req: PrismaTraversalRequest): string[] {
  if (ids.length > FANOUT_CAP) {
    logger?.warn?.(`Traversal fan-out exceeded cap (${FANOUT_CAP}) — truncating`, {
      path: req.path, op: req.cmp, value: req.value, total: ids.length,
    });
    return ids.slice(0, FANOUT_CAP);
  }
  return ids;
}

export function astToLanceQuery(
  ast: Node,
  opts: { field?: string } = {},
): FullTextQuery {
  const field = opts.field ?? 'text';

  if (ast.op === 'TERM') return termToFts(ast, field);

  if (ast.op === 'NOT') {
    // A bare top-level NOT can't be represented — LanceDB's BooleanQuery
    // requires at least one positive (Must/Should) clause.
    throw new BooleanFtsConversionError(
      'Top-level NOT requires a positive companion clause (e.g. `foo -bar`).',
    );
  }

  // AND / OR — fold NOT children as MustNot, others per parent occur.
  const positiveOccur: Occur = ast.op === 'AND' ? Occur.Must : Occur.Should;
  const clauses: [Occur, FullTextQuery][] = [];
  let positiveCount = 0;

  for (const child of ast.children) {
    if (child.op === 'NOT') {
      clauses.push([Occur.MustNot, buildPositive(child.child, field)]);
    } else {
      clauses.push([positiveOccur, astToLanceQuery(child, opts)]);
      positiveCount++;
    }
  }

  if (positiveCount === 0) {
    throw new BooleanFtsConversionError(
      'Boolean expression has only negative clauses — needs at least one positive term.',
    );
  }
  if (clauses.length === 1) {
    return clauses[0][1];
  }
  return new BooleanQuery(clauses);
}

function buildPositive(node: Node, field: string): FullTextQuery {
  if (node.op === 'NOT') {
    // double-NOT — treat the inner as the positive clause
    return buildPositive(node.child, field);
  }
  return astToLanceQuery(node, { field });
}

function termToFts(
  t: Extract<Node, { op: 'TERM' }>,
  field: string,
): FullTextQuery {
  if (t.phrase) return new PhraseQuery(t.value, field);
  return new MatchQuery(t.value, field);
}
