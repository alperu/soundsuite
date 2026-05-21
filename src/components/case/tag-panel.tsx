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
import { RefPicker, type PersonMarker, type RefTarget } from './ref-picker';
import { MarkerPicker } from './marker-picker';

interface Props {
  entityKind: EntityKind | null;
  entityId: string | null;
  entityLabel?: string;
}

type HaystackRecord = Record<string, unknown> & { id?: string };

/**
 * Right-column context-aware tag panel.
 * Consumes /api/haystack/read (Agent 3) — gracefully degrades if 404.
 */
export function TagPanel({ entityKind, entityId, entityLabel }: Props) {
  const [collapsed, setCollapsed] = useState(false);
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

  // Fetch entity record when selection changes.
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
  }, [entityKind, entityId]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  }, []);

  const handleSave = useCallback(async () => {
    if (!entityKind || !entityId) return;
    setSaving(true);
    try {
      const grid = await hsCommit({ id: entityId, kind: entityKind, patch: draft });
      const gridErr = gridHasError(grid);
      if (gridErr) {
        showToast(`Save failed: ${gridErr}`);
      } else {
        showToast('Saved');
        const rec = firstRow<HaystackRecord>(grid) || draft;
        setRecord(rec);
        setDraft(rec);
        setEditMode(false);
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
    <div className="w-80 border-l border-gray-200 bg-gray-50 flex flex-col flex-shrink-0">
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-200 bg-white flex items-center gap-2">
        <button
          onClick={() => setCollapsed(true)}
          title="Collapse"
          className="p-0.5 text-gray-400 hover:text-blue-600 flex-shrink-0"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
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

      {/* Subheader: entity label */}
      {entityLabel && (
        <div className="px-3 py-1.5 text-[11px] text-gray-500 truncate border-b border-gray-100 bg-white" title={entityLabel}>
          {entityLabel}
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
                      editMode={editMode}
                      onChange={(v) => setDraft(prev => ({ ...prev, [spec.name]: v }))}
                      onOpenPicker={(anchor) => setPickerFor({ spec, anchor })}
                    />
                  ))}
                </div>
              </Section>
            )}

            {/* Values */}
            {grouped.value.length > 0 && (
              <Section title={TIER_LABEL.value}>
                <div className="space-y-1.5">
                  {grouped.value.map(spec => (
                    <ValueRow
                      key={spec.name}
                      spec={spec}
                      value={(editMode ? draft[spec.name] : record?.[spec.name]) as unknown}
                      editMode={editMode}
                      onChange={(v) => setDraft(prev => ({ ...prev, [spec.name]: v }))}
                    />
                  ))}
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
          scopeFilter={inferScopeFilter(pickerFor.spec.name, entityKind, draft, record)}
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
    </div>
  );
}

/** Infer a sub-marker constraint for person refs from the tag name. */
function inferPersonMarker(name: string): PersonMarker | undefined {
  if (name === 'judgeRef' || name === 'judgeRefs') return 'judge';
  if (name === 'courtClerkRef' || name === 'courtClerkRefs') return 'courtClerk';
  if (name === 'courtReporterRef' || name === 'courtReporterRefs') return 'courtReporter';
  return undefined;
}

/** Infer a scope filter for amendment-style refs on a motion record. */
function inferScopeFilter(
  name: string,
  entityKind: EntityKind | null,
  draft: HaystackRecord,
  record: HaystackRecord | null,
): string | undefined {
  if (entityKind !== 'motion') return undefined;
  if (name !== 'amends' && name !== 'supersedes') return undefined;
  const caseRefRaw =
    (draft && draft.caseRef) ??
    (record && record.caseRef) ??
    null;
  const id = canonRefId(caseRefRaw);
  if (!id) return undefined;
  return `caseRef==${id}`;
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

function HelpDot({ doc }: { doc: string }) {
  return (
    <span
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-gray-300 text-gray-400 text-[9px] leading-none cursor-help flex-shrink-0"
      title={doc}
    >
      ?
    </span>
  );
}

function MarkerChip({
  spec, value, editMode, onChange,
}: { spec: TagSpec; value: boolean; editMode: boolean; onChange: (v: boolean) => void }) {
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
      <HelpDot doc={spec.doc} />
    </span>
  );
}

function RemovableMarkerChip({
  spec, onRemove,
}: { spec: TagSpec; onRemove: () => void }) {
  return (
    <span
      title={spec.doc}
      className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-800 border border-emerald-200"
    >
      {spec.name}
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

function RefRow({
  spec, value, editMode, onChange, onOpenPicker,
}: {
  spec: TagSpec;
  value: unknown;
  editMode: boolean;
  onChange: (v: unknown) => void;
  onOpenPicker: (anchor: DOMRect | null) => void;
}) {
  const display = formatRefValue(value);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  if (!editMode && !display) return null;
  const hasTypedRefTarget = Boolean(spec.refTarget);
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <div className="flex items-center gap-1 w-28 flex-shrink-0 text-gray-500">
        <span className="truncate" title={spec.name}>{spec.name}</span>
        <HelpDot doc={spec.doc} />
      </div>
      <div className="flex-1 min-w-0">
        {editMode ? (
          hasTypedRefTarget ? (
            <div className="flex items-center gap-1">
              <div className="flex-1 min-w-0 px-1.5 py-0.5 border border-gray-200 rounded text-[11px] bg-white text-gray-800 truncate">
                {display || <span className="text-gray-400">—</span>}
              </div>
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
              value={typeof value === 'string' ? value : display}
              placeholder="@id"
              onChange={e => onChange(e.target.value || null)}
              className="w-full px-1.5 py-0.5 border border-gray-300 rounded text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          )
        ) : (
          <span className="text-gray-800 break-all">{display}</span>
        )}
      </div>
    </div>
  );
}

function ValueRow({
  spec, value, editMode, onChange,
}: { spec: TagSpec; value: unknown; editMode: boolean; onChange: (v: unknown) => void }) {
  const display = value == null ? '' : String(value);
  if (!editMode && !display) return null;
  const inputType =
    spec.valueType === 'number' ? 'number' :
    spec.valueType === 'date' ? 'date' :
    'text';
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <div className="flex items-center gap-1 w-28 flex-shrink-0 text-gray-500">
        <span className="truncate" title={spec.name}>{spec.name}</span>
        <HelpDot doc={spec.doc} />
      </div>
      <div className="flex-1 min-w-0">
        {editMode ? (
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
            className="w-full px-1.5 py-0.5 border border-gray-300 rounded text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        ) : (
          <span className="text-gray-800 break-words">{display}</span>
        )}
      </div>
    </div>
  );
}
