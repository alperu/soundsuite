// Convert parsed boolean AST → LanceDB FullTextQuery.
// LanceDB 0.26.x has no MatchAllQuery, so NOT must always attach as a
// MustNot clause inside an enclosing AND/OR — a lone top-level NOT is
// rejected here (the caller should fall back to legacy in that case).

import { Node } from './boolean-query';
import {
  MatchQuery,
  PhraseQuery,
  BooleanQuery,
  Occur,
  FullTextQuery,
} from '../vector/vector-store';

export class BooleanFtsConversionError extends Error {}

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
