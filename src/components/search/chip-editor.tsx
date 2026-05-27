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

interface ChipNodeAttrs {
  tag: string;
  op: ChipOp;
  value: string;
  displayName: string | null;
}

interface ChipEditorChipShape extends ChipNodeAttrs {
  /** Position in the doc — used for hover dispatch. */
  pos?: number;
}

interface ChipNodeViewProps {
  node: { attrs: ChipNodeAttrs };
  getPos: () => number;
  editor: Editor;
  deleteNode: () => void;
}

function FilterChipNodeView({ node, deleteNode }: ChipNodeViewProps) {
  const { tag, op, value, displayName } = node.attrs;
  const label = displayName && displayName.length > 0 ? displayName : value;
  const raw = `${tag}${op}${value}`;

  // Dispatch hover events to the editor host so the right panel can rescope.
  // We use a plain CustomEvent on the editor root rather than a context to
  // keep the NodeView self-contained.
  const onMouseEnter = useCallback(() => {
    const evt = new CustomEvent('chip-hover', {
      detail: { tag, op, value, displayName },
      bubbles: true,
    });
    document.dispatchEvent(evt);
  }, [tag, op, value, displayName]);

  const onMouseLeave = useCallback(() => {
    document.dispatchEvent(new CustomEvent('chip-hover', { detail: null, bubbles: true }));
  }, []);

  return (
    <NodeViewWrapper as="span" className="inline-block align-baseline">
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 mx-0.5 bg-purple-100 text-purple-700 rounded text-xs font-mono max-w-[12rem] cursor-default select-none border border-purple-200 hover:border-purple-400 transition-colors"
        title={raw}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        data-chip-tag={tag}
        data-chip-value={value}
      >
        <span className="opacity-60">{tag}</span>
        <span className="opacity-40">{op}</span>
        <span className="font-medium truncate" style={{ maxWidth: '8rem' }}>{label}</span>
        <button
          type="button"
          tabIndex={-1}
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
      tag: { default: '' },
      op: { default: '==' },
      value: { default: '' },
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
    // Match `{{ key==value }}` (including ==, !=, >=, <=, >, <).
    // Triggered as the user types — once the closing `}}` lands, swap the
    // matched range for a FilterChipNode.
    return [
      new InputRule({
        find: /\{\{\s*([^{}=!<>]+?)\s*(==|!=|>=|<=|>|<)\s*([^{}]+?)\s*\}\}$/,
        handler: ({ state, range, match }) => {
          const [, tag, op, value] = match;
          if (!tag || !value) return null;
          const { tr } = state;
          const cleanValue = value.trim().replace(/^["']|["']$/g, '');
          tr.replaceWith(
            range.from,
            range.to,
            this.type.create({
              tag: tag.trim(),
              op: op as ChipOp,
              value: cleanValue,
              displayName: null,
            }),
          );
          return null;
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
      chips.push({
        kind: 'field',
        key: attrs.tag,
        op: attrs.op,
        value: attrs.value,
      });
      // Don't recurse into atom nodes.
      return false;
    }
    if (node.isText) {
      parts.push(node.text ?? '');
    }
    if (node.type.name === 'paragraph') {
      // Paragraph break — insert a single newline. We don't separate before
      // the first paragraph though.
      if (parts.length > 0) parts.push('\n');
    }
    return true;
  });
  // Strip leading/trailing whitespace introduced by paragraph walking.
  return { text: parts.join('').replace(/^\n+|\n+$/g, ''), chips };
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
  /** Insert a chip at the current selection. Called by the parent's picker. */
  insertChip(attrs: { tag: string; op?: ChipOp; value: string; displayName?: string | null }): void;
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
  onPickerKey?(key: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Tab' | 'Escape'): void;
  /** Fired when hover state of any chip changes (Phase 5). */
  onHoverChip?(chip: { tag: string; op: ChipOp; value: string; displayName: string | null } | null): void;
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
      if ('key' in chip) {
        content.push({
          type: 'filterChip',
          attrs: {
            tag: chip.key,
            op: chip.op ?? '==',
            value: chip.value,
            displayName: chip.label ?? null,
          },
        });
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
      // Resolve displayName for any @uuid chip missing one.
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'filterChip') return true;
        const attrs = node.attrs as ChipNodeAttrs;
        if (attrs.displayName || !attrs.value.startsWith('@')) return false;
        const tagKey = attrs.tag;
        const val = attrs.value;
        void resolveDisplayName(tagKey, val).then((label) => {
          if (!label) return;
          // Patch the node's displayName attr. The doc may have moved by then,
          // so search by tag+value rather than by pos.
          editor.commands.command(({ tr, state }) => {
            state.doc.descendants((n, p) => {
              if (n.type.name === 'filterChip') {
                const a = n.attrs as ChipNodeAttrs;
                if (a.tag === tagKey && a.value === val && !a.displayName) {
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
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'filterChip',
          attrs: {
            tag: attrs.tag,
            op: attrs.op ?? '==',
            value: attrs.value,
            displayName: attrs.displayName ?? null,
          },
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
        if ('key' in chip) {
          content.push({
            type: 'filterChip',
            attrs: {
              tag: chip.key,
              op: chip.op ?? '==',
              value: chip.value,
              displayName: chip.label ?? null,
            },
          });
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
