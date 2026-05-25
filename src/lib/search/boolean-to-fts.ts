// Convert parsed boolean AST → LanceDB FullTextQuery.
// LanceDB 0.26.x has no MatchAllQuery, so NOT must always attach as a
// MustNot clause inside an enclosing AND/OR — a lone top-level NOT is
// rejected here (the caller should fall back to legacy in that case).
//
// Field-qualified terms (`field:value` from the parser) are handled in a
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
// literal `field:value` string. Unknown fields take the same degradation
// path. A `logger.warn` is emitted for both.

import { Node } from './boolean-query';
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
// Every user-facing field maps to a LanceDB scalar column — Document-level
// metadata is denormalized onto each chunk at ingestion time (see
// vector-store.ts LanceDBRow schema), so a SQLite round-trip is not required.
export interface FieldResolver {
  kind: 'lance-scalar';
  column: string;
}

export const FIELD_RESOLVERS: Record<string, FieldResolver> = {
  case: { kind: 'lance-scalar', column: 'case_number' },
  caseNumber: { kind: 'lance-scalar', column: 'case_number' },
  caseId: { kind: 'lance-scalar', column: 'case_id' },
  documentId: { kind: 'lance-scalar', column: 'document_id' },
  filingId: { kind: 'lance-scalar', column: 'filing_id' },
  filingType: { kind: 'lance-scalar', column: 'filing_type' },
  documentType: { kind: 'lance-scalar', column: 'document_type' },
  // `motionType` doesn't have a dedicated column — the closest categorization
  // is `document_type` (set during filing detection). Documented as an alias
  // in the search docs panel.
  motionType: { kind: 'lance-scalar', column: 'document_type' },
};

function sqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Walk the AST and lift field-qualified terms whose every ancestor is AND.
 * Returns:
 *   - whereClauses: SQL conditions to AND into the LanceDB pre-filter
 *   - ast: rewritten AST with lifted terms removed; degraded terms (unknown
 *     field, or field-term under an OR ancestor) are rewritten to a bare
 *     MatchQuery against `text` with the literal `field:value` string.
 */
export function extractFieldFilters(input: Node): {
  whereClauses: string[];
  ast: Node | null;
} {
  const whereClauses: string[] = [];

  function visit(node: Node, underOr: boolean): Node | null {
    if (node.op === 'TERM') {
      if (!node.field) return node;
      const resolver = FIELD_RESOLVERS[node.field];
      if (!resolver) {
        logger?.warn?.('Unknown field in boolean query — degrading to bare text match', {
          field: node.field,
          value: node.value,
        });
        // Degrade: bare term with reassembled literal "field:value".
        // Phrase terms keep their phrase flag against `text` (best we can do).
        const literal = `${node.field}:${node.value}`;
        return { op: 'TERM', value: literal, phrase: node.phrase };
      }
      if (underOr) {
        // Cannot push as scalar predicate (would AND with the whole query).
        // TODO: when LanceDB supports mixing scalar predicates inside FTS
        // BooleanQuery trees, push these as Should clauses instead.
        logger?.warn?.('Field-qualified term under OR ancestor — degrading to bare text match', {
          field: node.field,
          value: node.value,
        });
        const literal = `${node.field}:${node.value}`;
        return { op: 'TERM', value: literal, phrase: node.phrase };
      }
      // Lift to a scalar where-clause; remove from AST.
      whereClauses.push(`${resolver.column} = '${sqlEscape(node.value)}'`);
      return null;
    }
    if (node.op === 'NOT') {
      const child = visit(node.child, underOr);
      if (!child) {
        // The NOT'd term was lifted — semantically that means "exclude rows
        // where the field equals value". We don't yet emit negative scalar
        // predicates (would require inverting the where clause). Drop the
        // NOT and the lifted clause for safety; the user-visible effect is
        // that `-field:X` currently behaves like `field:X` was never NOT'd.
        // TODO: support negative scalar predicates (`column <> 'value'`).
        // Pop the last where clause to avoid the wrong behavior.
        whereClauses.pop();
        return null;
      }
      return { op: 'NOT', child };
    }
    // AND / OR
    const childUnderOr = underOr || node.op === 'OR';
    const newChildren: Node[] = [];
    for (const c of node.children) {
      const rewritten = visit(c, childUnderOr);
      if (rewritten) newChildren.push(rewritten);
    }
    if (newChildren.length === 0) return null;
    if (newChildren.length === 1) return newChildren[0];
    return { op: node.op, children: newChildren };
  }

  const ast = visit(input, false);
  return { whereClauses, ast };
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
