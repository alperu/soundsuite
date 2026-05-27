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
import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { EditorContent, ReactNodeViewRenderer, NodeViewWrapper, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Plugin, PluginKey } from '@tiptap/pm/state';
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
  const displayName = (node.attrs.displayName ?? null) as string | null;

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
  const renderedExpression: string = atom && displayName
    ? `${atom.tag}${atom.op}${displayName}`
    : expression;

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
        className="inline-flex flex-nowrap whitespace-nowrap items-center gap-1 px-2 py-0.5 mx-0.5 bg-purple-100 text-purple-700 rounded text-xs font-mono cursor-pointer select-none border border-purple-200 hover:border-purple-400 hover:bg-purple-50 transition-colors"
        style={{ maxWidth: '32rem' }}
        title={`{{ ${expression} }} — click to edit`}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={(e) => {
          // Don't enter edit mode when clicking the × button.
          if ((e.target as HTMLElement).closest('[data-chip-delete]')) return;
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }}
        data-chip-expression={expression}
      >
        <span className="opacity-50 shrink-0">{'{{'}</span>
        <span className="font-medium truncate min-w-0" style={{ maxWidth: '24rem' }}>{renderedExpression}</span>
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
  /** Return current serialized text. */
  getText(): string;
}

export interface ChipEditorProps {
  /** Initial freetext (paragraphs allowed). */
  initialText?: string;
  /** Initial chip set — converted to FilterChipNodes prepended to the doc. */
  initialChips?: FilterChip[];
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
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
        class:
          'block w-full bg-transparent px-5 pt-4 pb-14 text-sm text-gray-900 placeholder-gray-400 focus:outline-none rounded-2xl prose prose-sm max-w-none [&_p]:my-0 [&_p]:leading-relaxed',
        style: `min-height: ${minHeight}px; max-height: ${maxHeight}px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere;`,
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
  }), [editor]);

  return (
    <EditorContent
      editor={editor}
      className={className ?? ''}
    />
  );
});

export type { ChipEditorChipShape };
