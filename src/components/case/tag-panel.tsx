'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  TAG_SPEC_BY_KIND,
  TIER_LABEL,
  groupByTier,
  type EntityKind,
  type TagSpec,
} from './tag-spec';
import {
  read as hsRead,
  commit as hsCommit,
  defs as hsDefs,
  defsToDocMap,
  firstRow,
  gridHasError,
} from '@/lib/haystack-client';
import { getPreference, setPreference } from '@/lib/indexed-db';
import { RefPicker, type PersonMarker, type RefTarget } from './ref-picker';
import { MarkerPicker } from './marker-picker';
import { MotionTypePicker } from './motion-type-picker';
import { TagInfoPopover } from './tag-info-popover';
import { TagRowActions } from './tag-row-actions';

const TAG_PANEL_MIN_WIDTH = 240;
const TAG_PANEL_MAX_WIDTH = 600;
const TAG_PANEL_DEFAULT_WIDTH = 320;
const TAG_PANEL_WIDTH_PREF_KEY = 'case-management.tagPanelWidth';

function clampPanelWidth(n: number): number {
  return Math.min(TAG_PANEL_MAX_WIDTH, Math.max(TAG_PANEL_MIN_WIDTH, n));
}

interface Props {
  entityKind: EntityKind | null;
  entityId: string | null;
  entityLabel?: string;
  /**
   * If provided, the entityLabel subheader becomes click-to-edit. The
   * callback is invoked with the trimmed new title; the caller is
   * responsible for PATCHing the right model and refreshing state.
   * Throws on failure to surface error to the input.
   */
  onRename?: (newTitle: string) => Promise<void>;
  /**
   * Embedded mode (Haystack Block View editor tab): fill the host container —
   * no fixed width, no drag-resize handle, no collapse button, no width
   * persistence. Selection is entirely props-driven either way (the
   * case-management layout's 'selected-entity-changed' wiring lives in the
   * layout, not here), so multiple instances never fight over selection.
   */
  embedded?: boolean;
}

type HaystackRecord = Record<string, unknown> & { id?: string };

/**
 * Right-column context-aware tag panel.
 * Consumes /api/haystack/read (Agent 3) — gracefully degrades if 404.
 */
export function TagPanel({ entityKind, entityId, entityLabel, onRename, embedded }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState<number>(TAG_PANEL_DEFAULT_WIDTH);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Inline-rename state for the entityLabel subheader.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  // Reset rename state when the selected entity changes.
  useEffect(() => {
    setEditingTitle(false);
    setTitleError(null);
  }, [entityKind, entityId]);

  const beginRename = () => {
    if (!onRename) return;
    setTitleDraft(entityLabel || '');
    setTitleError(null);
    setEditingTitle(true);
    setTimeout(() => titleInputRef.current?.select(), 0);
  };

  const commitRename = async () => {
    if (!onRename) {
      setEditingTitle(false);
      return;
    }
    const next = titleDraft.trim();
    if (!next || next === (entityLabel || '').trim()) {
      setEditingTitle(false);
      setTitleError(null);
      return;
    }
    setSavingTitle(true);
    setTitleError(null);
    try {
      await onRename(next);
      setEditingTitle(false);
    } catch (e) {
      setTitleError(e instanceof Error ? e.message : 'Rename failed');
    } finally {
      setSavingTitle(false);
    }
  };

  const cancelRename = () => {
    setEditingTitle(false);
    setTitleError(null);
  };

  // Load persisted panel width from IndexedDB preferences (once).
  // Embedded instances fill their host — skip width load/persist entirely.
  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    getPreference(TAG_PANEL_WIDTH_PREF_KEY)
      .then((v: unknown) => {
        if (cancelled) return;
        const n = typeof v === 'number'
          ? v
          : typeof v === 'string'
            ? parseInt(v, 10)
            : NaN;
        if (Number.isFinite(n)) setWidth(clampPanelWidth(n));
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [embedded]);

  // Debounced persistence on width change.
  useEffect(() => {
    if (embedded) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      void setPreference(TAG_PANEL_WIDTH_PREF_KEY, width);
    }, 250);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [width, embedded]);

  // Drag handle: mousedown on the left edge starts a global drag.
  // The panel is on the right side of the layout, so dragging the handle
  // LEFT (negative deltaX) increases width, dragging RIGHT shrinks it.
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setWidth(clampPanelWidth(startWidth - delta));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width]);

  const [record, setRecord] = useState<HaystackRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<HaystackRecord>({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Tag specs from the /api/haystack/defs endpoint, with fallback to local stub.
  const [serverDefs, setServerDefs] = useState<Record<string, string> | null>(null);

  // Active ref-picker state (one at a time).
  const [pickerFor, setPickerFor] = useState<{
    spec: TagSpec;
    anchor: DOMRect | null;
  } | null>(null);

  // Active tag-info popover state (one at a time, distinct from pickerFor).
  // Triggered by clicking the "?" icon on any tag row.
  const [infoFor, setInfoFor] = useState<{
    spec: TagSpec;
    anchor: DOMRect | null;
  } | null>(null);

  const openInfo = useCallback((spec: TagSpec, anchor: DOMRect | null) => {
    // Note on toggling: the document `mousedown` handler in TagInfoPopover
    // fires before this `click`, so re-clicking the same "?" closes and
    // then reopens (rather than toggling off). Net effect is "always
    // reopen", which is the desired UX for swapping between tags.
    setInfoFor({ spec, anchor });
  }, []);

  // Local-stub specs for current entity kind
  const baseSpecs: TagSpec[] = useMemo(() => {
    if (!entityKind) return [];
    return TAG_SPEC_BY_KIND[entityKind] || [];
  }, [entityKind]);

  // Merge server doc strings with local stub.
  const specs = useMemo<TagSpec[]>(() => {
    if (!serverDefs) return baseSpecs;
    return baseSpecs.map(s => ({ ...s, doc: serverDefs[s.name] || s.doc }));
  }, [baseSpecs, serverDefs]);

  // Fetch tag defs once (module-level cached in the haystack client).
  useEffect(() => {
    let cancelled = false;
    hsDefs()
      .then(grid => {
        if (cancelled) return;
        const map = defsToDocMap(grid);
        if (Object.keys(map).length) setServerDefs(map);
      })
      .catch(() => { /* keep stub */ });
    return () => { cancelled = true; };
  }, []);

  // Clear any open tag-info popover when the selection changes — otherwise
  // the popover lingers anchored to coordinates that no longer point at a
  // "?" icon (different entity → different tag set).
  useEffect(() => {
    setInfoFor(null);
  }, [entityKind, entityId]);

  // Refetch the entity record on selection change OR after a `filings-changed`
  // / `entity-updated` window event — the latter fires from the Fill Haystack
  // apply flow so freshly-committed tags surface without a manual reload.
  const [refetchTick, setRefetchTick] = useState(0);
  useEffect(() => {
    const handler = () => setRefetchTick((t) => t + 1);
    window.addEventListener('filings-changed', handler);
    window.addEventListener('entity-updated', handler);
    return () => {
      window.removeEventListener('filings-changed', handler);
      window.removeEventListener('entity-updated', handler);
    };
  }, []);

  // Fetch entity record when selection changes (or refetch is requested).
  useEffect(() => {
    if (!entityKind || !entityId) {
      setRecord(null);
      setDraft({});
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    hsRead({ filter: entityKind, id: entityId })
      .then(grid => {
        if (cancelled) return;
        const gridErr = gridHasError(grid);
        if (gridErr) {
          setLoadError(gridErr);
          setRecord({ id: entityId });
          setDraft({ id: entityId });
          return;
        }
        const rec = (firstRow<HaystackRecord>(grid)) || { id: entityId };
        setRecord(rec);
        setDraft(rec);
      })
      .catch(err => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load');
        setRecord({ id: entityId });
        setDraft({ id: entityId });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entityKind, entityId, refetchTick]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  const handleSave = useCallback(async () => {
    if (!entityKind || !entityId) return;
    setSaving(true);
    try {
      // Strip server-resolved `<refName>Label` siblings — they're read-only
      // display hints inlined by /api/haystack/read; persisting them would
      // pollute the tags JSON with stale labels.
      const patch: HaystackRecord = {};
      for (const [k, v] of Object.entries(draft)) {
        if (k.endsWith('Label')) continue;
        patch[k] = v;
      }
      const grid = await hsCommit({ id: entityId, kind: entityKind, patch });
      const gridErr = gridHasError(grid);
      if (gridErr) {
        showToast(`Save failed: ${gridErr}`);
      } else {
        showToast('Saved');
        const rec = firstRow<HaystackRecord>(grid) || draft;
        setRecord(rec);
        setDraft(rec);
        setEditMode(false);
        // Announce the new edge so other mounted views (the block view's
        // worklist and scope graph) refresh. Our own listener re-reads once —
        // the read path emits nothing, so there is no loop.
        window.dispatchEvent(
          new CustomEvent('entity-updated', { detail: { kind: entityKind, id: entityId } }),
        );
      }
    } catch (err) {
      showToast(`Save failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSaving(false);
    }
  }, [entityKind, entityId, draft, showToast]);

  const handleCancel = useCallback(() => {
    setDraft(record || {});
    setEditMode(false);
  }, [record]);

  if (collapsed) {
    return (
      <div className="w-8 border-l border-gray-200 bg-gray-50 flex flex-col items-center py-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          title="Expand tags panel"
          className="p-1 text-gray-400 hover:text-blue-600"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div
          className="mt-2 text-[10px] text-gray-500 uppercase tracking-wider"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Tags
        </div>
      </div>
    );
  }

  // Hide Haystack-ontology plumbing markers (site/equip/point/attachment/...)
  // from the UI. They stay in the underlying record for client compatibility
  // (a SkySpark client traverses via these), but carry no user-actionable info.
  const visibleSpecs = specs.filter(s => !s.internal);
  const grouped = groupByTier(visibleSpecs);

  return (
    <div
      className={embedded
        ? 'bg-gray-50 flex flex-col h-full w-full relative'
        : 'border-l border-gray-200 bg-gray-50 flex flex-col flex-shrink-0 relative'}
      style={embedded ? undefined : { width: `${width}px` }}
    >
      {/* Drag handle (left edge) — drag to resize, persists to IndexedDB */}
      {!embedded && (
        <div
          onMouseDown={handleResizeStart}
          title="Drag to resize"
          className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-blue-400 active:bg-blue-500 transition-colors z-10"
        />
      )}
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-200 bg-white flex items-center gap-2">
        {!embedded && (
          <button
            onClick={() => setCollapsed(true)}
            title="Collapse"
            className="p-0.5 text-gray-400 hover:text-blue-600 flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex-1 truncate">
          {entityKind ? `${entityKind} tags` : 'Tags'}
        </h2>
        {entityKind && entityId && (
          <button
            onClick={() => (editMode ? handleCancel() : setEditMode(true))}
            title={editMode ? 'Cancel edit' : 'Edit tags'}
            className={`p-1 rounded transition-colors ${editMode ? 'text-blue-600 bg-blue-50' : 'text-gray-400 hover:text-blue-600'}`}
          >
            {editMode ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            )}
          </button>
        )}
      </div>

      {/* Subheader: entity label (click-to-rename when onRename is provided) */}
      {entityLabel && (
        <div className="px-3 py-1.5 border-b border-gray-100 bg-white">
          {editingTitle ? (
            <div className="flex items-center gap-1">
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                }}
                onBlur={commitRename}
                disabled={savingTitle}
                className="w-full text-[11px] text-gray-800 bg-white border border-blue-400 rounded px-1.5 py-0.5 outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-50"
                placeholder="Title"
              />
              {savingTitle && (
                <svg className="w-3 h-3 text-blue-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" className="opacity-75" />
                </svg>
              )}
            </div>
          ) : onRename ? (
            <button
              type="button"
              onClick={beginRename}
              title="Click to rename"
              className="block w-full text-left text-[11px] text-gray-500 truncate px-1 -mx-1 rounded hover:bg-blue-50 hover:text-blue-700 transition-colors"
            >
              {entityLabel}
            </button>
          ) : (
            <div className="text-[11px] text-gray-500 truncate" title={entityLabel}>{entityLabel}</div>
          )}
          {titleError && (
            <div className="mt-1 text-[10px] text-red-600">{titleError}</div>
          )}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {!entityKind || !entityId ? (
          <div className="p-4 text-xs text-gray-400 text-center">
            Select a case or filing to view tags.
          </div>
        ) : loading ? (
          <div className="p-4 text-xs text-gray-400 text-center">Loading…</div>
        ) : (
          <div className="p-2 space-y-3">
            {loadError && (
              <div className="px-2 py-1.5 text-[11px] text-amber-700 bg-amber-50 rounded">
                Haystack API unavailable — showing schema only.
              </div>
            )}

            {/* Markers */}
            {grouped.marker.length > 0 && (
              <Section title={TIER_LABEL.marker}>
                {editMode ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {grouped.marker
                        .filter(spec => Boolean(draft[spec.name]))
                        .map(spec => (
                          <RemovableMarkerChip
                            key={spec.name}
                            spec={spec}
                            onRemove={() =>
                              setDraft(prev => ({ ...prev, [spec.name]: false }))
                            }
                            onInfoOpen={openInfo}
                          />
                        ))}
                    </div>
                    <MarkerPicker
                      available={grouped.marker}
                      current={
                        new Set(
                          grouped.marker
                            .filter(s => Boolean(draft[s.name]))
                            .map(s => s.name),
                        )
                      }
                      onAdd={(name) =>
                        setDraft(prev => ({ ...prev, [name]: true }))
                      }
                    />
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {grouped.marker.map(spec => (
                      <MarkerChip
                        key={spec.name}
                        spec={spec}
                        value={Boolean(record?.[spec.name])}
                        editMode={false}
                        onChange={(v) => setDraft(prev => ({ ...prev, [spec.name]: v }))}
                        onInfoOpen={openInfo}
                      />
                    ))}
                  </div>
                )}
              </Section>
            )}

            {/* References */}
            {grouped.ref.length > 0 && (
              <Section title={TIER_LABEL.ref}>
                <div className="space-y-1.5">
                  {grouped.ref.map(spec => (
                    <RefRow
                      key={spec.name}
                      spec={spec}
                      value={(editMode ? draft[spec.name] : record?.[spec.name]) as unknown}
                      label={record?.[`${spec.name}Label`] as unknown}
                      editMode={editMode}
                      onChange={(v) => setDraft(prev => ({ ...prev, [spec.name]: v }))}
                      onOpenPicker={(anchor) => setPickerFor({ spec, anchor })}
                      onInfoOpen={openInfo}
                    />
                  ))}
                </div>
              </Section>
            )}

            {/* Values */}
            {grouped.value.length > 0 && (
              <Section title={TIER_LABEL.value}>
                <div className="space-y-1.5">
                  {grouped.value.map(spec => {
                    if (spec.name === 'motionType') {
                      const v = (editMode ? draft[spec.name] : record?.[spec.name]) as unknown;
                      const slug = typeof v === 'string' && v ? v : null;
                      // In read mode, render nothing when empty (matches ValueRow behaviour).
                      if (!editMode && !slug) return null;
                      return (
                        <div key={spec.name} className="flex items-start gap-2 text-[11px]">
                          <div className="flex items-center gap-1 w-28 flex-shrink-0 text-gray-500">
                            <span className="truncate" title={spec.name}>{spec.name}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <MotionTypePicker
                              value={slug}
                              editable={editMode}
                              onChange={(next) =>
                                setDraft(prev => ({ ...prev, [spec.name]: next }))
                              }
                            />
                          </div>
                        </div>
                      );
                    }
                    return (
                      <ValueRow
                        key={spec.name}
                        spec={spec}
                        value={(editMode ? draft[spec.name] : record?.[spec.name]) as unknown}
                        editMode={editMode}
                        onChange={(v) => setDraft(prev => ({ ...prev, [spec.name]: v }))}
                        onInfoOpen={openInfo}
                      />
                    );
                  })}
                </div>
              </Section>
            )}
          </div>
        )}
      </div>

      {/* Edit footer */}
      {editMode && (
        <div className="border-t border-gray-200 bg-white px-3 py-2 flex items-center justify-end gap-2">
          <button
            onClick={handleCancel}
            className="px-3 py-1 text-xs text-gray-700 hover:bg-gray-100 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {toast && (
        <div className="absolute bottom-3 right-3 bg-gray-900 text-white text-xs px-3 py-1.5 rounded shadow-lg pointer-events-none">
          {toast}
        </div>
      )}

      {pickerFor && pickerFor.spec.refTarget && (
        <RefPicker
          refTarget={pickerFor.spec.refTarget as RefTarget}
          multi={pickerFor.spec.tier === 'refs'}
          personMarker={inferPersonMarker(pickerFor.spec.name)}
          scopeFilter={inferScopeFilter(pickerFor.spec.name, pickerFor.spec.refTarget as RefTarget | undefined, entityKind, draft, record)}
          scopeCaseId={inferScopeCaseId(pickerFor.spec.refTarget as RefTarget | undefined, draft, record)}
          excludeIds={selfExcludeIds(pickerFor.spec.refTarget as RefTarget, entityKind, entityId)}
          value={refValueToPickerValue(
            (editMode ? draft[pickerFor.spec.name] : record?.[pickerFor.spec.name]) as unknown,
            pickerFor.spec.tier === 'refs',
          )}
          onChange={(next) => {
            const specName = pickerFor.spec.name;
            setDraft(prev => ({ ...prev, [specName]: next }));
          }}
          onClose={() => setPickerFor(null)}
          anchorRect={pickerFor.anchor}
        />
      )}

      <TagInfoPopover
        open={!!infoFor}
        spec={infoFor?.spec ?? null}
        anchorRect={infoFor?.anchor ?? null}
        onClose={() => setInfoFor(null)}
        specsForRelated={visibleSpecs}
      />
    </div>
  );
}

/**
 * Exclude the current entity from a same-kind ref picker — e.g. a motion's
 * `motionRef` shouldn't list the motion itself, only other motions it nests
 * under.
 */
function selfExcludeIds(
  refTarget: RefTarget,
  entityKind: EntityKind | null,
  entityId: string | null,
): string[] | undefined {
  if (!entityKind || !entityId) return undefined;
  // RefTarget values mirror EntityKind for same-kind refs.
  if (refTarget === entityKind) {
    const canon = entityId.startsWith('@') ? entityId : `@${entityId}`;
    return [canon];
  }
  return undefined;
}

/** Infer a sub-marker constraint for person refs from the tag name. */
function inferPersonMarker(name: string): PersonMarker | undefined {
  if (name === 'judgeRef' || name === 'judgeRefs') return 'judge';
  if (name === 'courtClerkRef' || name === 'courtClerkRefs') return 'courtClerk';
  if (name === 'courtReporterRef' || name === 'courtReporterRefs') return 'courtReporter';
  // `plaintiffLawyers` / `defendantLawyers` are attorneys, not the parties
  // themselves — constrain the picker to Person rows carrying the `lawyer`
  // intrinsic marker so the dropdown doesn't surface clients/witnesses.
  if (name === 'plaintiffLawyers' || name === 'defendantLawyers') return 'lawyer';
  return undefined;
}

/**
 * Infer a Haystack scope filter for the ref picker.
 *
 * Generic rule: motion / file / motionAttachment / hearing refs always
 * scope to the entity's current case when one is known — picking a motion
 * across cases is almost never what the user wants (Task #4). Special cases
 * (amends/supersedes within an attachment chain, case→courtRef narrowing by
 * court level) layer on top.
 */
function inferScopeFilter(
  name: string,
  refTarget: RefTarget | undefined,
  entityKind: EntityKind | null,
  draft: HaystackRecord,
  record: HaystackRecord | null,
): string | undefined {
  // NOTE: generic case-scoping (motion/doc/motionAttachment/hearing → current
  // case) is NOT done here. A server-side Haystack `caseRef==@<id>` filter
  // compiles to `json_extract(tags, '$.caseRef') = '@<id>'`, but those tables
  // store the case linkage on the `caseId` FK column, not in `tags` — the
  // synthesized `caseRef` is layered post-read by `synthesizeRefsFromColumns`
  // in `src/app/api/haystack/[op]/route.ts`. The route's filter would never
  // match any row.
  //
  // Case scoping is instead applied client-side via the `scopeCaseId` prop on
  // RefPicker. See `inferScopeCaseId` below.
  void refTarget;
  // Case → courtRef: narrow the court picker to the level marker set on the
  // case. Markers can arrive as `{_kind:'marker'}`, `true`, or `'m:'`
  // depending on serialization path — accept any non-false/non-null shape.
  if (entityKind === 'case' && name === 'courtRef') {
    const has = (v: unknown): boolean => v != null && v !== false;
    const pick = (k: string): unknown =>
      (draft && draft[k] !== undefined ? draft[k] : record?.[k]);
    if (has(pick('appellate'))) return `courtType=="appellate"`;
    if (has(pick('trial'))) return `courtType=="trial"`;
    if (has(pick('supreme'))) return `courtType=="supreme"`;
  }
  return undefined;
}

/**
 * Client-side case scope for ref pickers that should only show entities in
 * the current case (motion / doc / motionAttachment / hearing). Returns the
 * canonical `@<caseId>` derived from the entity's own `caseRef`, or undefined
 * when not applicable (no case context or wrong ref target).
 *
 * This is applied in RefPicker after fetching, since the server-side Haystack
 * filter compiler can't reach the `caseId` FK column. See `inferScopeFilter`
 * above for the rationale.
 */
function inferScopeCaseId(
  refTarget: RefTarget | undefined,
  draft: HaystackRecord,
  record: HaystackRecord | null,
): string | undefined {
  if (!refTarget) return undefined;
  const inCaseTargets: ReadonlySet<RefTarget> = new Set<RefTarget>([
    'motion',
    'doc',
    'motionAttachment',
    'hearing',
  ]);
  if (!inCaseTargets.has(refTarget)) return undefined;
  const caseRefRaw =
    (draft && draft.caseRef) ??
    (record && record.caseRef) ??
    null;
  const id = canonRefId(caseRefRaw);
  return id ?? undefined;
}

function canonRefId(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.startsWith('@') ? v : `@${v}`;
  if (typeof v === 'object') {
    const o = v as { val?: string; id?: string };
    if (typeof o.val === 'string') return o.val.startsWith('@') ? o.val : `@${o.val}`;
    if (typeof o.id === 'string') return o.id.startsWith('@') ? o.id : `@${o.id}`;
  }
  return null;
}

/** Coerce a tag-panel ref value into the shape RefPicker expects. */
function refValueToPickerValue(v: unknown, multi: boolean): string | string[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const out = v
      .map(canonRefId)
      .filter((x): x is string => Boolean(x));
    return out.length ? out : null;
  }
  if (typeof v === 'string') {
    if (!v) return null;
    return multi ? [v.startsWith('@') ? v : `@${v}`] : (v.startsWith('@') ? v : `@${v}`);
  }
  const id = canonRefId(v);
  if (!id) return null;
  return multi ? [id] : id;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">{title}</div>
      <div className="bg-white border border-gray-200 rounded p-2">{children}</div>
    </div>
  );
}

/**
 * Click-to-open info trigger. Replaces the prior static `title=` tooltip
 * with a button that opens TagInfoPopover at the click anchor. The native
 * `title=` attribute is kept too for keyboard/hover fallback.
 */
function HelpDot({
  spec,
  onOpen,
}: {
  spec: TagSpec;
  onOpen: (spec: TagSpec, anchor: DOMRect) => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <button
      ref={btnRef}
      type="button"
      title={spec.doc}
      aria-label={`More info: ${spec.name}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = btnRef.current?.getBoundingClientRect();
        if (rect) onOpen(spec, rect);
      }}
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-gray-400 text-[9px] leading-none hover:border-blue-400 hover:text-blue-600 cursor-pointer flex-shrink-0 bg-white transition-colors"
    >
      ?
    </button>
  );
}

function MarkerChip({
  spec, value, editMode, onChange, onInfoOpen,
}: {
  spec: TagSpec;
  value: boolean;
  editMode: boolean;
  onChange: (v: boolean) => void;
  onInfoOpen: (spec: TagSpec, anchor: DOMRect) => void;
}) {
  const active = Boolean(value);
  if (editMode) {
    return (
      <button
        onClick={() => onChange(!active)}
        title={spec.doc}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] border transition-colors ${
          active
            ? 'bg-blue-100 text-blue-800 border-blue-300'
            : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-blue-500' : 'bg-gray-300'}`} />
        {spec.name}
      </button>
    );
  }
  // Read mode: only show set markers.
  if (!active) return null;
  return (
    <span
      title={spec.doc}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] bg-blue-100 text-blue-800 border border-blue-200"
    >
      {spec.name}
      <HelpDot spec={spec} onOpen={onInfoOpen} />
    </span>
  );
}

function RemovableMarkerChip({
  spec, onRemove, onInfoOpen,
}: {
  spec: TagSpec;
  onRemove: () => void;
  onInfoOpen: (spec: TagSpec, anchor: DOMRect) => void;
}) {
  return (
    <span
      title={spec.doc}
      className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-800 border border-emerald-200"
    >
      {spec.name}
      <HelpDot spec={spec} onOpen={onInfoOpen} />
      <button
        type="button"
        onClick={onRemove}
        title={`Remove ${spec.name}`}
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full text-emerald-700 hover:bg-emerald-200 transition-colors"
      >
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}

function formatRefValue(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(formatRefValue).filter(Boolean).join(', ');
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as { _kind?: string; val?: string; displayName?: string; id?: string };
    if (o.displayName) return o.displayName;
    if (o.val) return o.val;
    if (o.id) return `@${o.id}`;
  }
  return String(v);
}

function formatLabelValue(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(formatLabelValue).filter(Boolean).join(', ');
  if (typeof v === 'string') return v;
  return String(v);
}

/**
 * Extract the trailing path segment from a forward- or back-slash path. Used
 * for Document refs (fileRef) where the label is the full filePath but the
 * panel renders just the filename for visual brevity.
 */
function basename(p: string): string {
  if (!p) return p;
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

function RefRow({
  spec, value, label, editMode, onChange, onOpenPicker, onInfoOpen,
}: {
  spec: TagSpec;
  value: unknown;
  label: unknown;
  editMode: boolean;
  onChange: (v: unknown) => void;
  onOpenPicker: (anchor: DOMRect | null) => void;
  onInfoOpen: (spec: TagSpec, anchor: DOMRect) => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const isListTier = spec.tier === 'refs';
  const isListValue = Array.isArray(value);

  // List-valued refs render as chip rows — one chip per id, each labelled
  // from the parallel `<refName>Label` array the server resolver emits. Raw
  // id stays as a tooltip for traceability.
  if (isListTier || isListValue) {
    const rawList: unknown[] = Array.isArray(value) ? (value as unknown[]) : [];
    const labelList: unknown[] = Array.isArray(label) ? (label as unknown[]) : [];
    // In read mode, hide the row entirely when there are no refs.
    if (!editMode && rawList.length === 0) return null;
    // A derived row (orderRefs) renders its chips but offers no way to change
    // them — the next read recomputes the list from the rows that own the edge.
    const hasTypedRefTarget = Boolean(spec.refTarget) && !spec.readOnly;
    return (
      <div className="group flex items-start gap-2 text-[11px]">
        <div className="flex items-center gap-1 w-28 flex-shrink-0 text-gray-500">
          <span className="truncate" title={spec.name}>{spec.name}</span>
          <HelpDot spec={spec} onOpen={onInfoOpen} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap gap-1 items-center">
            {rawList.length === 0 && (
              <span className="text-gray-400">—</span>
            )}
            {rawList.map((rid, i) => {
              const rawId = typeof rid === 'string' ? rid : formatRefValue(rid);
              const idForTooltip = rawId.replace(/^@/, '');
              const labelStr = typeof labelList[i] === 'string'
                ? (labelList[i] as string)
                : '';
              const chipText = labelStr || (idForTooltip ? `${idForTooltip.slice(0, 8)}…` : '(missing)');
              return (
                <span
                  key={`${rawId}-${i}`}
                  title={idForTooltip || undefined}
                  className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[11px] border border-blue-100 max-w-full truncate"
                >
                  {chipText}
                </span>
              );
            })}
            {/* Trailing controls — always right-aligned so Pick/Edit lines up
               across all ref rows regardless of how many chips precede it.
               `ml-auto` pushes the group to the right edge of the flex row;
               `flex-shrink-0` keeps the buttons from wrapping mid-group. */}
            <span className="ml-auto inline-flex items-center gap-1 flex-shrink-0">
              <TagRowActions
                spec={spec}
                value={value}
                editMode={editMode && !spec.readOnly}
                onPaste={(v) => {
                  // For list-valued ref slots, paste appends a single ref UUID
                  // to the existing list (keeps prior picks intact). The
                  // parsed value is a single `{_kind:'ref',val:<uuid>}` from
                  // parseClipboardForSpec.
                  const next = Array.isArray(value) ? [...(value as unknown[]), v] : [v];
                  onChange(next);
                }}
              />
              {editMode && hasTypedRefTarget && rawList.length > 0 && (
                <button
                  type="button"
                  title="Clear all references"
                  onClick={() => onChange(null)}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-gray-300 text-gray-500 bg-white hover:bg-gray-100 transition-colors flex-shrink-0"
                >
                  ×
                </button>
              )}
              {editMode && hasTypedRefTarget && (
                <button
                  ref={btnRef}
                  type="button"
                  title={`Pick ${spec.refTarget}`}
                  onClick={() => onOpenPicker(btnRef.current?.getBoundingClientRect() ?? null)}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors flex-shrink-0"
                >
                  {rawList.length === 0 ? 'Pick…' : 'Edit…'}
                </button>
              )}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Scalar ref rendering (preserved from prior behaviour).
  const rawDisplay = formatRefValue(value);
  const labelDisplay = formatLabelValue(label);
  // Read-mode preference: server-resolved label, with raw ref as tooltip.
  // Falls back to the raw ref string when no label is available (e.g.
  // free-text ref slots without a refTarget table).
  // Document refs (fileRef) carry the full filePath as their label so AI
  // consumers and copy/paste can resolve the disk location. For visual
  // display we want just the filename — keep the full path on hover/title
  // and pass the full label down to TagRowActions for clipboard use.
  const isDocRef = spec.refTarget === 'doc';
  const labelForDisplay = isDocRef && typeof labelDisplay === 'string' && labelDisplay
    ? basename(labelDisplay)
    : labelDisplay;
  const display = labelForDisplay || rawDisplay;
  if (!editMode && !display) return null;
  // A read-only ref (caseRef) still renders its resolved label, but offers no
  // picker, no clear and no paste — its value is synthesized from the owning
  // Prisma column on every read, so an edit here could only ever create a
  // second, divergent copy in the tags JSON.
  const hasTypedRefTarget = Boolean(spec.refTarget) && !spec.readOnly;
  // For Document refs, the tooltip should be the full filePath (more
  // informative than the UUID). For other refs we keep the historical
  // "show the UUID when label differs" behavior so users can still see the id.
  const rawTooltip = isDocRef
    ? (typeof labelDisplay === 'string' ? labelDisplay : rawDisplay)
    : (rawDisplay && labelDisplay && rawDisplay !== labelDisplay ? rawDisplay : '');
  return (
    <div className="group flex items-start gap-2 text-[11px]">
      <div className="flex items-center gap-1 w-28 flex-shrink-0 text-gray-500">
        <span className="truncate" title={spec.name}>{spec.name}</span>
        <HelpDot spec={spec} onOpen={onInfoOpen} />
      </div>
      <div className="flex-1 min-w-0">
        {editMode ? (
          hasTypedRefTarget ? (
            <div className="flex items-center gap-1">
              <div
                className="flex-1 min-w-0 px-1.5 py-0.5 border border-gray-200 rounded text-[11px] bg-white text-gray-800 truncate"
                title={rawTooltip || undefined}
              >
                {display || <span className="text-gray-400">—</span>}
              </div>
              <TagRowActions
                spec={spec}
                value={value}
                label={labelDisplay}
                editMode={editMode}
                onPaste={(v) => onChange(v)}
              />
              {value != null && value !== '' && (
                <button
                  type="button"
                  title="Clear reference"
                  onClick={() => onChange(null)}
                  className="px-1.5 py-0.5 text-[10px] rounded border border-gray-300 text-gray-500 bg-white hover:bg-gray-100 transition-colors flex-shrink-0"
                >
                  ×
                </button>
              )}
              <button
                ref={btnRef}
                type="button"
                title={`Pick ${spec.refTarget}`}
                onClick={() => onOpenPicker(btnRef.current?.getBoundingClientRect() ?? null)}
                className="px-1.5 py-0.5 text-[10px] rounded border border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100 transition-colors flex-shrink-0"
              >
                Pick…
              </button>
            </div>
          ) : (
            <input
              type="text"
              value={typeof value === 'string' ? value : rawDisplay}
              placeholder="@id"
              onChange={e => onChange(e.target.value || null)}
              className="w-full px-1.5 py-0.5 border border-gray-300 rounded text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )
        ) : (
          <span className="inline-flex items-center gap-1">
            <span className="text-gray-800 break-all" title={rawTooltip || undefined}>
              {display}
              {rawTooltip && (
                <span className="text-[10px] text-gray-400 ml-1 font-mono">
                  {rawDisplay.replace(/^@/, '').slice(0, 8)}…
                </span>
              )}
            </span>
            <TagRowActions spec={spec} value={value} label={labelDisplay} editMode={false} onPaste={() => { /* read-only */ }} />
          </span>
        )}
      </div>
    </div>
  );
}

function ValueRow({
  spec, value, editMode, onChange, onInfoOpen,
}: {
  spec: TagSpec;
  value: unknown;
  editMode: boolean;
  onChange: (v: unknown) => void;
  onInfoOpen: (spec: TagSpec, anchor: DOMRect) => void;
}) {
  const inputType =
    spec.valueType === 'number' ? 'number' :
    spec.valueType === 'date' ? 'date' :
    'text';
  // Haystack scalar values can arrive as Hayson objects (`{_kind:'date',val:'…'}`
  // / `{_kind:'dateTime',val:'…+00:00'}`) or as raw strings/numbers. Unwrap for
  // both the display string and the date-input value. `String(haysonObj)` would
  // otherwise emit `[object Object]`.
  const rawString =
    value == null ? '' :
    typeof value === 'object'
      ? (() => {
          const obj = value as { _kind?: unknown; val?: unknown };
          return obj && typeof obj.val === 'string' ? obj.val : '';
        })() :
    String(value);
  const display = inputType === 'date' && rawString
    // YYYY-MM-DD for the date input + display chip; trim any time portion.
    ? rawString.slice(0, 10)
    : rawString;
  if (!editMode && !display) return null;
  // Paste handler must mirror the same value-shape the date/number input
  // commits — strings for text/date, numbers for number, bool for bool —
  // so commitEntity treats it identically.
  const onPasteValue = (v: unknown) => {
    if (spec.valueType === 'date') {
      // parseClipboardForSpec returns `{_kind:'date',val:'YYYY-MM-DD'}`; the
      // existing onChange path stores the YYYY-MM-DD string (the date input
      // emits the raw string, not the Hayson). Unwrap to match.
      if (v && typeof v === 'object' && 'val' in v) {
        onChange((v as { val: string }).val);
        return;
      }
    }
    onChange(v);
  };
  return (
    <div className="group flex items-start gap-2 text-[11px]">
      <div className="flex items-center gap-1 w-28 flex-shrink-0 text-gray-500">
        <span className="truncate" title={spec.name}>{spec.name}</span>
        <HelpDot spec={spec} onOpen={onInfoOpen} />
      </div>
      <div className="flex-1 min-w-0">
        {editMode ? (
          <div className="flex items-center gap-1">
            <input
              type={inputType}
              value={display}
              onChange={e => {
                const v = e.target.value;
                if (spec.valueType === 'number') {
                  onChange(v === '' ? null : Number(v));
                } else {
                  onChange(v || null);
                }
              }}
              className="flex-1 min-w-0 px-1.5 py-0.5 border border-gray-300 rounded text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <TagRowActions spec={spec} value={value} editMode onPaste={onPasteValue} />
            {value != null && value !== '' && (
              <button
                type="button"
                title="Clear value"
                onClick={() => onChange(null)}
                className="px-1.5 py-0.5 text-[10px] rounded border border-gray-300 text-gray-500 bg-white hover:bg-gray-100 transition-colors flex-shrink-0"
              >
                ×
              </button>
            )}
          </div>
        ) : (
          <span className="inline-flex items-center gap-1">
            <span className="text-gray-800 break-words">{display}</span>
            <TagRowActions spec={spec} value={value} editMode={false} onPaste={onPasteValue} />
          </span>
        )}
      </div>
    </div>
  );
}
