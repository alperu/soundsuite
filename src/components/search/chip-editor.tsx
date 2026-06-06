'use client';

/**
 * ChipEditor — TipTap-based composer where `{{ key==value }}` mustaches
 * become real inline atom nodes mixed with free text.
 *
 * Why: a plain <textarea> can't render React components inline. Switching
 * to a TipTap editor lets us show chips as styled pills with hover tooltips,
 * deletable as one unit, drag-droppable in the future, and (Phase 5) capable
 * of dispatching hover events to scope the right-side preview grid.
 *
 * Contract:
 *   - `value` (plain text) and `chips` (FilterChip[]) are the canonical
 *     serialized shape consumed by the existing search submission code.
 *     The editor's TipTap document is the runtime authority — onChange fires
 *     after every doc edit with a fresh `(value, chips)` pair derived from
 *     the doc tree.
 *   - The picker (`ActiveTokenSuggestions`) calls `insertChip(...)` via the
 *     handle ref. Keybindings (Enter / Shift+Enter / Esc / arrows) are
 *     wired to picker-control props so the parent owns picker state.
 *
 * Display-name resolution (`@uuid` → human label):
 *   On mount and whenever an `@uuid`-shaped value lands without a stored
 *   displayName, the editor fires a debounced fetch to
 *   `/api/search/path-values?path=<tag>->displayName&prefix=@uuid` and
 *   patches the node's `displayName` attribute with the result.
 */

import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Node, Extension, mergeAttributes, InputRule } from '@tiptap/core';
import { EditorContent, ReactNodeViewRenderer, NodeViewWrapper, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/core';
import type { FilterChip } from '@/lib/search/haystack-query-builder';

// ---------------------------------------------------------------------------
// FilterChipNode — inline atom node rendered by FilterChipNodeView.
//
// Attrs:
//   tag — the surface token (e.g. 'case', 'documentType', 'filingRef')
//   op  — comparison operator (defaults to '==')
//   value — raw value (e.g. '@04a8cd94-…' for refs, '"Reporter\'s Record"' or
//           bare string for enums)
//   displayName — resolved human-readable label, optional. Falls back to value.

type ChipOp = '==' | '!=' | '>=' | '<=' | '>' | '<';

/**
 * A chip wraps a single `{{ ... }}` Axon sub-expression. Examples:
 *   - `case==@04a8cd94…`
 *   - `case==@A or case==@B`
 *   - `(judge==@X and motion)`
 *   - `documentType=="Reporter's Record"`
 *
 * `displayName` is an OPTIONAL pretty label used when the expression is a
 * single `tag==@uuid` ref — we substitute the human name for the uuid in the
 * pill. Otherwise the chip shows the raw expression truncated with ellipsis.
 */
interface ChipNodeAttrs {
  expression: string;
  displayName: string | null;
}

interface ChipEditorChipShape extends ChipNodeAttrs {
  /** Position in the doc — used for hover dispatch. */
  pos?: number;
}

/** Detect whether an expression is a single `tag op value` atom — used for
 *  display-name swap on simple ref chips. */
function parseSimpleAtom(expr: string | undefined | null): { tag: string; op: ChipOp; value: string } | null {
  if (!expr || typeof expr !== 'string') return null;
  const m = /^([A-Za-z_][\w]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(expr.trim());
  if (!m) return null;
  return { tag: m[1], op: m[2] as ChipOp, value: m[3].trim().replace(/^["']|["']$/g, '') };
}

interface ChipNodeViewProps {
  node: { attrs: ChipNodeAttrs };
  getPos: () => number;
  editor: Editor;
  deleteNode: () => void;
}

function FilterChipNodeView({ node, getPos, editor, deleteNode }: ChipNodeViewProps) {
  const expression = (node.attrs.expression ?? '') as string;
  // Two display-name sources:
  //   1. The node's own `displayName` attr (set by the async resolver on
  //      onUpdate, or seeded by chipToNodePayload for legacy chips).
  //   2. The shared module-level `uuidDisplayCache` (populated by the picker
  //      pick handler in search-interface.tsx). This one renders instantly
  //      the moment the chip materializes — without waiting for the async
  //      resolver to fetch.
  const attrDisplay = (node.attrs.displayName ?? null) as string | null;
  // If this chip is a single `tag op @uuid` atom, prefer the picker-populated
  // shared cache as a fallback when the chip's attr hasn't been resolved yet.
  const sharedDisplay: string | null = (() => {
    if (attrDisplay) return null;
    const simple = parseSimpleAtom(expression);
    if (!simple || !simple.value.startsWith('@')) return null;
    return uuidDisplayCache.get(simple.value) ?? null;
  })();
  const displayName = attrDisplay ?? sharedDisplay;

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(expression);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset draft when entering edit mode.
  React.useEffect(() => {
    if (editing) {
      setDraft(expression);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [editing, expression]);

  // Lazy-resolve any @uuids inside the chip's expression that aren't in the
  // shared cache yet. The background fetch updates the cache and fires
  // `uuid-cache-update`, which the editor listens for and uses to dispatch a
  // refresh transaction — and re-rendering this NodeView picks up the new
  // sharedDisplay value.
  React.useEffect(() => {
    if (!expression) return;
    const re = /@[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(expression)) !== null) {
      lazyResolveUuid(m[0]);
    }
  }, [expression]);

  const commitEdit = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) {
        deleteNode();
        return;
      }
      if (trimmed === expression) {
        setEditing(false);
        return;
      }
      // Patch the node's expression attr in place. Clear displayName because
      // it may no longer apply to the new expression.
      editor.commands.command(({ tr, state }) => {
        const pos = getPos();
        const n = state.doc.nodeAt(pos);
        if (!n) return false;
        tr.setNodeMarkup(pos, undefined, { ...n.attrs, expression: trimmed, displayName: null });
        return true;
      });
      setEditing(false);
    },
    [expression, editor, getPos, deleteNode],
  );

  const atom = parseSimpleAtom(expression);
  const renderedExpression: string = (() => {
    if (atom && displayName) return `${atom.tag}${atom.op}${displayName}`;
    // For compound expressions, substitute every cached @uuid with its label.
    // The underlying expression text is unchanged; this only affects what the
    // user sees in the pill.
    let out = expression;
    if (/@[a-f0-9-]{36}/i.test(out)) {
      out = out.replace(/@[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, (uuid) => {
        const label = uuidDisplayCache.get(uuid);
        return label ?? uuid;
      });
    }
    return out;
  })();

  const onMouseEnter = useCallback(() => {
    const evt = new CustomEvent('chip-hover', {
      detail: { expression, displayName },
      bubbles: true,
    });
    document.dispatchEvent(evt);
  }, [expression, displayName]);

  const onMouseLeave = useCallback(() => {
    document.dispatchEvent(new CustomEvent('chip-hover', { detail: null, bubbles: true }));
  }, []);

  if (editing) {
    return (
      <NodeViewWrapper as="span" className="inline-block align-baseline">
        <span
          className="inline-flex flex-nowrap whitespace-nowrap items-center gap-1 px-2 py-0.5 mx-0.5 bg-white text-purple-700 rounded text-xs font-mono border-2 border-purple-500 shadow-sm"
          style={{ maxWidth: '36rem' }}
        >
          <span className="opacity-50 shrink-0">{'{{'}</span>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitEdit(draft);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
              // Stop other keys from leaking to the editor's shortcuts.
              e.stopPropagation();
            }}
            onBlur={() => commitEdit(draft)}
            className="bg-transparent outline-none border-none p-0 m-0 font-mono text-xs text-purple-800 min-w-0"
            style={{ width: `${Math.max(8, Math.min(draft.length + 1, 60))}ch` }}
          />
          <span className="opacity-50 shrink-0">{'}}'}</span>
        </span>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="inline-block align-baseline">
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 bg-purple-100 text-purple-700 rounded text-xs font-mono cursor-pointer select-none border border-purple-200 hover:border-purple-400 hover:bg-purple-50 transition-colors align-top"
        style={{ maxWidth: '100%', wordBreak: 'break-word' }}
        title={`{{ ${expression} }} — click to edit`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={(e) => {
          // Don't enter edit mode when clicking the × button.
          if ((e.target as HTMLElement).closest('[data-chip-delete]')) return;
          e.preventDefault();
          e.stopPropagation();
          // Dispatch chip-focus so the parent's SelectedChipEditor can open.
          // Editing happens in the top multi-line editor, not inline.
          document.dispatchEvent(
            new CustomEvent('chip-focus', {
              detail: { pos: getPos(), expression },
            }),
          );
        }}
        data-chip-expression={expression}
      >
        <span className="opacity-50 shrink-0">{'{{'}</span>
        <span className="font-medium min-w-0" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{renderedExpression}</span>
        <span className="opacity-50 shrink-0">{'}}'}</span>
        <button
          type="button"
          tabIndex={-1}
          data-chip-delete
          onMouseDown={(e) => {
            e.preventDefault();
            deleteNode();
          }}
          className="opacity-50 hover:opacity-100 hover:text-red-600 -mr-0.5 leading-none"
          aria-label="Remove filter"
        >
          ×
        </button>
      </span>
    </NodeViewWrapper>
  );
}

const FilterChipNode = Node.create({
  name: 'filterChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      expression: { default: '' },
      displayName: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-filter-chip]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-filter-chip': '' }), 0];
  },

  addNodeView() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ReactNodeViewRenderer(FilterChipNodeView as any);
  },

  addInputRules() {
    // Cheap path for direct typing — the materialization plugin below is the
    // canonical source of truth, but the InputRule lets the chip pop the
    // instant the user types the second `}` without waiting for the next
    // state cycle.
    return [
      new InputRule({
        find: /\{\{\s*([^{}]+?)\s*\}\}$/,
        handler: ({ state, range, match }) => {
          const expression = (match[1] ?? '').trim();
          if (!expression) return null;
          const { tr } = state;
          tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ expression, displayName: null }),
          );
          return null;
        },
      }),
    ];
  },

  /**
   * Materialization plugin — runs on every transaction. Scans the doc for
   * closed `{{ ... }}` substrings and replaces them with FilterChipNodes.
   *
   * The InputRule above only fires on direct user input; after a `setContents`
   * splice (picker pick), the user typing the final `}}` may not refire the
   * rule. This plugin closes that gap by scanning whenever the doc changes,
   * regardless of how the content got there (paste, programmatic insert,
   * direct typing).
   */
  addProseMirrorPlugins() {
    const nodeType = this.type;
    return [
      new Plugin({
        key: new PluginKey('filter-chip-materialize'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;
          let tr = newState.tr;
          let mutated = false;
          newState.doc.descendants((node, pos) => {
            if (mutated) return false; // one mutation per cycle (positions shift)
            if (!node.isText) return true;
            const text = node.text ?? '';
            const m = /\{\{\s*([^{}]+?)\s*\}\}/.exec(text);
            if (!m) return true;
            const expression = m[1].trim();
            if (!expression) return true;
            const start = pos + m.index;
            const end = start + m[0].length;
            tr = tr.replaceWith(
              start,
              end,
              nodeType.create({ expression, displayName: null }),
            );
            mutated = true;
            return false;
          });
          return mutated ? tr : null;
        },
      }),
    ];
  },
});

// ---------------------------------------------------------------------------
// UuidDecorationExtension — visually replaces `@<uuid>` text nodes with the
// resolved displayName via a CSS pseudo-element decoration. The underlying
// TEXT is unchanged so InputRules / appendTransaction keep working.

const UUID_RE = /@[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g;
const uuidDecorationKey = new PluginKey('uuid-display-decoration');

const UuidDecorationExtension = Extension.create({
  name: 'uuidDisplayDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: uuidDecorationKey,
        state: {
          init(_, state) {
            return buildDecorationSet(state.doc);
          },
          apply(tr, _old, _oldState, newState) {
            if (!tr.docChanged && !tr.getMeta('refresh-decorations')) {
              return _old;
            }
            return buildDecorationSet(newState.doc);
          },
        },
        props: {
          decorations(state) {
            return uuidDecorationKey.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});

// ---------------------------------------------------------------------------
// ChipsOnlyExtension — strips stray text from the editor when chipsOnly=true.
//
// Preserves text that contains `{` (an in-progress mustache the user is
// typing) so the materialization plugin can later turn it into a chip.
// Stray text that has no `{` at all is removed on every transaction.

const ChipsOnlyExtension = Extension.create({
  name: 'chipsOnly',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('chips-only-strip'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((t) => t.docChanged)) return null;
          let tr = newState.tr;
          let mutated = false;
          const deletions: Array<{ from: number; to: number }> = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name === 'filterChip') return false;
            if (!node.isText) return true;
            const text = node.text ?? '';
            if (text.includes('{')) return true;
            if (text.trim() === '') return true;
            deletions.push({ from: pos, to: pos + node.nodeSize });
            return true;
          });
          for (const { from, to } of deletions.reverse()) {
            tr = tr.delete(from, to);
            mutated = true;
          }
          return mutated ? tr : null;
        },
      }),
    ];
  },
});

// Track in-flight lazy fetches AND uuids we've already attempted but couldn't
// resolve, so the decoration plugin doesn't retry on every doc change.
const lazyResolveInflight = new Set<string>();
const lazyResolveTried = new Set<string>();

/**
 * Kick off a background resolve for an `@uuid` that the user typed/pasted
 * but never went through the picker (so the cache wasn't pre-populated).
 * On success, fires a custom event to refresh decorations across all
 * mounted editors.
 */
function lazyResolveUuid(atUuid: string): void {
  if (uuidDisplayCache.has(atUuid)) return;
  if (lazyResolveInflight.has(atUuid)) return;
  if (lazyResolveTried.has(atUuid)) return;
  lazyResolveInflight.add(atUuid);
  // Try the case namespace first, then person. Either is fine — we accept the
  // first non-empty label match.
  const uuid = atUuid.slice(1);
  void (async () => {
    try {
      const tries: Array<{ path: string; prefix?: string }> = [
        { path: 'case->name' },
        { path: 'judgeRef->displayName' },
        { path: 'lawyerRef->displayName' },
        { path: 'reporterRef->displayName' },
        { path: 'clerkRef->displayName' },
        { path: 'filingRef' },
      ];
      for (const t of tries) {
        const params = new URLSearchParams({ path: t.path, prefix: '', limit: '50' });
        const res = await fetch(`/api/search/path-values?${params.toString()}`);
        if (!res.ok) continue;
        const json = (await res.json()) as { options?: Array<{ value: string; label: string; id?: string }> };
        const hit = json.options?.find((o) => o.id === uuid || o.value === atUuid);
        if (hit?.label) {
          uuidDisplayCache.set(atUuid, hit.label);
          // Notify any mounted editor to refresh decorations.
          document.dispatchEvent(new CustomEvent('uuid-cache-update', { detail: atUuid }));
          return;
        }
      }
    } catch {
      /* best-effort */
    } finally {
      lazyResolveInflight.delete(atUuid);
      // Mark as tried regardless of success — avoids endless retries on a
      // doc that contains a stale/unknown @uuid.
      lazyResolveTried.add(atUuid);
    }
  })();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildDecorationSet(doc: any): DecorationSet {
  const docNode = doc;
  const decorations: Decoration[] = [];

  docNode.descendants((node: { isText: boolean; text?: string; type?: { name: string } }, pos: number) => {
    if (node.type?.name === 'filterChip') return false;
    if (!node.isText || !node.text) return true;

    const text = node.text;
    UUID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = UUID_RE.exec(text)) !== null) {
      const atUuid = m[0];
      const displayName = uuidDisplayCache.get(atUuid);
      if (!displayName) {
        // Kick off a background fetch — when it lands, the editor's
        // `uuid-cache-update` listener will dispatch a refresh transaction.
        lazyResolveUuid(atUuid);
        continue;
      }
      const from = pos + m.index;
      const to = from + atUuid.length;
      decorations.push(
        Decoration.inline(from, to, {
          class: 'cl-ref-uuid',
          'data-display-name': displayName,
        }),
      );
    }
    return true;
  });

  return DecorationSet.create(docNode, decorations);
}

// ---------------------------------------------------------------------------
// Doc ↔ (text, chips) serialization
//
// Walk the editor doc tree, emitting text for text nodes and structured
// FilterChip values for filterChip nodes. The two streams are returned
// separately because the existing submit pipeline already accepts them as
// independent fields (haystackChips + aiQuery).

function serializeDoc(editor: Editor): { text: string; chips: FilterChip[] } {
  const parts: string[] = [];
  const chips: FilterChip[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'filterChip') {
      const attrs = node.attrs as ChipNodeAttrs;
      const raw = (attrs.expression ?? '') as string;
      if (!raw) return false; // skip malformed chips
      chips.push({
        kind: 'expression',
        raw,
        label: attrs.displayName ?? undefined,
      });
      return false;
    }
    if (node.isText) {
      parts.push(node.text ?? '');
    }
    if (node.type.name === 'paragraph') {
      if (parts.length > 0) parts.push('\n');
    }
    return true;
  });
  return { text: parts.join('').replace(/^\n+|\n+$/g, ''), chips };
}

/**
 * Serialize the doc into the single composer string the BACKEND expects:
 * chips rendered inline as `{{ raw }}` interleaved with free text, in source
 * order. `segmentChipsAndIntents` (src/lib/search/chip-segments.ts) splits on
 * exactly this shape and pairs each chip with the prose next to it, so the
 * ORDER here is load-bearing — do not hoist chips ahead of text.
 *
 * This differs from `serializeDoc`, which returns text and chips as two
 * separate streams (losing interleaving). The submit path must use THIS so a
 * materialized chip still reaches the backend; the chip-stripped `text` does
 * not contain the `{{ }}` markers.
 */
function serializeComposer(editor: Editor): string {
  const parts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'filterChip') {
      const raw = ((node.attrs as ChipNodeAttrs).expression ?? '').trim();
      if (raw) parts.push(`{{ ${raw} }}`);
      return false;
    }
    if (node.isText) {
      parts.push(node.text ?? '');
    }
    if (node.type.name === 'paragraph') {
      if (parts.length > 0) parts.push('\n');
    }
    return true;
  });
  return parts.join('').replace(/^\n+|\n+$/g, '').trim();
}

/** Build a chip node payload from an arbitrary FilterChip — used when
 *  hydrating `initialChips` (which may be legacy field-shaped chips from URL
 *  state) into the editor doc. */
function chipToNodePayload(chip: FilterChip): Record<string, unknown> | null {
  if ((chip as { kind?: string }).kind === 'expression') {
    const ec = chip as { raw: string; label?: string };
    if (!ec.raw) return null;
    return {
      type: 'filterChip',
      attrs: { expression: ec.raw, displayName: ec.label ?? null },
    };
  }
  // Legacy field-shaped chip → compose `tag op value` into a single expression.
  if ('key' in chip) {
    const op = chip.op ?? '==';
    let value = chip.value;
    if (!value.startsWith('@') && /[\s"]/.test(value)) {
      value = `"${value.replace(/"/g, '\\"')}"`;
    }
    return {
      type: 'filterChip',
      attrs: {
        expression: `${chip.key}${op}${value}`,
        displayName: chip.label ?? null,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display-name resolver — fetch /api/search/path-values for @uuid values
// missing a displayName. Debounced + cached so we don't refetch on every
// keystroke.

const displayNameCache = new Map<string, string>();
const inflightFetches = new Set<string>();

// ---------------------------------------------------------------------------
// UUID → displayName cache for the decoration plugin (Task #35).
// Keyed by `@<uuid>` (the literal text that appears in the editor, e.g.
// `@04a8cd94-359c-4feb-be16-979592c3c235`). Populated via
// `cacheDisplayNameForUuid` before the picker splices the value into the doc.

const uuidDisplayCache = new Map<string, string>();

/**
 * Register a displayName for an `@<uuid>` token so the decoration plugin can
 * visually replace the raw uuid with a human-readable label.
 *
 * Call this BEFORE `editor.setContents(...)` so the first render of the new
 * text already finds the cache entry.
 *
 * @param atUuid  The `@<uuid>` string (e.g. `@04a8cd94-…`). Must start with `@`.
 * @param label   Human-readable label (e.g. `"Smith v. Jones"`).
 */
export function cacheDisplayNameForUuid(atUuid: string, label: string): void {
  if (!atUuid || !label) return;
  uuidDisplayCache.set(atUuid, label);
}

async function resolveDisplayName(tag: string, atValue: string): Promise<string | null> {
  if (!atValue.startsWith('@')) return null;
  const cacheKey = `${tag}|${atValue}`;
  if (displayNameCache.has(cacheKey)) return displayNameCache.get(cacheKey) ?? null;
  if (inflightFetches.has(cacheKey)) return null;
  inflightFetches.add(cacheKey);
  try {
    const path = tag === 'caseRef' || tag === 'case' ? 'case->name' : `${tag}->displayName`;
    const params = new URLSearchParams({ path, prefix: '', limit: '20' });
    const res = await fetch(`/api/search/path-values?${params.toString()}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { options?: Array<{ value: string; label: string; id?: string }> };
    const id = atValue.slice(1);
    const hit = json.options?.find((o) => o.id === id || `@${o.id}` === atValue);
    if (hit?.label) {
      displayNameCache.set(cacheKey, hit.label);
      return hit.label;
    }
  } catch {
    // Network failures are non-fatal — the chip just keeps showing the value.
  } finally {
    inflightFetches.delete(cacheKey);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public component

export interface ChipEditorHandle {
  /**
   * Insert a chip at the current selection. The parent passes either a simple
   * atom (`{tag, op, value}` — assembled into `tag op value`) OR a raw
   * `expression` (the full Axon sub-expression). `displayName` is optional and
   * only meaningful when the chip is a simple ref atom.
   */
  insertChip(attrs:
    | { tag: string; op?: ChipOp; value: string; displayName?: string | null }
    | { expression: string; displayName?: string | null }
  ): void;
  /** Focus the editor. */
  focus(): void;
  /** Replace the entire editor state (used to load from URL state or reset). */
  setContents(text: string, chips: FilterChip[]): void;
  /** Return current absolute cursor offset in the serialized text. */
  getCursorOffset(): number;
  /** Return current serialized text (chips stripped out — free text only). */
  getText(): string;
  /**
   * Return the full composer string with chips inline as `{{ raw }}` in source
   * order, interleaved with free text — the exact shape the backend
   * (segmentChipsAndIntents) parses. Use this, NOT getText(), when submitting
   * a search, or materialized chips silently drop out of the query.
   */
  getComposerString(): string;
  /**
   * Insert raw text at the current caret position. Used by the "+" button in
   * the strip editor to plant a `{{  }}` placeholder that the user can fill in.
   * `cursorOffsetFromEnd` moves the caret back that many positions from the end
   * of the inserted text — use `3` for `'{{  }}'` to land between the spaces.
   */
  insertText(text: string, cursorOffsetFromEnd?: number): void;
  /** Patch the expression attr of the filterChip node at the given PM position. */
  patchChipAt(pos: number, newExpression: string): void;
  /** Delete the filterChip node at the given PM position. */
  deleteChipAt(pos: number): void;
}

export interface ChipEditorProps {
  /** Initial freetext (paragraphs allowed). */
  initialText?: string;
  /** Initial chip set — converted to FilterChipNodes prepended to the doc. */
  initialChips?: FilterChip[];
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  /**
   * When true, only FilterChipNodes are allowed — stray text (except
   * in-progress `{{ ... }}` mustaches) is stripped automatically.
   * Used for the filter-strip editor above the main composer.
   */
  chipsOnly?: boolean;
  /** Fired after every doc edit with the derived (text, chips) shape. */
  onChange?(text: string, chips: FilterChip[]): void;
  /** Caret position in serialized text — fired on selection updates. */
  onCursorChange?(text: string, cursor: number): void;
  /** Shift+Enter pressed. The parent decides whether to submit. */
  onSubmit?(): void;
  /** Whether the parent's picker is currently active (drives Enter behavior). */
  pickerActive?: boolean;
  /** Picker key dispatch — parent owns highlight + commit. */
  onPickerKey?(key: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Tab' | 'Escape' | 'Space'): void;
  /** Fired when hover state of any chip changes (Phase 5). */
  onHoverChip?(chip: { expression: string; displayName: string | null } | null): void;
  className?: string;
}

export const ChipEditor = React.forwardRef<ChipEditorHandle, ChipEditorProps>(function ChipEditor(
  {
    initialText = '',
    initialChips = [],
    placeholder: _placeholder = 'Ask a question…',
    minHeight = 192,
    maxHeight = 800,
    chipsOnly = false,
    onChange,
    onCursorChange,
    onSubmit,
    pickerActive = false,
    onPickerKey,
    onHoverChip,
    className,
  },
  forwardedRef,
) {
  // Stable initial content built once from initialText + initialChips. We
  // prepend chips as inline atoms in front of the text so visually the chip
  // strip becomes the leading content; the user can move them around freely
  // afterward.
  const initialContent = useMemo(() => {
    const content: Array<Record<string, unknown>> = [];
    for (const chip of initialChips) {
      const payload = chipToNodePayload(chip);
      if (payload) {
        content.push(payload);
        content.push({ type: 'text', text: ' ' });
      }
    }
    if (initialText) {
      content.push({ type: 'text', text: initialText });
    }
    return { type: 'doc', content: [{ type: 'paragraph', content: content.length > 0 ? content : undefined }] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track pickerActive in a ref so the keyboard shortcut closure stays stable
  // — TipTap binds shortcuts once at editor construction.
  const pickerActiveRef = useRef(pickerActive);
  useEffect(() => {
    pickerActiveRef.current = pickerActive;
  }, [pickerActive]);

  const onPickerKeyRef = useRef(onPickerKey);
  useEffect(() => {
    onPickerKeyRef.current = onPickerKey;
  }, [onPickerKey]);

  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Drop heavy block extensions — we only need paragraphs + history.
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      UuidDecorationExtension,
      ...(chipsOnly ? [ChipsOnlyExtension] : []),
      FilterChipNode.extend({
        addKeyboardShortcuts() {
          return {
            'Shift-Enter': () => {
              onSubmitRef.current?.();
              return true;
            },
            Enter: () => {
              if (pickerActiveRef.current) {
                onPickerKeyRef.current?.('Enter');
                return true;
              }
              return false;
            },
            Tab: () => {
              if (pickerActiveRef.current) {
                onPickerKeyRef.current?.('Tab');
                return true;
              }
              return false;
            },
            ArrowDown: () => {
              if (pickerActiveRef.current) {
                onPickerKeyRef.current?.('ArrowDown');
                return true;
              }
              return false;
            },
            ArrowUp: () => {
              if (pickerActiveRef.current) {
                onPickerKeyRef.current?.('ArrowUp');
                return true;
              }
              return false;
            },
            Escape: () => {
              if (pickerActiveRef.current) {
                onPickerKeyRef.current?.('Escape');
                return true;
              }
              return false;
            },
            // Shift+Space toggles the highlighted picker option into the
            // multi-select OR-group. Plain Space stays as a literal space so
            // ordinary typing inside `{{ ... }}` works. Mouse equivalents
            // are still Ctrl/Cmd+Click (toggle) and Shift+Click (range).
            'Shift-Space': () => {
              if (pickerActiveRef.current) {
                onPickerKeyRef.current?.('Space');
                return true;
              }
              return false;
            },
          };
        },
      }),
    ],
    content: initialContent,
    editorProps: {
      attributes: {
        class: chipsOnly
          ? 'block w-full bg-transparent px-3 py-2 text-sm text-gray-900 focus:outline-none prose prose-sm max-w-none [&_p]:my-0 [&_p]:leading-relaxed'
          : 'block w-full bg-transparent px-5 pt-4 pb-14 text-sm text-gray-900 placeholder-gray-400 focus:outline-none rounded-2xl prose prose-sm max-w-none [&_p]:my-0 [&_p]:leading-relaxed',
        style: chipsOnly
          ? `min-height: ${minHeight}px; max-height: ${maxHeight}px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere;`
          : `min-height: ${minHeight}px; max-height: ${maxHeight}px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere;`,
      },
    },
    onUpdate({ editor }) {
      const { text, chips } = serializeDoc(editor);
      onChange?.(text, chips);
      // For simple-atom chips (`tag op @uuid`), resolve a displayName so the
      // pill renders the human label instead of the raw uuid. Compound
      // expressions skip this — they show their raw content.
      editor.state.doc.descendants((node) => {
        if (node.type.name !== 'filterChip') return true;
        const attrs = node.attrs as ChipNodeAttrs;
        if (attrs.displayName) return false;
        const atom = parseSimpleAtom(attrs.expression);
        if (!atom || !atom.value.startsWith('@')) return false;
        const exprKey = attrs.expression;
        void resolveDisplayName(atom.tag, atom.value).then((label) => {
          if (!label) return;
          editor.commands.command(({ tr, state }) => {
            state.doc.descendants((n, p) => {
              if (n.type.name === 'filterChip') {
                const a = n.attrs as ChipNodeAttrs;
                if (a.expression === exprKey && !a.displayName) {
                  tr.setNodeMarkup(p, undefined, { ...a, displayName: label });
                }
              }
              return true;
            });
            return true;
          });
        });
        return false;
      });
    },
    onSelectionUpdate({ editor }) {
      const { text } = serializeDoc(editor);
      // Approximate the caret offset in the serialized text by counting
      // characters of preceding text/chip nodes. Chips contribute 0 to text
      // length but the caret may be just before or after one — we treat a
      // chip as contributing a single space for cursor purposes.
      const sel = editor.state.selection;
      let offset = 0;
      editor.state.doc.descendants((node, pos) => {
        if (pos >= sel.from) return false;
        if (node.isText) {
          const overlap = Math.max(0, Math.min(sel.from - pos, node.nodeSize));
          offset += overlap;
        }
        return true;
      });
      onCursorChange?.(text, Math.min(offset, text.length));
    },
    immediatelyRender: false,
  });

  // Wire chip hover dispatch — the NodeView fires `chip-hover` on document.
  useEffect(() => {
    if (!onHoverChip) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail) {
        onHoverChip(null);
        return;
      }
      onHoverChip(detail);
    };
    document.addEventListener('chip-hover', handler as EventListener);
    return () => document.removeEventListener('chip-hover', handler as EventListener);
  }, [onHoverChip]);

  // Refresh decorations AND patch chip attrs when a lazy @uuid → displayName
  // resolve lands. Decorations re-emit when the meta flag is set; chip
  // NodeViews only re-render when their attrs change, so for simple-atom
  // chips matching the resolved uuid we also patch their `displayName` attr.
  // For compound chips containing the uuid, we touch the `displayName` attr
  // to a sentinel-truthy value (' ') so the NodeView re-renders and picks up
  // the cache via its render-time substitution.
  useEffect(() => {
    if (!editor) return;
    const handler = (e: Event) => {
      const atUuid = (e as CustomEvent).detail as string | undefined;
      // Always refresh decorations (covers @uuids in free text).
      editor.view.dispatch(editor.view.state.tr.setMeta('refresh-decorations', true));
      if (!atUuid) return;
      const label = uuidDisplayCache.get(atUuid);
      if (!label) return;
      // Patch chip attrs in a single command for the matching uuid.
      editor.commands.command(({ tr, state }) => {
        let touched = false;
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'filterChip') return true;
          const attrs = node.attrs as ChipNodeAttrs;
          if (!attrs.expression || !attrs.expression.includes(atUuid)) return false;
          const atom = parseSimpleAtom(attrs.expression);
          if (atom && atom.value === atUuid) {
            tr.setNodeMarkup(pos, undefined, { ...attrs, displayName: label });
            touched = true;
          } else {
            // Compound — touch attr to force re-render; renderedExpression
            // picks the label from the shared cache at render time.
            tr.setNodeMarkup(pos, undefined, { ...attrs, displayName: attrs.displayName ?? ' ' });
            touched = true;
          }
          return false;
        });
        return touched;
      });
    };
    document.addEventListener('uuid-cache-update', handler as EventListener);
    return () => document.removeEventListener('uuid-cache-update', handler as EventListener);
  }, [editor]);

  // Imperative handle for the parent picker integration.
  useImperativeHandle(forwardedRef, () => ({
    insertChip(attrs) {
      if (!editor) return;
      let expression: string;
      if ('expression' in attrs) {
        expression = attrs.expression ?? '';
      } else {
        const op = attrs.op ?? '==';
        let value = attrs.value ?? '';
        if (!value.startsWith('@') && /[\s"]/.test(value)) {
          value = `"${value.replace(/"/g, '\\"')}"`;
        }
        expression = `${attrs.tag}${op}${value}`;
      }
      if (!expression) return; // refuse empty chips
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'filterChip',
          attrs: { expression, displayName: attrs.displayName ?? null },
        })
        .insertContent(' ')
        .run();
    },
    focus() {
      editor?.commands.focus();
    },
    setContents(text, chips) {
      if (!editor) return;
      const content: Array<Record<string, unknown>> = [];
      for (const chip of chips) {
        const payload = chipToNodePayload(chip);
        if (payload) {
          content.push(payload);
          content.push({ type: 'text', text: ' ' });
        }
      }
      if (text) content.push({ type: 'text', text });
      editor.commands.setContent({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: content.length > 0 ? content : undefined,
          },
        ],
      });
      // After a setContent the caret defaults to the start; move it to the
      // end of the doc so typing continues where the user was.
      editor.commands.focus('end');
    },
    getCursorOffset() {
      if (!editor) return 0;
      const sel = editor.state.selection;
      let offset = 0;
      editor.state.doc.descendants((node, pos) => {
        if (pos >= sel.from) return false;
        if (node.isText) offset += Math.max(0, Math.min(sel.from - pos, node.nodeSize));
        return true;
      });
      return offset;
    },
    getText() {
      if (!editor) return '';
      return serializeDoc(editor).text;
    },
    getComposerString() {
      if (!editor) return '';
      return serializeComposer(editor);
    },
    insertText(text: string, cursorOffsetFromEnd = 0) {
      if (!editor) return;
      editor.chain().focus().insertContent(text).run();
      if (cursorOffsetFromEnd > 0) {
        const pos = editor.state.selection.to - cursorOffsetFromEnd;
        editor.commands.setTextSelection(Math.max(0, pos));
      }
    },
    patchChipAt(pos, newExpression) {
      if (!editor) return;
      editor.commands.command(({ tr, state }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'filterChip') return false;
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, expression: newExpression, displayName: null });
        return true;
      });
    },
    deleteChipAt(pos) {
      if (!editor) return;
      editor.commands.command(({ tr, state }) => {
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== 'filterChip') return false;
        tr.delete(pos, pos + node.nodeSize);
        return true;
      });
    },
  }), [editor]);

  return (
    <EditorContent
      editor={editor}
      className={className ?? ''}
    />
  );
});

export type { ChipEditorChipShape };
