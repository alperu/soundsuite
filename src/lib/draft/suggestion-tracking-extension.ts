/**
 * SuggestionTrackingExtension
 *
 * A TipTap extension that registers a ProseMirror plugin responsible for:
 *   1. Tracking a set of "suggestion anchors" — (id, from, to) tuples — and
 *      keeping them live across document edits via transaction Mapping.
 *   2. Rendering a subtle highlight decoration on each active anchor so the
 *      user can see what the pending suggestion refers to.
 *   3. Providing a transient "flash" decoration for the Jump-to-location UX.
 *   4. Marking anchors stale when their range collapses or is fully deleted.
 *
 * The plugin does NOT mutate the document. Accepting a suggestion is done
 * by the parent component through `resolveSuggestionAnchor(id)` followed by
 * an explicit `editor.chain().deleteRange(...).insertContentAt(...)` call.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface SuggestionAnchor {
  id: string;
  from: number;
  to: number;
  /** True once the range has collapsed or been deleted; UI should show "stale". */
  stale: boolean;
}

interface TrackingPluginState {
  anchors: Map<string, SuggestionAnchor>;
  flashIds: Set<string>;
  decorations: DecorationSet;
}

const SUGGESTION_TRACKING_KEY = new PluginKey<TrackingPluginState>('suggestionTracking');

type MetaPayload =
  | { action: 'add'; id: string; from: number; to: number }
  | { action: 'remove'; id: string }
  | { action: 'flash'; id: string }
  | { action: 'clearFlash'; id: string }
  | { action: 'markStale'; ids: string[] }
  | { action: 'replaceAll'; anchors: Array<{ id: string; from: number; to: number }> };

/**
 * Plugin factory — returns a ProseMirror Plugin configured with state + decorations.
 */
function createSuggestionTrackingPlugin(): Plugin<TrackingPluginState> {
  return new Plugin<TrackingPluginState>({
    key: SUGGESTION_TRACKING_KEY,
    state: {
      init: (_, state) => ({
        anchors: new Map(),
        flashIds: new Set(),
        decorations: DecorationSet.create(state.doc, []),
      }),
      apply(tr, prev, _oldState, newState) {
        let anchors = prev.anchors;
        let flashIds = prev.flashIds;

        // Always map existing anchors through the transaction so positions stay live.
        if (tr.docChanged && anchors.size > 0) {
          const mapped = new Map<string, SuggestionAnchor>();
          for (const [id, anchor] of anchors) {
            if (anchor.stale) {
              mapped.set(id, anchor);
              continue;
            }
            const from = tr.mapping.map(anchor.from, 1);
            const to = tr.mapping.map(anchor.to, -1);
            const stale = from >= to; // range collapsed or deleted
            mapped.set(id, { id, from, to, stale });
          }
          anchors = mapped;
        }

        // Apply meta instructions.
        const meta = tr.getMeta(SUGGESTION_TRACKING_KEY) as MetaPayload | undefined;
        if (meta) {
          if (meta.action === 'add') {
            anchors = new Map(anchors);
            anchors.set(meta.id, { id: meta.id, from: meta.from, to: meta.to, stale: false });
          } else if (meta.action === 'remove') {
            anchors = new Map(anchors);
            anchors.delete(meta.id);
          } else if (meta.action === 'flash') {
            flashIds = new Set(flashIds);
            flashIds.add(meta.id);
          } else if (meta.action === 'clearFlash') {
            flashIds = new Set(flashIds);
            flashIds.delete(meta.id);
          } else if (meta.action === 'markStale') {
            anchors = new Map(anchors);
            for (const id of meta.ids) {
              const existing = anchors.get(id);
              if (existing) anchors.set(id, { ...existing, stale: true });
            }
          } else if (meta.action === 'replaceAll') {
            anchors = new Map();
            for (const a of meta.anchors) {
              anchors.set(a.id, { id: a.id, from: a.from, to: a.to, stale: false });
            }
          }
        }

        // Rebuild decorations for the new doc.
        const decorations = computeDecorationSet(newState.doc, anchors, flashIds);

        return { anchors, flashIds, decorations };
      },
    },
    props: {
      decorations(state) {
        return SUGGESTION_TRACKING_KEY.getState(state)?.decorations ?? null;
      },
    },
  });
}

function computeDecorationSet(
  doc: ProseMirrorNode,
  anchors: Map<string, SuggestionAnchor>,
  flashIds: Set<string>
): DecorationSet {
  const docSize = doc.nodeSize - 2; // account for start/end tokens
  const decorations: Decoration[] = [];
  for (const anchor of anchors.values()) {
    if (anchor.stale) continue;
    const from = Math.max(0, Math.min(docSize, anchor.from));
    const to = Math.max(from, Math.min(docSize, anchor.to));
    if (from === to) continue;
    const classes = ['suggestion-anchor'];
    if (flashIds.has(anchor.id)) classes.push('suggestion-flash');
    decorations.push(
      Decoration.inline(from, to, {
        class: classes.join(' '),
        'data-suggestion-id': anchor.id,
      })
    );
  }
  return DecorationSet.create(doc, decorations);
}

// ---------------------------------------------------------------------------
// TipTap Extension wrapper — exposes commands + the plugin
// ---------------------------------------------------------------------------

export interface SuggestionAnchorsStorage {
  /** Read-only snapshot of current anchors. */
  getAnchors(): SuggestionAnchor[];
  /** Resolve a suggestion id to its current live range, or null if stale/missing. */
  resolveAnchor(id: string): { from: number; to: number } | null;
  /** Which ids are currently stale? */
  getStaleIds(): string[];
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    suggestionTracking: {
      addSuggestionAnchor: (payload: { id: string; from: number; to: number }) => ReturnType;
      removeSuggestionAnchor: (payload: { id: string }) => ReturnType;
      flashSuggestionAnchor: (payload: { id: string }) => ReturnType;
      replaceAllSuggestionAnchors: (anchors: Array<{ id: string; from: number; to: number }>) => ReturnType;
    };
  }
}

export const SuggestionTrackingExtension = Extension.create<unknown, SuggestionAnchorsStorage>({
  name: 'suggestionTracking',

  addStorage() {
    return {
      getAnchors: () => [],
      resolveAnchor: () => null,
      getStaleIds: () => [],
    };
  },

  onCreate() {
    // Wire up storage getters that read from plugin state on demand.
    const editor = this.editor;
    const readState = (): TrackingPluginState | undefined =>
      SUGGESTION_TRACKING_KEY.getState(editor.state);

    this.storage.getAnchors = () => {
      const state = readState();
      if (!state) return [];
      return Array.from(state.anchors.values());
    };
    this.storage.resolveAnchor = (id: string) => {
      const state = readState();
      const a = state?.anchors.get(id);
      if (!a || a.stale) return null;
      if (a.from >= a.to) return null;
      return { from: a.from, to: a.to };
    };
    this.storage.getStaleIds = () => {
      const state = readState();
      if (!state) return [];
      return Array.from(state.anchors.values()).filter((a) => a.stale).map((a) => a.id);
    };
  },

  addCommands() {
    return {
      addSuggestionAnchor:
        ({ id, from, to }) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(SUGGESTION_TRACKING_KEY, { action: 'add', id, from, to } satisfies MetaPayload);
            dispatch(tr);
          }
          return true;
        },
      removeSuggestionAnchor:
        ({ id }) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(SUGGESTION_TRACKING_KEY, { action: 'remove', id } satisfies MetaPayload);
            dispatch(tr);
          }
          return true;
        },
      flashSuggestionAnchor:
        ({ id }) =>
        ({ tr, dispatch, editor }) => {
          if (dispatch) {
            tr.setMeta(SUGGESTION_TRACKING_KEY, { action: 'flash', id } satisfies MetaPayload);
            dispatch(tr);
            // Auto-clear after 1.5 seconds.
            setTimeout(() => {
              if (!editor.isDestroyed) {
                const clearTr = editor.state.tr.setMeta(SUGGESTION_TRACKING_KEY, {
                  action: 'clearFlash',
                  id,
                } satisfies MetaPayload);
                editor.view.dispatch(clearTr);
              }
            }, 1500);
          }
          return true;
        },
      replaceAllSuggestionAnchors:
        (anchors) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(SUGGESTION_TRACKING_KEY, { action: 'replaceAll', anchors } satisfies MetaPayload);
            dispatch(tr);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [createSuggestionTrackingPlugin()];
  },
});

// Exported key for advanced callers that want to read plugin state directly.
export { SUGGESTION_TRACKING_KEY };
