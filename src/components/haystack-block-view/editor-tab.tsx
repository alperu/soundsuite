'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, type ContextMenuItem } from '@/components/context-menu';
import { TagPanel } from '@/components/case/tag-panel';
import { commitLink, planLink, relinkRef, unfileDocument, unlinkRef } from './link-rules';
import type { LinkPlan } from './link-rules';
import { hydrateShowAllLinks, setShowAllLinks, useShowAllLinks } from './link-visibility';
import { LinkPopup, type InboundLinkRow } from './link-popup';
import { PairingWorkbench } from './pairing-workbench';
import { setPinned, usePinned } from './hover-state';
import { LinkPicker } from './link-picker';
import { currentPendingLink, setPendingLink, usePendingLink } from './pending-link';
import { commitLinkBatch, visibleSlotsFor, slotLabel } from './link-rules';
import { subscribeTransform } from './zoom-state';
import { panelTargetFor } from './panel-target';
import type { CanvasHandle, ContextTarget } from './block-canvas';
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
  const [leftTab, setLeftTab] = useState<'unconnected' | 'unfiled' | 'filing' | 'pair'>(
    'unconnected',
  );
  /** True while a batch is in flight — the workbench disables Apply. */
  const [batchBusy, setBatchBusy] = useState(false);
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
    /** Batch results stay until dismissed — they are a report, not a flash. */
    sticky?: boolean;
    /** Present on reversible writes — the banner grows an Undo button. */
    undo?: () => void | Promise<void>;
  } | null>(null);
  const [dropBusy, setDropBusy] = useState(false);
  const showAllLinks = useShowAllLinks();
  /** An open menu, and what it was opened on. */
  const [menu, setMenu] = useState<
    | { kind: 'flat'; x: number; y: number; items: ContextMenuItem[] }
    | { kind: 'inbound'; x: number; y: number; targetLabel: string; rows: InboundLinkRow[] }
    | null
  >(null);
  /** The canvas's imperative handle — centering is the canvas's job, not ours. */
  const canvasRef = useRef<CanvasHandle | null>(null);
  /** An open link picker: which end it is filling in, and where it sits. */
  const [picker, setPicker] = useState<
    { sourceKey: string; slot?: string; side: 'input' | 'output'; rect: DOMRect } | null
  >(null);
  const pendingLink = usePendingLink();
  /** A line the user pinned. It stays until they say otherwise (#75). */
  const pinnedKey = usePinned();
  useEffect(() => {
    hydrateShowAllLinks();
  }, []);

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
    if (!banner || banner.sticky) return;
    // An Undo has to outlast the moment of surprise that makes you want it.
    const timer = setTimeout(() => setBanner(null), banner.undo ? 12000 : 3500);
    return () => clearTimeout(timer);
  }, [banner]);

  const handleBlockClick = useCallback(
    (key: EntityKey) => {
      // What the click MEANS is decided by `panelTargetFor`; this only carries
      // out the state writes, so the decision can be tested on its own.
      const target = panelTargetFor(key, {
        graph,
        // Which KINDS each entry has rows for, not just which entries exist:
        // an attachment-kind filing carries a shadow Motion at the same id, and
        // routing a Notice through the list opened that shadow (#86).
        entryKinds: new Map(allEntries.map(e => [e.key, e.rows.map(r => r.entityKind)])),
        caseNameById,
      });
      if (target.kind === 'refuse') {
        setBanner({ tone: 'error', text: target.reason });
        return;
      }
      if (target.kind === 'none') return;
      if (target.kind === 'entry') {
        const entry = allEntries.find(e => e.key === target.entryKey);
        // Open the row that IS this block, not whichever row the list would
        // have preferred on its own.
        const row = entry?.rows.find(r => r.entityKind === target.entityKind);
        if (entry) select(entry, row?.entityTable);
        return;
      }
      setSelectedKey(null);
      setSelectedTable(null);
      setGraphPick({ kind: target.entityKind, id: target.id, label: target.label });
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
  /**
   * Everything that happens AFTER a link has been planned: the write, what the
   * user is told, and where the canvas leaves them.
   *
   * The one commit path, deliberately. A drag, the picker and the menus all
   * arrive here with a plan already made — nobody re-plans from a pair of keys,
   * which is exactly where an inverted slot (orderRef writes on the ORDER)
   * would quietly become a different link than the one the user was shown.
   */
  const commitPlan = useCallback(
    async (plan: LinkPlan, options: { silent?: boolean } = {}) => {
      const result = await commitLink(plan, options);
      // A batch speaks once, at the end, for all of its items.
      if (!options.silent) setBanner({ tone: result.ok ? 'ok' : 'error', text: result.message });
      // A move relocates the block into another case's cluster, usually
      // off-screen. Making it the active block means the rebuilt canvas marks
      // it — the cheapest answer to "where did my filing just go".
      if (result.ok && plan.type === 'move-filing') {
        const moved = graph.filingById.get(plan.filingId);
        if (moved) {
          setSelectedKey(null);
          setSelectedTable(null);
          setGraphPick({ kind: moved.primaryKind, id: moved.id, label: moved.label });
          // Marking it was the old answer to "where did my filing go"; now the
          // canvas actually takes the user there.
          canvasRef.current?.centerOn(filingKey(moved.id));
        }
      }
      return result;
    },
    [graph],
  );

  const handleConnect = useCallback(
    async (source: EntityKey, target: EntityKey, slot?: string) => {
      const plan = planLink(graph, source, target, slot);
      if (!plan.ok) {
        setBanner({ tone: 'error', text: plan.reason });
        return;
      }
      await commitPlan(plan.plan);
    },
    [graph, commitPlan],
  );


  /** Labels for menu copy — the canvas hands us keys, never text. */
  const labelOf = useCallback(
    (key: string) =>
      graph.filingById.get(key.replace(/^filing:/, ''))?.label ??
      graph.caseById.get(key.replace(/^case:/, ''))?.name ??
      'this block',
    [graph],
  );

  /** Every ref pointing AT a block, as the popup wants it. */
  const inboundRowsFor = useCallback(
    (key: string): InboundLinkRow[] =>
      graph.edges
        .filter(edge => edge.kind === 'ref' && edge.target === key)
        .map(edge => ({
          edgeId: edge.id,
          sourceKey: edge.source,
          sourceLabel: labelOf(edge.source),
          slot: edge.slot ?? 'ref',
        })),
    [graph, labelOf],
  );



  /**
   * Apply a whole workbench batch.
   *
   * Every item goes through `commitPlan` — the same path a drag, the picker and
   * the menus use — but silently: the batch owns the announcement and the
   * banner, so N links mean one refetch and one message rather than N of each.
   * The banner stays until dismissed because a batch result is something to
   * read, and it names the failures, because "3 failed" without saying which
   * three is a message that costs more time than it saves.
   */
  const handleApplyBatch = useCallback(
    async (plans: LinkPlan[]) => {
      if (plans.length === 0) return;
      setBatchBusy(true);
      try {
        const result = await commitLinkBatch(plans, plan => commitPlan(plan, { silent: true }));
        const failures = result.items
          .filter(item => !item.ok)
          .map(item => (item.plan.type === 'ref' ? labelOf(filingKey(item.plan.id)) : 'an item'));
        setBanner({
          tone: result.failed === 0 ? 'ok' : 'error',
          text:
            result.failed === 0
              ? `${result.linked} linked`
              : `${result.linked} linked, ${result.failed} failed — ${failures.join(', ')}`,
          sticky: true,
          undo: result.linked > 0 ? async () => {
            const reversal = await result.undo();
            setBanner({
              tone: reversal.failed === 0 ? 'ok' : 'error',
              text:
                reversal.failed === 0
                  ? `${reversal.linked} links undone`
                  : `${reversal.linked} undone, ${reversal.failed} could not be`,
              sticky: true,
            });
          } : undefined,
        });
      } finally {
        setBatchBusy(false);
      }
    },
    [commitPlan, labelOf],
  );

  /** A rect for the picker to hang off, from the click that opened the menu. */
  const rectAt = (at: { x: number; y: number }) =>
    ({
      left: at.x,
      right: at.x,
      top: at.y,
      bottom: at.y,
      width: 0,
      height: 0,
      x: at.x,
      y: at.y,
      toJSON: () => ({}),
    }) as DOMRect;

  /**
   * The "make a link" half of a menu, in the two shapes a user reaches for.
   *
   * "Link … to…" opens the picker — right when the target is easier to name
   * than to find. "Link from here" starts the two-step for when the target is
   * easier to go and look at. Both end at `commitPlan`, so neither can write a
   * different link than the one it showed.
   */
  const linkItemsFor = useCallback(
    (blockKey: string, slot: string | undefined, at: { x: number; y: number }): ContextMenuItem[] => {
      const pending = currentPendingLink();
      const items: ContextMenuItem[] = [];
      const filing = graph.filingById.get(blockKey.replace(/^filing:/, ''));

      if (pending && pending.sourceKey !== blockKey) {
        // The second half of a two-step. Both ends are known, so the rules can
        // be asked directly — no picker, no list to read.
        const plan = planLink(graph, pending.sourceKey, blockKey, pending.slot);
        items.push({
          label: plan.ok
            ? `Link to here (as ${pending.slot ?? 'ref'})`
            : `Cannot link here — ${plan.reason}`,
          disabled: !plan.ok,
          onClick: () => {
            if (!plan.ok) return;
            void commitPlan(plan.plan);
            setPendingLink(null);
          },
        });
        items.push({
          label: 'Cancel pending link',
          onClick: () => setPendingLink(null),
        });
        return items;
      }

      if (slot && slot !== 'id') {
        items.push({
          label: `Link ${slotLabel(slot as never)} to…`,
          onClick: () => setPicker({ sourceKey: blockKey, slot, side: 'output', rect: rectAt(at) }),
        });
        items.push({
          label: 'Link from here',
          onClick: () =>
            setPendingLink({ sourceKey: blockKey, slot, label: `${labelOf(blockKey)} · ${slot}` }),
        });
        return items;
      }

      if (slot === 'id') {
        items.push({
          label: 'Link something to this…',
          onClick: () => setPicker({ sourceKey: blockKey, side: 'input', rect: rectAt(at) }),
        });
        return items;
      }

      // The block itself: one entry per slot it can actually write.
      for (const writable of filing ? visibleSlotsFor(filing.primaryKind, filing.refs) : []) {
        items.push({
          label: `Link ${slotLabel(writable)} to…`,
          onClick: () =>
            setPicker({ sourceKey: blockKey, slot: writable, side: 'output', rect: rectAt(at) }),
        });
      }
      return items;
    },
    [graph, labelOf, commitPlan],
  );

  /**
   * A right-click on the canvas, already resolved to what it hit.
   *
   * Menus are built here rather than in the canvas because every item is a
   * domain action — unlink with undo, centre on a block, pin a line — and the
   * canvas deliberately owns none of those.
   */
  // Escape unwinds whatever this tab has open, outermost first. The canvas
  // also listens (to drop a pinned line) and defers while `menuOpen` — a
  // pending link and an open picker are the same kind of "in progress" state.
  useEffect(() => {
    if (!picker && !pendingLink) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (picker) setPicker(null);
      else setPendingLink(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picker, pendingLink]);

  // A menu is placed in viewport pixels over a canvas that pans and zooms
  // underneath it. `context-menu` closes itself on DOM scroll, which a rete pan
  // never fires — so the canvas transform is what has to close it, or the menu
  // floats away from the thing it describes.
  useEffect(() => {
    if (!menu) return;
    let first = true;
    return subscribeTransform(() => {
      // The subscription fires once on attach with the current transform.
      if (first) {
        first = false;
        return;
      }
      setMenu(null);
    });
  }, [menu]);

  const handleContextMenu = useCallback(
    (target: ContextTarget, at: { x: number; y: number }) => {
      if (target.kind === 'background') {
        setMenu(null);
        return;
      }
      if (target.kind === 'badge' || target.kind === 'edge') {
        const edge = graph.edges.find(e => e.id === target.edgeId);
        if (!edge) return;
        const other = edge.target;
        setMenu({
          kind: 'flat',
          x: at.x,
          y: at.y,
          items: [
            {
              label: `Go to ${labelOf(other)}`,
              onClick: () => canvasRef.current?.centerOn(other),
            },
            {
              label: 'Show line',
              // Pinned rather than hovered: the pointer has to leave the block
              // to reach this menu, and a hover-only line would already be gone.
              onClick: () => setPinned(edge.source),
            },
            { separator: true, label: '', onClick: () => {} },
            {
              label: `Delete ${edge.slot ?? 'link'}`,
              danger: true,
              onClick: () => void handleUnlink(target.edgeId),
            },
            {
              label: 'Hide links',
              onClick: () => setPinned(null),
            },
          ],
        });
        return;
      }
      if (target.kind === 'idTag') {
        const rows = inboundRowsFor(target.blockKey);
        if (rows.length === 0) {
          setMenu({
            kind: 'flat',
            x: at.x,
            y: at.y,
            items: [
              { label: 'Nothing points here yet', onClick: () => {}, disabled: true },
              ...linkItemsFor(target.blockKey, 'id', at),
            ],
          });
        } else if (rows.length === 1) {
          // One link is a list of one; the flat menu says it faster.
          const only = rows[0];
          setMenu({
            kind: 'flat',
            x: at.x,
            y: at.y,
            items: [
              {
                label: `Go to ${only.sourceLabel}`,
                onClick: () => canvasRef.current?.centerOn(only.sourceKey),
              },
              { label: 'Show line', onClick: () => setPinned(only.sourceKey) },
              { separator: true, label: '', onClick: () => {} },
              {
                label: `Delete ${only.slot}`,
                danger: true,
                onClick: () => void handleUnlink(only.edgeId),
              },
              { separator: true, label: '', onClick: () => {} },
              ...linkItemsFor(target.blockKey, 'id', at),
            ],
          });
        } else {
          setMenu({
            kind: 'inbound',
            x: at.x,
            y: at.y,
            targetLabel: labelOf(target.blockKey),
            rows,
          });
        }
        return;
      }
      // A slot or the block itself: centring and pinning are always available;
      // the Add-link items arrive with #62d.
      setMenu({
        kind: 'flat',
        x: at.x,
        y: at.y,
        items: [
          ...linkItemsFor(target.blockKey, target.kind === 'slot' ? target.slot : undefined, at),
          { separator: true, label: '', onClick: () => {} },
          {
            label: 'Centre on this block',
            onClick: () => canvasRef.current?.centerOn(target.blockKey),
          },
          { label: 'Show links', onClick: () => setPinned(target.blockKey) },
        ],
      });
    },
    [graph, labelOf, inboundRowsFor, handleUnlink, linkItemsFor],
  );

  /** Deleting several refs one after another — each keeps its own undo. */
  const handleDeleteAll = useCallback(
    async (edgeIds: string[]) => {
      for (const edgeId of edgeIds) await handleUnlink(edgeId);
    },
    [handleUnlink],
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
      const result = await commitPlan(plan.plan);
      if (result.ok) setUnfiledRefresh(n => n + 1);
    },
    [graph, commitPlan],
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
          {(['unconnected', 'pair', 'unfiled', 'filing'] as const).map(t => (
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
                : t === 'pair'
                  ? 'Pair up'
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

        {leftTab === 'pair' ? (
          <PairingWorkbench
            graph={graph}
            busy={batchBusy}
            onChoose={row =>
              setPicker({
                sourceKey: row.key,
                slot: row.slot,
                side: 'output',
                rect: rectAt({ x: 340, y: 200 }),
              })
            }
            onApply={plans => void handleApplyBatch(plans)}
          />
        ) : leftTab === 'filing' && activeFiling ? (
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
            onContextMenu={handleContextMenu}
            menuOpen={menu !== null || picker !== null || pendingLink !== null}
            onReady={api => {
              canvasRef.current = api;
            }}
          />
        )}

        {menu?.kind === 'flat' && (
          <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
        )}
        {menu?.kind === 'inbound' && (
          <LinkPopup
            x={menu.x}
            y={menu.y}
            targetLabel={menu.targetLabel}
            rows={menu.rows}
            onGoTo={key => canvasRef.current?.centerOn(key)}
            onDelete={edgeId => void handleUnlink(edgeId)}
            onDeleteAll={edgeIds => void handleDeleteAll(edgeIds)}
            onClose={() => setMenu(null)}
          />
        )}

        {picker && (
          <LinkPicker
            graph={graph}
            sourceKey={picker.sourceKey}
            slot={picker.slot}
            side={picker.side}
            anchorRect={picker.rect}
            onPick={plan => void commitPlan(plan)}
            onClose={() => setPicker(null)}
          />
        )}

        {/* A link waiting for its second end. The pill is the only thing saying
            the canvas is in a state at all, so it also carries the way out. */}
        {pendingLink && (
          <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2">
            <div
              className="pointer-events-auto flex items-center gap-2 rounded-full border border-blue-300 bg-blue-50/95 px-3 py-1 text-[11px] text-blue-800 shadow-sm"
              data-pending-link="yes"
            >
              <span className="max-w-[280px] truncate">Linking from {pendingLink.label}</span>
              <span className="text-blue-400">right-click the target</span>
              <button
                onClick={() => setPendingLink(null)}
                className="rounded-full px-1.5 py-0.5 text-blue-700 hover:bg-blue-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Link visibility. Lives on the canvas rather than in a toolbar strip:
            the editor has no toolbar, and this is where the user meets the
            question — lines are hidden until a block is hovered. */}
        <div className="pointer-events-none absolute left-3 top-10">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAllLinks(!showAllLinks)}
              aria-pressed={showAllLinks}
              title="Show every link at once — refs and the case fan — instead of on hover"
              className={`pointer-events-auto rounded-full border px-2.5 py-1 text-[11px] shadow-sm ${
                showAllLinks
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-gray-300 bg-white/90 text-gray-600 hover:bg-gray-50'
              }`}
            >
              Show all links
            </button>
            {/* Only offered when there is something to hide: a pinned line
                stays put through clicks and Escape, so this is its way out. */}
            {pinnedKey && (
              <button
                onClick={() => setPinned(null)}
                data-hide-links="yes"
                title="Stop showing the pinned links"
                className="pointer-events-auto rounded-full border border-gray-300 bg-white/90 px-2.5 py-1 text-[11px] text-gray-600 shadow-sm hover:bg-gray-50"
              >
                Hide links
              </button>
            )}
          </div>
        </div>

        {/* Droplet, below the column header band. At top-3 it sat inside that
            band (measured: droplet top 94px, header bottom 107px), so panning a
            column under it put the two on top of each other. */}
        <div className="pointer-events-none absolute right-3 top-10 flex flex-col items-end gap-2">
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
