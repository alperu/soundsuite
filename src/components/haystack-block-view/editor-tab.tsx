'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TagPanel } from '@/components/case/tag-panel';
import { commitLink, planLink, relinkRef, unfileDocument, unlinkRef } from './link-rules';
import { buildScopeGraph, filingKey, type EntityKey } from './scope-graph';
import { asEntityKind, type ScopeCase, type UnconnectedRow } from './types';
import { DOCUMENT_DRAG_TYPE, UnfiledPanel } from './unfiled-panel';

/** Rete touches `document` on construction — client only, module scope so a
 *  selection re-render never remounts the canvas. */
const BlockCanvas = dynamic(() => import('./block-canvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-[12px] text-gray-400">
      Loading canvas…
    </div>
  ),
});

interface Props {
  /** Worklist rows, already narrowed to the host's scope. */
  rows: UnconnectedRow[];
  /** The same scope-narrowed graph the Filtering tab renders. */
  cases: ScopeCase[];
  caseNameById: Map<string, string>;
  filingTypeById: Map<string, string>;
  loading: boolean;
  focusEntity?: { kind: string; id: string };
}

type KindFilter = 'all' | 'motions' | 'responses' | 'replies' | 'other';

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'motions', label: 'Motions' },
  { id: 'responses', label: 'Responses' },
  { id: 'replies', label: 'Replies' },
  { id: 'other', label: 'Other' },
];

/**
 * One worklist entry. An attachment-kind filing owns two unconnected rows —
 * the MotionAttachment and the shadow Motion that satisfies its FK — sharing
 * one entity id. They collapse into a single entry with a toggle; the
 * attachment wins by default because it carries respondingTo/replyingTo.
 */
interface WorkEntry {
  key: string;
  caseId: string | null;
  label: string;
  filingId: string | null;
  rows: UnconnectedRow[];
  /** Set once a save connects the entry — keeps it in place instead of yanking it. */
  connected?: boolean;
}

/**
 * The shadow Motion and its MotionAttachment are the SAME id, which is the
 * only reliable pairing signal — `filingId` is null whenever no Filing row
 * exists at that id, so keying on it would merge unrelated entries.
 */
function buildEntries(rows: UnconnectedRow[]): WorkEntry[] {
  const byId = new Map<string, WorkEntry>();
  for (const row of rows) {
    const existing = byId.get(row.entityId);
    if (existing) {
      existing.rows.push(row);
      if (row.entityTable === 'MotionAttachment') existing.label = row.label;
      existing.filingId = existing.filingId ?? row.filingId;
      continue;
    }
    byId.set(row.entityId, {
      key: row.entityId,
      caseId: row.caseId,
      label: row.label,
      filingId: row.filingId,
      rows: [row],
    });
  }
  return Array.from(byId.values());
}

function preferredRow(entry: WorkEntry): UnconnectedRow {
  return entry.rows.find(r => r.entityTable === 'MotionAttachment') ?? entry.rows[0];
}

/**
 * Filters on the entry's primary kind, not on every row it owns — nearly every
 * attachment entry also carries a shadow Motion row, so matching across both
 * would make "Motions" select the whole list.
 */
function matchesKind(entry: WorkEntry, filter: KindFilter): boolean {
  if (filter === 'all') return true;
  const kind = preferredRow(entry).entityKind;
  if (filter === 'motions') return kind === 'motion';
  if (filter === 'responses') return kind === 'response';
  if (filter === 'replies') return kind === 'reply';
  return kind !== 'motion' && kind !== 'response' && kind !== 'reply';
}

export function EditorTab({
  rows,
  cases,
  caseNameById,
  filingTypeById,
  loading,
  focusEntity,
}: Props) {
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<'Motion' | 'MotionAttachment' | null>(null);
  const [worklistOpen, setWorklistOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<'unconnected' | 'unfiled' | 'filing'>('unconnected');
  /** Bumped after a file/unfile so the unfiled panel refetches its page. */
  const [unfiledRefresh, setUnfiledRefresh] = useState(0);
  const [draggingDocument, setDraggingDocument] = useState(false);
  /**
   * A block the worklist doesn't list (already mapped, or a case block). The
   * tag panel still has to open on it, so the canvas keeps its own pick.
   */
  const [graphPick, setGraphPick] = useState<{ kind: string; id: string; label: string } | null>(
    null,
  );
  const [banner, setBanner] = useState<{
    tone: 'ok' | 'error';
    text: string;
    /** Present on reversible writes — the banner grows an Undo button. */
    undo?: () => void | Promise<void>;
  } | null>(null);
  const [dropBusy, setDropBusy] = useState(false);

  /** The canvas draws the whole scope, badged with what the worklist reports. */
  const graph = useMemo(
    () => buildScopeGraph(cases, { unconnected: rows, unlinkedLane: true }),
    [cases, rows],
  );
  /** Entries that fell out of the worklist while selected — shown as connected. */
  const [stickyEntries, setStickyEntries] = useState<WorkEntry[]>([]);

  const entries = useMemo(() => buildEntries(rows), [rows]);

  // A save can connect the selected entry, dropping it from the API payload.
  // Park a copy of the version we last saw listed so the user's place in the
  // list survives the edit, flagged connected.
  const lastSeen = useRef<Map<string, WorkEntry>>(new Map());
  useEffect(() => {
    if (!selectedKey) return;
    if (entries.some(e => e.key === selectedKey)) {
      setStickyEntries(prev =>
        prev.some(e => e.key === selectedKey)
          ? prev.filter(e => e.key !== selectedKey)
          : prev,
      );
      return;
    }
    setStickyEntries(prev => {
      if (prev.some(e => e.key === selectedKey)) return prev;
      const prior = lastSeen.current.get(selectedKey);
      return prior ? [...prev, { ...prior, connected: true }] : prev;
    });
  }, [entries, selectedKey]);

  // Declared after the parking effect on purpose: it must observe the map as
  // of the previous render, before this refresh overwrote it.
  useEffect(() => {
    lastSeen.current = new Map(entries.map(e => [e.key, e]));
  }, [entries]);

  const allEntries = useMemo(() => {
    const listed = new Set(entries.map(e => e.key));
    return [...entries, ...stickyEntries.filter(e => !listed.has(e.key))];
  }, [entries, stickyEntries]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allEntries.filter(e => {
      if (!matchesKind(e, kindFilter)) return false;
      if (!needle) return true;
      const caseName = e.caseId ? caseNameById.get(e.caseId) ?? '' : '';
      // Primary kind only, for the same reason `matchesKind` uses it.
      return (
        e.label.toLowerCase().includes(needle) ||
        caseName.toLowerCase().includes(needle) ||
        preferredRow(e).entityKind.toLowerCase().includes(needle)
      );
    });
  }, [allEntries, kindFilter, query, caseNameById]);

  const groups = useMemo(() => {
    const byCase = new Map<string, WorkEntry[]>();
    for (const entry of visible) {
      const key = entry.caseId ?? '';
      const list = byCase.get(key) ?? [];
      list.push(entry);
      byCase.set(key, list);
    }
    return Array.from(byCase.entries())
      .map(([caseId, list]) => ({
        caseId,
        name: caseId ? caseNameById.get(caseId) ?? 'Unknown case' : 'Unassigned',
        entries: list,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [visible, caseNameById]);

  // Preselect the focus row once the worklist has arrived.
  const focusApplied = useRef(false);
  useEffect(() => {
    if (focusApplied.current || !focusEntity || entries.length === 0) return;
    const entry = entries.find(e => e.key === focusEntity.id);
    if (!entry) return;
    focusApplied.current = true;
    const row =
      entry.rows.find(r => r.entityKind === focusEntity.kind) ?? preferredRow(entry);
    setSelectedKey(entry.key);
    setSelectedTable(row.entityTable);
  }, [entries, focusEntity]);

  const selectedEntry = useMemo(
    () => allEntries.find(e => e.key === selectedKey) ?? null,
    [allEntries, selectedKey],
  );
  const selectedRow = useMemo(() => {
    if (!selectedEntry) return null;
    return (
      selectedEntry.rows.find(r => r.entityTable === selectedTable) ??
      preferredRow(selectedEntry)
    );
  }, [selectedEntry, selectedTable]);

  const select = (entry: WorkEntry, table?: 'Motion' | 'MotionAttachment') => {
    setSelectedKey(entry.key);
    setSelectedTable(table ?? preferredRow(entry).entityTable);
    setGraphPick(null);
  };

  useEffect(() => {
    if (!banner) return;
    // An Undo has to outlast the moment of surprise that makes you want it.
    const timer = setTimeout(() => setBanner(null), banner.undo ? 12000 : 3500);
    return () => clearTimeout(timer);
  }, [banner]);

  const handleBlockClick = useCallback(
    (key: EntityKey) => {
      if (key.startsWith('document:')) {
        setBanner({
          tone: 'error',
          text: 'A document carries no tags — drag it onto a filing to file it.',
        });
        return;
      }
      if (key.startsWith('unfiled:')) {
        setBanner({
          tone: 'error',
          text: 'Unfiled documents have no tag row — file them onto a filing first.',
        });
        return;
      }
      if (key.startsWith('case:')) {
        const id = key.slice('case:'.length);
        setSelectedKey(null);
        setSelectedTable(null);
        setGraphPick({ kind: 'case', id, label: caseNameById.get(id) ?? 'Case' });
        return;
      }
      const id = key.slice('filing:'.length);
      const entry = allEntries.find(e => e.key === id);
      if (entry) {
        select(entry);
        return;
      }
      const block = graph.filingById.get(id);
      if (!block) return;
      setSelectedKey(null);
      setSelectedTable(null);
      setGraphPick({
        kind: block.primaryKind || 'motion',
        id,
        label: block.label,
      });
    },
    [allEntries, caseNameById, graph],
  );

  /**
   * A click on empty canvas deselects. `activeKey` is derived from BOTH the
   * worklist selection and the canvas's own pick, so clearing one alone would
   * leave the ring on for whichever block came in through the other path.
   */
  const handleBackgroundClick = useCallback(() => {
    setSelectedKey(null);
    setSelectedTable(null);
    setGraphPick(null);
  }, []);

  /** The filing whose documents the third panel mode lists, if one is active. */
  const activeFiling = useMemo(() => {
    const id = selectedKey ?? (graphPick && graphPick.kind !== 'case' ? graphPick.id : null);
    return id ? graph.filingById.get(id) ?? null : null;
  }, [selectedKey, graphPick, graph]);

  /** Send a filed document back to the unfiled pile. */
  const handleUnfile = useCallback(async (documentId: string) => {
    const result = await unfileDocument(documentId);
    setBanner({ tone: result.ok ? 'ok' : 'error', text: result.message });
    if (result.ok) setUnfiledRefresh(n => n + 1);
  }, []);

  /**
   * Pulling a ref edge off a block's input hub means "unlink this". The write
   * goes through immediately and the banner carries an Undo rather than a
   * modal — a ref is one field, and putting it back is the same one write.
   */
  const handleUnlink = useCallback(
    async (edgeId: string) => {
      const edge = graph.edges.find(e => e.id === edgeId);
      if (!edge || edge.kind !== 'ref' || !edge.slot) return;
      const source = graph.filingById.get(edge.source.replace(/^filing:/, ''));
      const target = graph.filingById.get(edge.target.replace(/^filing:/, ''));
      if (!source || !target) return;
      const params = {
        kind: source.primaryKind,
        id: source.id,
        slot: edge.slot,
        previousTargetId: target.id,
      };
      const result = await unlinkRef(params);
      setBanner({
        tone: result.ok ? 'ok' : 'error',
        text: result.message,
        undo: result.ok
          ? async () => {
              const restored = await relinkRef({
                kind: params.kind,
                id: params.id,
                slot: params.slot,
                targetId: params.previousTargetId,
              });
              setBanner({
                tone: restored.ok ? 'ok' : 'error',
                text: restored.ok ? `${params.slot} restored` : restored.message,
              });
            }
          : undefined,
      });
    },
    [graph],
  );

  /** A drawn connection: validate the pair, write the ref, let the refetch draw it. */
  const handleConnect = useCallback(
    async (source: EntityKey, target: EntityKey, slot?: string) => {
      const plan = planLink(graph, source, target, slot);
      if (!plan.ok) {
        setBanner({ tone: 'error', text: plan.reason });
        return;
      }
      const result = await commitLink(plan.plan);
      setBanner({ tone: result.ok ? 'ok' : 'error', text: result.message });
      // A move relocates the block into another case's cluster, usually
      // off-screen. Making it the active block means the rebuilt canvas marks
      // it — the cheapest answer to "where did my filing just go".
      if (result.ok && plan.plan.type === 'move-filing') {
        const moved = graph.filingById.get(plan.plan.filingId);
        if (moved) {
          setSelectedKey(null);
          setSelectedTable(null);
          setGraphPick({ kind: moved.primaryKind, id: moved.id, label: moved.label });
        }
      }
    },
    [graph],
  );

  /**
   * A row dragged out of the unfiled panel and dropped on the canvas. The
   * block under the cursor decides what it means — only a filing block can
   * take a document, and the same file-document plan the rules layer already
   * validates does the write.
   */
  const handleDocumentDrop = useCallback(
    async (documentId: string, clientX: number, clientY: number) => {
      setDraggingDocument(false);
      const under = document
        .elementsFromPoint(clientX, clientY)
        .map(el => (el as HTMLElement).closest?.('[data-block-id]'))
        .find(Boolean) as HTMLElement | undefined;
      const targetKey = under?.getAttribute('data-block-id');
      if (!targetKey) {
        setBanner({ tone: 'error', text: 'Drop the document onto a filing block.' });
        return;
      }
      const plan = planLink(graph, `document:${documentId}`, targetKey);
      if (!plan.ok) {
        setBanner({ tone: 'error', text: plan.reason });
        return;
      }
      const result = await commitLink(plan.plan);
      setBanner({ tone: result.ok ? 'ok' : 'error', text: result.message });
      if (result.ok) setUnfiledRefresh(n => n + 1);
    },
    [graph],
  );

  /** Dropped PDFs land in the active case's watched directory as QUEUED docs. */
  const dropCaseId = useMemo(() => {
    if (graphPick?.kind === 'case') return graphPick.id;
    if (selectedEntry?.caseId) return selectedEntry.caseId;
    if (graphPick) return graph.filingById.get(graphPick.id)?.caseId ?? null;
    return null;
  }, [graphPick, selectedEntry, graph]);

  const dropCaseName = dropCaseId ? caseNameById.get(dropCaseId) ?? 'this case' : null;

  const handleDrop = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (!dropCaseId) {
        setBanner({ tone: 'error', text: 'Select a case block first — uploads need a case.' });
        return;
      }
      const pdfs = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
      if (pdfs.length === 0) {
        setBanner({ tone: 'error', text: 'Only PDFs can be dropped here.' });
        return;
      }
      setDropBusy(true);
      try {
        const form = new FormData();
        for (const file of pdfs) form.append('file', file);
        // Uploads land unfiled on purpose. Filing is its own deliberate
        // gesture — drag the row out of the Unfiled docs panel onto a filing
        // block — and the block that happens to be selected for tag editing is
        // too incidental to silently decide where a document belongs.
        const res = await fetch(`/api/cases/${dropCaseId}/upload`, { method: 'POST', body: form });
        const body = (await res.json()) as {
          results?: { status: string; duplicate?: boolean }[];
          error?: string;
        };
        if (!res.ok) {
          setBanner({ tone: 'error', text: `Upload failed: ${body.error ?? res.status}` });
          return;
        }
        const results = body.results ?? [];
        // The route dedupes on file hash, so a re-drop adds nothing. Saying
        // "queued" for those would claim work that never happened.
        const duplicates = results.filter(r => r.duplicate).length;
        const failed = results.filter(r => r.status === 'skipped' || r.status === 'error').length;
        const queued = results.length - duplicates - failed;
        const parts: string[] = [];
        if (queued > 0) parts.push(`${queued} queued for indexing`);
        if (duplicates > 0) parts.push(`${duplicates} already in this case`);
        if (failed > 0) parts.push(`${failed} rejected`);
        setBanner({
          // A duplicate is information, not a failure — only a rejection is.
          tone: failed > 0 ? 'error' : 'ok',
          text: parts.length > 0 ? parts.join(' · ') : 'Nothing to upload',
        });
        setUnfiledRefresh(n => n + 1);
        window.dispatchEvent(new CustomEvent('entity-updated', { detail: { kind: 'case', id: dropCaseId } }));
      } catch (err) {
        setBanner({
          tone: 'error',
          text: `Upload failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        });
      } finally {
        setDropBusy(false);
      }
    },
    [dropCaseId, graph, graphPick],
  );

  const activeKey: EntityKey | null = selectedKey
    ? filingKey(selectedKey)
    : graphPick
      ? graphPick.kind === 'case'
        ? `case:${graphPick.id}`
        : filingKey(graphPick.id)
      : null;

  const panelKind = selectedRow ? selectedRow.entityKind : graphPick?.kind ?? null;
  const panelId = selectedRow ? selectedRow.entityId : graphPick?.id ?? null;
  const panelLabel = selectedRow ? selectedEntry?.label : graphPick?.label;

  return (
    <div className="flex h-full min-h-0">
      {/* Worklist */}
      {!worklistOpen && (
        <button
          onClick={() => setWorklistOpen(true)}
          title="Show worklist"
          className="w-7 flex-shrink-0 border-r border-gray-200 bg-gray-50 text-[10px] text-gray-500 hover:bg-gray-100"
        >
          ›
        </button>
      )}
      <div
        className={`${
          worklistOpen ? 'w-[320px]' : 'hidden'
        } flex-shrink-0 flex flex-col min-h-0 border-r border-gray-200 bg-white`}
      >
        {/* The left column carries three lists: what still needs mapping, what
            still needs filing, and — once a filing block is active — what that
            filing holds, which is the only place a filed document is visible. */}
        <div className="flex items-center border-b border-gray-200 bg-gray-50">
          {(['unconnected', 'unfiled', 'filing'] as const).map(t => (
            <button
              key={t}
              onClick={() => setLeftTab(t)}
              disabled={t === 'filing' && !activeFiling}
              title={
                t === 'filing' && !activeFiling
                  ? 'Pick a filing block to see its documents'
                  : undefined
              }
              className={`px-3 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                leftTab === t
                  ? 'border-b-2 border-blue-600 bg-white text-blue-700'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'unconnected'
                ? `Unconnected (${allEntries.length})`
                : t === 'unfiled'
                  ? 'Unfiled docs'
                  : `Filing docs${activeFiling ? ` (${activeFiling.docCount})` : ''}`}
            </button>
          ))}
          <button
            onClick={() => setWorklistOpen(false)}
            title="Hide panel"
            className="ml-auto px-2 text-[11px] text-gray-400 hover:text-gray-600"
          >
            ‹
          </button>
        </div>

        {leftTab === 'filing' && activeFiling ? (
          <UnfiledPanel
            caseNameById={caseNameById}
            refreshKey={unfiledRefresh}
            filingId={activeFiling.id}
            filingLabel={activeFiling.label}
            onUnfile={handleUnfile}
          />
        ) : leftTab === 'unfiled' ? (
          <UnfiledPanel
            caseNameById={caseNameById}
            refreshKey={unfiledRefresh}
            onDragStateChange={setDraggingDocument}
          />
        ) : (
        <>
        <div className="px-3 py-2 border-b border-gray-200 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Unconnected
            </h2>
            <span className="text-[11px] text-gray-400 tabular-nums">
              {visible.length} of {allEntries.length}
            </span>
          </div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search worklist…"
            className="w-full rounded border border-gray-200 px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex gap-1">
            {KIND_FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setKindFilter(f.id)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  kindFilter === f.id
                    ? 'bg-blue-100 text-blue-700'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && allEntries.length === 0 && (
            <p className="px-3 py-4 text-[12px] text-gray-400">Loading worklist…</p>
          )}
          {!loading && visible.length === 0 && (
            <p className="px-3 py-4 text-[12px] text-gray-400">
              Nothing unconnected in scope.
            </p>
          )}
          {groups.map(group => (
            <div key={group.caseId || 'unassigned'}>
              <div className="sticky top-0 z-10 flex items-center justify-between bg-gray-50 px-3 py-1.5 border-y border-gray-200">
                <span className="text-[11px] font-semibold text-gray-600 truncate">
                  {group.name}
                </span>
                <span className="text-[10px] text-gray-400 tabular-nums">
                  {group.entries.length}
                </span>
              </div>
              {group.entries.map(entry => {
                const row = preferredRow(entry);
                const filingType = entry.filingId
                  ? filingTypeById.get(entry.filingId)
                  : undefined;
                const isSelected = entry.key === selectedKey;
                const pair = entry.rows.length > 1;
                return (
                  <div
                    key={entry.key}
                    className={`px-3 py-2 border-b border-gray-100 cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                    onClick={() => select(entry)}
                  >
                    <div className="flex items-start gap-2">
                      <span className="flex-1 text-[12px] text-gray-800 leading-snug break-words">
                        {entry.label}
                      </span>
                      {entry.connected && (
                        <span className="flex-shrink-0 text-[10px] font-medium text-green-700">
                          connected ✓
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                        {filingType ?? row.entityKind}
                      </span>
                      {!entry.connected &&
                        row.missing.map(m => (
                          <span
                            key={m}
                            className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
                          >
                            {m}
                          </span>
                        ))}
                    </div>
                    {pair && (
                      <div className="mt-1.5 flex gap-1">
                        {entry.rows.map(r => (
                          <button
                            key={r.entityTable}
                            onClick={e => {
                              e.stopPropagation();
                              select(entry, r.entityTable);
                            }}
                            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                              isSelected && selectedRow?.entityTable === r.entityTable
                                ? 'bg-blue-600 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                            }`}
                            title={`Edit the ${r.entityTable} row`}
                          >
                            {r.entityKind}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        </>
        )}
      </div>

      {/* Canvas */}
      <div
        className="relative flex-1 min-h-0 min-w-0 border-r border-gray-200 bg-[radial-gradient(circle,rgba(0,0,0,0.06)_1px,transparent_1px)] [background-size:18px_18px]"
        onDragOver={e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DOCUMENT_DRAG_TYPE)
            ? 'link'
            : 'copy';
        }}
        onDrop={e => {
          e.preventDefault();
          const documentId = e.dataTransfer.getData(DOCUMENT_DRAG_TYPE);
          if (documentId) {
            void handleDocumentDrop(documentId, e.clientX, e.clientY);
            return;
          }
          void handleDrop(e.dataTransfer.files);
        }}
      >
        {loading && cases.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-gray-400">
            Loading scope…
          </div>
        ) : (
          <BlockCanvas
            mode="edit"
            graph={graph}
            activeKey={activeKey}
            onSelectBlock={handleBlockClick}
            onBackgroundClick={handleBackgroundClick}
            onConnect={handleConnect}
            onRefuse={reason => setBanner({ tone: 'error', text: reason })}
            onUnlink={edgeId => void handleUnlink(edgeId)}
          />
        )}

        {/* Droplet */}
        <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-2">
          <label
            className={`pointer-events-auto cursor-pointer rounded-lg border-2 border-dashed px-3 py-2 text-[11px] shadow-sm transition-colors ${
              dropCaseId
                ? 'border-blue-300 bg-white/90 text-blue-700 hover:bg-blue-50'
                : 'border-gray-300 bg-white/80 text-gray-400'
            }`}
            title={
              dropCaseId
                ? `Drop PDFs here, or click to choose files — they land in ${dropCaseName} as unfiled documents`
                : 'Select a case or filing block first'
            }
          >
            <input
              type="file"
              accept="application/pdf"
              multiple
              className="hidden"
              onChange={e => {
                void handleDrop(e.target.files);
                e.target.value = '';
              }}
            />
            {dropBusy ? 'Uploading…' : 'Drop PDFs here'}
            {/* Say where the drop lands before it happens — the destination
                comes from the selected block, which is otherwise invisible. */}
            {dropCaseId && !dropBusy && (
              <span className="mt-0.5 block text-[10px] font-normal text-gray-500">
                → {dropCaseName} (unfiled)
              </span>
            )}
          </label>
          {draggingDocument && (
            <span className="rounded bg-indigo-600 px-2 py-1 text-[10px] font-medium text-white shadow">
              Drop on a filing block to file this document
            </span>
          )}
          <span className="rounded bg-white/85 px-2 py-1 text-[10px] text-gray-500 shadow-sm">
            Drag a socket to link: response → motion, reply → response, document → filing
          </span>
          <span className="rounded bg-white/85 px-2 py-1 text-[10px] text-gray-400 shadow-sm">
            Sockets are typed — while dragging, only blocks that accept the link stay lit
          </span>
        </div>

        {banner && (
          <div
            className={`absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded px-3 py-1.5 text-[11px] shadow-lg ${
              banner.tone === 'ok' ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
            }`}
          >
            {banner.text}
            {banner.undo && (
              <button
                onClick={() => void banner.undo?.()}
                className="rounded bg-white/20 px-1.5 py-0.5 font-medium hover:bg-white/30"
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tag editor */}
      <div className="w-[340px] flex-shrink-0 min-h-0">
        {panelKind && panelId ? (
          <TagPanel
            embedded
            entityKind={asEntityKind(panelKind)}
            entityId={panelId}
            entityLabel={panelLabel}
          />
        ) : (
          <div className="h-full flex items-center justify-center bg-gray-50 px-4">
            <p className="text-[12px] text-gray-400 text-center">
              Pick a block on the canvas or an entry in the worklist to edit its tags.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
