'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
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
                <div className="flex flex-wrap gap-1.5">
                  {grouped.marker.map(spec => (
                    <MarkerChip
                      key={spec.name}
                      spec={spec}
                      value={Boolean(editMode ? draft[spec.name] : record?.[spec.name])}
                      editMode={editMode}
                      onChange={(v) => setDraft(prev => ({ ...prev, [spec.name]: v }))}
                    />
                  ))}
                </div>
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
    </div>
  );
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
  spec, value, editMode, onChange,
}: { spec: TagSpec; value: unknown; editMode: boolean; onChange: (v: unknown) => void }) {
  const display = formatRefValue(value);
  if (!editMode && !display) return null;
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <div className="flex items-center gap-1 w-28 flex-shrink-0 text-gray-500">
        <span className="truncate" title={spec.name}>{spec.name}</span>
        <HelpDot doc={spec.doc} />
      </div>
      <div className="flex-1 min-w-0">
        {editMode ? (
          <input
            type="text"
            value={typeof value === 'string' ? value : display}
            placeholder={spec.refTarget ? `@${spec.refTarget}-…` : '@id'}
            onChange={e => onChange(e.target.value || null)}
            className="w-full px-1.5 py-0.5 border border-gray-300 rounded text-[11px] focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
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
