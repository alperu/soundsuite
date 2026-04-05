/**
 * Word-level diff for suggestion cards.
 *
 * Produces a list of spans {kind: 'equal'|'insert'|'delete', text: string}
 * that the UI can render as red/green highlighted words.
 *
 * Algorithm: simple LCS-based word diff (Myers' shortest-edit-script would be
 * optimal, but this is fine for paragraph-scale suggestion text). Zero deps.
 */

export type DiffSpanKind = 'equal' | 'insert' | 'delete';

export interface DiffSpan {
  kind: DiffSpanKind;
  text: string;
}

/** Tokenize preserving whitespace so diff can be rendered without re-joining. */
function tokenize(text: string): string[] {
  // Split on word boundaries but keep whitespace tokens separate.
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** Build an LCS (longest common subsequence) matrix row-by-row. */
function lcsMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const matrix: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
      }
    }
  }
  return matrix;
}

/**
 * Diff two strings at the word level. Returns an array of spans suitable
 * for rendering as red-strike / green-add / plain-equal segments.
 */
export function diffWords(oldText: string, newText: string): DiffSpan[] {
  if (oldText === newText) {
    return oldText.length > 0 ? [{ kind: 'equal', text: oldText }] : [];
  }
  if (oldText.length === 0) return [{ kind: 'insert', text: newText }];
  if (newText.length === 0) return [{ kind: 'delete', text: oldText }];

  const a = tokenize(oldText);
  const b = tokenize(newText);

  // For very long texts, bail out to a line-level diff to avoid O(n*m) blowup.
  if (a.length * b.length > 250_000) {
    return [
      { kind: 'delete', text: oldText },
      { kind: 'insert', text: newText },
    ];
  }

  const matrix = lcsMatrix(a, b);

  // Backtrack to produce the edit script (reversed).
  const script: DiffSpan[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pushSpan(script, 'equal', a[i - 1]);
      i--;
      j--;
    } else if (matrix[i - 1][j] >= matrix[i][j - 1]) {
      pushSpan(script, 'delete', a[i - 1]);
      i--;
    } else {
      pushSpan(script, 'insert', b[j - 1]);
      j--;
    }
  }
  while (i > 0) {
    pushSpan(script, 'delete', a[i - 1]);
    i--;
  }
  while (j > 0) {
    pushSpan(script, 'insert', b[j - 1]);
    j--;
  }

  // script was built in reverse.
  script.reverse();

  // Merge adjacent spans of the same kind for cleaner rendering.
  return mergeAdjacent(script);
}

function pushSpan(out: DiffSpan[], kind: DiffSpanKind, text: string): void {
  // Append to last span if same kind — reduces span count significantly for
  // runs of equal/insert/delete tokens.
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    out.push({ kind, text });
  }
}

function mergeAdjacent(spans: DiffSpan[]): DiffSpan[] {
  const out: DiffSpan[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last && last.kind === span.kind) {
      last.text += span.text;
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * Convenience: produce a single-line summary "before → after" where the
 * changed portion is highlighted with ⟶. Used in the collapsed row preview.
 */
export function diffSummaryLine(oldText: string, newText: string, maxLen = 80): string {
  const trimmedOld = oldText.length > maxLen / 2 ? oldText.slice(0, maxLen / 2 - 1) + '…' : oldText;
  const trimmedNew = newText.length > maxLen / 2 ? newText.slice(0, maxLen / 2 - 1) + '…' : newText;
  return `${trimmedOld} → ${trimmedNew}`;
}
