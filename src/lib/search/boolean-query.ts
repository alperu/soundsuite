// Hand-rolled precedence-climbing parser for boolean search expressions.
// Grammar: expr = OR of ANDs; AND between adjacent terms is implicit;
// NOT and unary `-` negate; parens group; "..." is a phrase.
//
// AST shape decisions (task #53, search unification):
//   - TERM nodes carry `path: string[]` (1+ segments) instead of a single
//     `field?: string`. Single-segment paths are the common case
//     (`case=="X"` → `path: ['case']`); multi-segment paths come from `->`
//     traversal (`case->jurisdiction=="TX"` → `path: ['case', 'jurisdiction']`).
//     Bare-term TERMs (no field) carry `path: []` so consumers can branch on
//     `path.length === 0`.
//   - Refs are NOT a separate node kind. A field-op TERM whose value started
//     with `@` (unquoted) is marked `isRef: true` and stores the bare uuid in
//     `value` (no `@`). astSerialize re-adds the `@`. This avoids duplicating
//     the entire TERM shape (path/compareOp/phrase) for a single boolean flag.
//   - Every field-op TERM has a concrete `compareOp`. The legacy `:` is
//     normalized to `==` at tokenize time — there is no longer a "compareOp
//     omitted for `:`" branch.
//   - Chip aliases (`judge`→`judgeRef`, `filedAfter`→`courtFilingDate>=`,
//     etc.) are absorbed by the parser via FIELD_ALIASES below. Aliases that
//     declare an `op` REPLACE the user-typed operator (so `filedAfter==X` and
//     `filedAfter:X` both become `courtFilingDate>=X`). This was an explicit
//     design call so chip-UI shortcuts work in the typed input too.

export type CompareOp = '==' | '!=' | '>=' | '<=' | '>' | '<';

export type Node =
  | { op: 'AND' | 'OR'; children: Node[] }
  | { op: 'NOT'; child: Node }
  | { op: 'TERM'; value: string; phrase: boolean; path?: string[]; compareOp?: CompareOp; isRef?: boolean };

export type ParseResult =
  | { ok: true; ast: Node; hasOperators: boolean }
  | { ok: false; error: string; position: number };

type Tok =
  | { kind: 'AND' | 'OR' | 'NOT' | 'LP' | 'RP' | 'DASH'; pos: number; text: string }
  | { kind: 'TERM'; pos: number; text: string; value: string; phrase: boolean; path?: string[]; compareOp?: CompareOp; isRef?: boolean };

// Field-alias map. The alias is applied to the FIRST segment of the path
// (you can still traverse from an aliased root: `judge->displayName==...`
// becomes `judgeRef->displayName==...`). When an alias defines `op`, that op
// overrides whatever the user typed.
interface FieldAlias {
  field: string;          // canonical first-segment name
  op?: CompareOp;         // optional operator coercion
}

export const FIELD_ALIASES: Record<string, FieldAlias> = {
  judge:        { field: 'judgeRef' },
  lawyer:       { field: 'lawyerRef' },
  movant:       { field: 'movantRef' },
  respondent:   { field: 'respondentRef' },
  clerk:        { field: 'clerkRef' },
  reporter:     { field: 'reporterRef' },
  filedAfter:   { field: 'courtFilingDate', op: '>=' },
  filedBefore:  { field: 'courtFilingDate', op: '<=' },
  filedOn:      { field: 'courtFilingDate', op: '==' },
};

// Field-qualified term detection. Accepts `field(->field)*` followed by an
// Axon comparison operator. Longest match wins for multi-char ops
// (`==` before `=` if `=` were ever added; `>=` before `>`).
// Operate on a single bare-term `buf` (no newlines possible — tokenizer
// breaks on whitespace), so the `s` (dotAll) flag isn't needed.
//
// Task #59 (locked decision 2026-05-26): the legacy `:` alias for `==` is no
// longer accepted. Encountering `field:` emits a parse error pointing at the
// colon with a specific suggestion to use `==`.
const FIELD_OP_RE = /^([A-Za-z][A-Za-z0-9_]*(?:->[A-Za-z][A-Za-z0-9_]*)*)(==|!=|>=|<=|>|<)(.*)$/;

// Detects a `field:` (legacy syntax) so we can emit a targeted error instead
// of falling through to the bare-term branch.
const LEGACY_COLON_RE = /^([A-Za-z][A-Za-z0-9_]*(?:->[A-Za-z][A-Za-z0-9_]*)*):/;

const OP_WORDS = new Set(['AND', 'OR', 'NOT', 'and', 'or', 'not']);

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isTermChar(c: string): boolean {
  return !isWs(c) && c !== '(' && c !== ')' && c !== '"';
}

// Normalize a raw `field(->field)*` chain into a `path[]` and apply
// FIELD_ALIASES to the first segment. Returns the canonical path plus an
// optional operator override coming from the alias table.
function normalizePath(rawPath: string): { path: string[]; opOverride?: CompareOp } {
  const segments = rawPath.split('->');
  const alias = FIELD_ALIASES[segments[0]];
  if (alias) {
    segments[0] = alias.field;
    return { path: segments, opOverride: alias.op };
  }
  return { path: segments };
}

function tokenize(input: string): { ok: true; tokens: Tok[]; hasOperators: boolean } | { ok: false; error: string; position: number } {
  const tokens: Tok[] = [];
  let hasOperators = false;
  let i = 0;
  const n = input.length;
  let atWordBoundary = true; // true at start and after any whitespace

  while (i < n) {
    const c = input[i];

    if (isWs(c)) { i++; atWordBoundary = true; continue; }

    if (c === '(') { tokens.push({ kind: 'LP', pos: i, text: '(' }); hasOperators = true; i++; atWordBoundary = true; continue; }
    if (c === ')') { tokens.push({ kind: 'RP', pos: i, text: ')' }); hasOperators = true; i++; atWordBoundary = false; continue; }

    // Unary `-` only at a word boundary AND immediately followed by a non-whitespace term char.
    if (c === '-' && atWordBoundary) {
      const next = input[i + 1];
      if (next !== undefined && !isWs(next) && next !== ')' && next !== '-') {
        tokens.push({ kind: 'DASH', pos: i, text: '-' });
        hasOperators = true;
        i++;
        atWordBoundary = false;
        continue;
      }
      // else: fall through, treat as part of a bare term
    }

    // Quoted phrase
    if (c === '"') {
      const start = i;
      i++;
      let buf = '';
      let closed = false;
      while (i < n) {
        const ch = input[i];
        if (ch === '\\' && i + 1 < n) {
          const nx = input[i + 1];
          if (nx === '"' || nx === '\\') { buf += nx; i += 2; continue; }
          buf += ch; i++; continue;
        }
        if (ch === '"') { closed = true; i++; break; }
        buf += ch;
        i++;
      }
      if (!closed) {
        return { ok: false, error: 'Unclosed quoted phrase', position: start };
      }
      tokens.push({ kind: 'TERM', pos: start, text: input.slice(start, i), value: buf, phrase: true });
      hasOperators = true;
      atWordBoundary = false;
      continue;
    }

    // Bare term — collect until whitespace, paren, or quote.
    const start = i;
    let buf = '';
    while (i < n && isTermChar(input[i])) {
      buf += input[i];
      i++;
    }
    if (buf.length === 0) {
      return { ok: false, error: `Unexpected character '${c}'`, position: i };
    }

    // Field-qualified term detection — supports Axon-style operators
    // (`==`, `!=`, `>=`, `<=`, `>`, `<`), and `->` path traversal between
    // identifiers.
    // - Leading op (no prefix) → not a field; emit as bare term.
    // - Trailing op (no inline value): if next char is `"`, consume the phrase as the value.
    //   If next char is whitespace/EOF/paren, parse error (no value).
    // - Otherwise, value is whatever follows the operator.
    // - `@<rest>` (unquoted) after the operator → emit a Ref leaf with
    //   `isRef: true` and bare uuid as `value`.
    // - Legacy `field:value` is REJECTED with a specific error pointing at
    //   the colon (task #59, locked 2026-05-26).
    // Note: `case== "23-CV-1234"` (space after operator) hits the trailing-op branch
    // and is reported as a parse error — chosen consistent behavior.
    let fieldQualified = false;
    if (buf.length > 0) {
      // Reject legacy `field:` before trying the Axon-op regex.
      const legacy = buf.match(LEGACY_COLON_RE);
      if (legacy) {
        const colonPos = legacy[1].length;
        return { ok: false, error: 'Use `==` for equality, not `:`.', position: start + colonPos };
      }
      const m = buf.match(FIELD_OP_RE);
      if (m) {
        const rawPath = m[1];
        let op = m[2] as CompareOp;
        const rest = m[3];
        const opPos = rawPath.length;

        const { path, opOverride } = normalizePath(rawPath);
        if (opOverride) op = opOverride;

        if (rest.length > 0) {
          // Inline value: `path<op>value` — possibly a ref (`@uuid`).
          let value = rest;
          let isRef = false;
          if (value.startsWith('@') && value.length > 1) {
            isRef = true;
            value = value.slice(1);
          }
          const tok: Tok = {
            kind: 'TERM', pos: start, text: buf, value, phrase: false,
            path, compareOp: op as CompareOp,
          };
          if (isRef) tok.isRef = true;
          tokens.push(tok);
          atWordBoundary = false;
          fieldQualified = true;
        } else {
          // Trailing operator — look for a quoted phrase immediately following
          if (i < n && input[i] === '"') {
            const phraseStart = i;
            i++;
            let pbuf = '';
            let closed = false;
            while (i < n) {
              const ch = input[i];
              if (ch === '\\' && i + 1 < n) {
                const nx = input[i + 1];
                if (nx === '"' || nx === '\\') { pbuf += nx; i += 2; continue; }
                pbuf += ch; i++; continue;
              }
              if (ch === '"') { closed = true; i++; break; }
              pbuf += ch;
              i++;
            }
            if (!closed) {
              return { ok: false, error: 'Unclosed quoted phrase', position: phraseStart };
            }
            const phTok: Tok = {
              kind: 'TERM', pos: start, text: input.slice(start, i), value: pbuf,
              phrase: true, path, compareOp: op as CompareOp,
            };
            tokens.push(phTok);
            hasOperators = true;
            atWordBoundary = false;
            fieldQualified = true;
          } else {
            return { ok: false, error: `Expected value after field '${rawPath}${m[2]}'`, position: start + opPos };
          }
        }
      }
    }

    if (fieldQualified) {
      continue;
    }

    // Operator keyword? Only if surrounded by whitespace/parens (which our tokenizer guarantees, since we're at a word boundary)
    if (OP_WORDS.has(buf)) {
      const upper = buf.toUpperCase() as 'AND' | 'OR' | 'NOT';
      tokens.push({ kind: upper, pos: start, text: buf });
      hasOperators = true;
      atWordBoundary = false;
    } else {
      tokens.push({ kind: 'TERM', pos: start, text: buf, value: buf, phrase: false });
      atWordBoundary = false;
    }
  }

  return { ok: true, tokens, hasOperators };
}

// Parser state
interface PState {
  toks: Tok[];
  i: number;
  error: { msg: string; pos: number } | null;
}

function peek(s: PState): Tok | undefined { return s.toks[s.i]; }
function eat(s: PState): Tok | undefined { return s.toks[s.i++]; }

function setErr(s: PState, msg: string, pos: number) {
  if (!s.error) s.error = { msg, pos };
}

function parseExpr(s: PState): Node | null { return parseOr(s); }

function parseOr(s: PState): Node | null {
  const first = parseAnd(s);
  if (!first) return null;
  const parts: Node[] = [first];
  while (peek(s)?.kind === 'OR') {
    eat(s);
    const next = parseAnd(s);
    if (!next) { setErr(s, 'Expected expression after OR', s.toks[s.i - 1]?.pos ?? 0); return null; }
    parts.push(next);
  }
  return parts.length === 1 ? parts[0] : { op: 'OR', children: parts };
}

function parseAnd(s: PState): Node | null {
  const first = parseNot(s);
  if (!first) return null;
  const parts: Node[] = [first];
  while (true) {
    const t = peek(s);
    if (!t) break;
    if (t.kind === 'OR' || t.kind === 'RP') break;
    if (t.kind === 'AND') { eat(s); }
    // else implicit-AND
    const next = parseNot(s);
    if (!next) {
      if (t.kind === 'AND') setErr(s, 'Expected expression after AND', t.pos);
      return null;
    }
    parts.push(next);
  }
  return parts.length === 1 ? parts[0] : { op: 'AND', children: parts };
}

function parseNot(s: PState): Node | null {
  const t = peek(s);
  if (!t) return null;
  if (t.kind === 'NOT' || t.kind === 'DASH') {
    eat(s);
    const child = parseNot(s);
    if (!child) { setErr(s, `Expected expression after ${t.text}`, t.pos); return null; }
    return { op: 'NOT', child };
  }
  return parsePrimary(s);
}

function parsePrimary(s: PState): Node | null {
  const t = peek(s);
  if (!t) return null;
  if (t.kind === 'LP') {
    const lp = eat(s)!;
    const inner = parseExpr(s);
    const close = peek(s);
    if (!close || close.kind !== 'RP') {
      setErr(s, 'Unbalanced parenthesis', lp.pos);
      return null;
    }
    eat(s);
    if (!inner) {
      setErr(s, 'Empty parenthesis group', lp.pos);
      return null;
    }
    return inner;
  }
  if (t.kind === 'TERM') {
    eat(s);
    const tt = t as Extract<Tok, { kind: 'TERM' }>;
    const node: Extract<Node, { op: 'TERM' }> = { op: 'TERM', value: tt.value, phrase: tt.phrase };
    if (tt.path !== undefined) node.path = tt.path;
    if (tt.compareOp !== undefined) node.compareOp = tt.compareOp;
    if (tt.isRef) node.isRef = true;
    return node;
  }
  if (t.kind === 'RP') {
    setErr(s, 'Unbalanced parenthesis', t.pos);
    return null;
  }
  // Operator tokens at primary position: invalid
  setErr(s, `Unexpected token '${t.text}'`, t.pos);
  return null;
}

export function parseBooleanQuery(input: string): ParseResult {
  if (!input || !input.trim()) {
    return { ok: true, ast: { op: 'AND', children: [] }, hasOperators: false };
  }
  const tk = tokenize(input);
  if (!tk.ok) return tk;
  if (tk.tokens.length === 0) {
    return { ok: true, ast: { op: 'AND', children: [] }, hasOperators: false };
  }
  const s: PState = { toks: tk.tokens, i: 0, error: null };
  const ast = parseExpr(s);
  if (s.error) return { ok: false, error: s.error.msg, position: s.error.pos };
  if (!ast) {
    const t = peek(s);
    return { ok: false, error: 'Failed to parse expression', position: t?.pos ?? 0 };
  }
  if (s.i < s.toks.length) {
    const t = s.toks[s.i];
    return { ok: false, error: `Unexpected trailing token '${t.text}'`, position: t.pos };
  }
  return { ok: true, ast, hasOperators: tk.hasOperators };
}

// Serialize an AST back to a canonical Axon-flavored boolean-query string.
// Canonicalization rules:
//   - field-op TERMs always render with `==`/`!=`/`>=`/etc. (never `:`).
//   - Multi-segment paths render as `a->b->c`.
//   - Ref values render as `@<uuid>` (the `@` is re-added).
//   - Boolean operators always render as lowercase `and`/`or`/`not`
//     (task #59, locked 2026-05-26 — Axon-canonical).
// Note: parse → astSerialize → parse must yield an AST equal to the first
// parse's AST. The string form is NOT guaranteed equal to the user input
// (uppercase `AND` parses fine but serializes to lowercase `and`).
export function astSerialize(node: Node): string {
  if (node.op === 'TERM') {
    const hasField = node.path && node.path.length > 0;
    const fieldStr = hasField ? node.path!.join('->') : '';
    const op = hasField ? (node.compareOp ?? '==') : '';
    const prefix = hasField ? `${fieldStr}${op}` : '';
    if (node.isRef) {
      // Refs are never phrased — emit `@uuid`.
      return `${prefix}@${node.value}`;
    }
    if (node.phrase) {
      const escaped = node.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${prefix}"${escaped}"`;
    }
    return `${prefix}${node.value}`;
  }
  if (node.op === 'NOT') {
    return `not ${wrapIfCompound(node.child)}`;
  }
  if (node.op === 'AND') {
    if (node.children.length === 0) return '';
    return node.children.map(c => wrapIfOr(c)).join(' and ');
  }
  // OR
  return node.children.map(c => wrapIfCompound(c)).join(' or ');
}

function wrapIfCompound(n: Node): string {
  if (n.op === 'TERM' || n.op === 'NOT') return astSerialize(n);
  return `(${astSerialize(n)})`;
}

function wrapIfOr(n: Node): string {
  if (n.op === 'OR') return `(${astSerialize(n)})`;
  return astSerialize(n);
}
