// Hand-rolled precedence-climbing parser for boolean search expressions.
// Grammar: expr = OR of ANDs; AND between adjacent terms is implicit;
// NOT and unary `-` negate; parens group; "..." is a phrase.

export type Node =
  | { op: 'AND' | 'OR'; children: Node[] }
  | { op: 'NOT'; child: Node }
  | { op: 'TERM'; value: string; phrase: boolean; field?: string };

export type ParseResult =
  | { ok: true; ast: Node; hasOperators: boolean }
  | { ok: false; error: string; position: number };

type Tok =
  | { kind: 'AND' | 'OR' | 'NOT' | 'LP' | 'RP' | 'DASH'; pos: number; text: string }
  | { kind: 'TERM'; pos: number; text: string; value: string; phrase: boolean; field?: string };

const OP_WORDS = new Set(['AND', 'OR', 'NOT', 'and', 'or', 'not']);

function isWs(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

function isTermChar(c: string): boolean {
  return !isWs(c) && c !== '(' && c !== ')' && c !== '"';
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

    // Field-qualified term detection.
    // Match the FIRST `:` in the bare term where the prefix is a valid ident.
    // - Leading `:` (no prefix) → not a field; emit as bare term.
    // - Trailing `:` (no inline value): if next char is `"`, consume the phrase as the value.
    //   If next char is whitespace/EOF/paren, parse error (no value).
    // - Otherwise, value is whatever follows the first `:`.
    // Note: `case: "23-CV-1234"` (space after colon) hits the trailing-colon branch
    // and is reported as a parse error — that's the chosen consistent behavior.
    let fieldQualified = false;
    if (buf.length > 0 && buf[0] !== ':') {
      const colonIdx = buf.indexOf(':');
      if (colonIdx > 0) {
        const fieldName = buf.slice(0, colonIdx);
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)) {
          const rest = buf.slice(colonIdx + 1);
          if (rest.length > 0) {
            // Inline value: `field:value`
            tokens.push({ kind: 'TERM', pos: start, text: buf, value: rest, phrase: false, field: fieldName });
            atWordBoundary = false;
            fieldQualified = true;
          } else {
            // Trailing colon — look for a quoted phrase immediately following
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
              tokens.push({ kind: 'TERM', pos: start, text: input.slice(start, i), value: pbuf, phrase: true, field: fieldName });
              hasOperators = true; // phrase counts as operator marker (matches existing behavior for quoted strings)
              atWordBoundary = false;
              fieldQualified = true;
            } else {
              // No value after field — parse error at the colon position
              return { ok: false, error: `Expected value after field '${fieldName}:'`, position: start + colonIdx };
            }
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
    if (tt.field !== undefined) node.field = tt.field;
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

// Serialize an AST back to a canonical boolean-query string.
// Used by deep-search to hand each OR-branch back to the existing pipeline
// as a string the parser can round-trip.
export function astSerialize(node: Node): string {
  if (node.op === 'TERM') {
    const prefix = node.field ? `${node.field}:` : '';
    if (node.phrase) {
      const escaped = node.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${prefix}"${escaped}"`;
    }
    return `${prefix}${node.value}`;
  }
  if (node.op === 'NOT') {
    return `NOT ${wrapIfCompound(node.child)}`;
  }
  if (node.op === 'AND') {
    if (node.children.length === 0) return '';
    return node.children.map(c => wrapIfOr(c)).join(' AND ');
  }
  // OR
  return node.children.map(c => wrapIfCompound(c)).join(' OR ');
}

function wrapIfCompound(n: Node): string {
  if (n.op === 'TERM' || n.op === 'NOT') return astSerialize(n);
  return `(${astSerialize(n)})`;
}

function wrapIfOr(n: Node): string {
  if (n.op === 'OR') return `(${astSerialize(n)})`;
  return astSerialize(n);
}
