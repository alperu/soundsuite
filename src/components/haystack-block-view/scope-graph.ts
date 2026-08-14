import { BLOCK_FOOTER_H, BLOCK_TITLE_H, filingHeightFor, titleHeightFor } from './block-metrics';
import { visibleSlotsFor } from './link-rules';
import type {
  ScopeCase,
  ScopeFiling,
  ScopeRefs,
  ScopeSelection,
  UnconnectedRow,
} from './types';

/**
 * Domain layer for the Filtering canvas: turns the `/api/scope/graph` payload
 * into a positioned block graph plus the adjacency the cascade walks.
 *
 * Nothing in here imports rete — the canvas renders this model, and the
 * selection reducer reasons over it, but neither owns it.
 */

/** Block geometry. Layout math, socket positions and node styling all read
 *  these — a block that disagrees with the layout puts edges off the block. */
export const CASE_W = 260;
export const CASE_H = 96;
export const FILING_W = 320;
/**
 * The per-edge handle count every filing is sized for, whatever the data says:
 * the input hub plus the three slots the busiest kind writes (a ref slot,
 * amends, supersedes). Holding the floor here keeps the whole canvas from
 * re-laying-out when a commit adds or removes one handle somewhere — geometry
 * that moves under the user on every write is worse than geometry that is
 * slightly taller than it needs to be.
 */
const BASELINE_EDGE_MEMBERS = 4;
/**
 * The height a filing block gets when its handles ask for nothing unusual —
 * the floor, not the answer. `buildScopeGraph` sizes blocks to the tallest edge
 * stack in the graph (see `filingHeightOf`), because a block that is shorter
 * than its own handles stacks them on top of each other (#65).
 */
export const FILING_H = filingHeightFor(BASELINE_EDGE_MEMBERS);
export { BLOCK_TITLE_H, BLOCK_FOOTER_H };
export const ROW_GAP = 14;
export const ROW_H = FILING_H + ROW_GAP;
export const COL_GAP = 140;
export const CLUSTER_GAP = 56;
export const INDENT = 28;

/** Ref slots that make one filing a child of another. */
export const REF_SLOTS = [
  'respondingTo',
  'replyingTo',
  // Ahead of motionRef on purpose: an order can be filed under one motion and
  // rule on another, and `refTargetOf` takes the first slot that matches to
  // decide which filing a block nests under. Rules-on is the stronger claim.
  'resolves',
  'amends',
  'supersedes',
  'motionRef',
] as const;
export type RefSlot = (typeof REF_SLOTS)[number];

/**
 * Filings are laid out in kind columns, left to right in docket order: a motion
 * is filed, notices go out, responses answer it, replies answer those, an order
 * rules. Reading across a row therefore reads the life of one dispute.
 *
 * Records get their own column rather than falling into Other: they are 24 of
 * 82 filings today and would swamp it.
 */
export const KIND_COLUMNS = [
  'Motion',
  'Notice',
  'Response',
  'Reply',
  'Order',
  'Records',
  'Other',
] as const;
export type KindColumn = (typeof KIND_COLUMNS)[number];

export const KIND_COL_GAP = 64;
export const COL_PITCH = FILING_W + KIND_COL_GAP;
/** Where the first filing column starts — right of the case block's column. */
export const FILING_COL_X = CASE_W + COL_GAP;

export function columnX(index: number): number {
  return FILING_COL_X + index * COL_PITCH;
}

const ORDER_SHAPED = new Set(['order', 'proposedOrder', 'judgment', 'decree']);
const RECORD_KINDS = new Set(['reportersRecord', 'clerksRecord']);

/** Which column a filing's kind belongs in. Unknown kinds land in Other. */
export function columnForKind(primaryKind: string): number {
  const kind = (primaryKind || '').trim();
  if (kind === 'motion') return 0;
  if (kind === 'notice') return 1;
  if (kind === 'response') return 2;
  if (kind === 'reply') return 3;
  if (ORDER_SHAPED.has(kind)) return 4;
  if (RECORD_KINDS.has(kind)) return 5;
  return 6;
}

/** The unfiled pile sits past the last kind column. */
export const UNFILED_COLUMN = KIND_COLUMNS.length;

/** BFS budget for a ref cascade, mirroring the graph-expand cap. */
export const CASCADE_CAP = 50;

export type EntityKey = string; // 'case:<id>' | 'filing:<id>' | 'unfiled:<caseId>'

export const caseKey = (id: string): EntityKey => `case:${id}`;
export const filingKey = (id: string): EntityKey => `filing:${id}`;
/** One aggregate block per case for documents that hang off no filing. */
export const unfiledKey = (caseId: string): EntityKey => `unfiled:${caseId}`;

export interface CaseBlock {
  key: EntityKey;
  id: string;
  name: string;
  filingCount: number;
  indexedDocCount: number;
  docCount: number;
  unfiledDocCount: number;
  unfiledIndexedCount: number;
  x: number;
  y: number;
}

export interface FilingBlock {
  key: EntityKey;
  id: string;
  caseId: string;
  label: string;
  /** ISO filing date, null where the record has none. Docket order is a domain
   *  signal on this canvas — a response answers an EARLIER motion — so the
   *  picker and the suggester read the date itself, not just the sort it
   *  produced upstream. */
  filingDate: string | null;
  /** This block's own title-bar height: one to three lines of its name (#99).
   *  Every consumer that excludes the title band reads THIS, not the constant —
   *  a shared band height and a per-block title is the #77 bug again. */
  titleH: number;
  /** Total height, title included. Rows keep a uniform pitch (`rowH`), but a
   *  block is only as tall as it needs to be. */
  height: number;
  filingType: string;
  docCount: number;
  indexedCount: number;
  depth: number;
  /** The one kind this filing *is* — server-derived and never empty. Every
   *  "what is this?" question (sockets, link rules, commits) reads this. */
  primaryKind: string;
  /** Which tag rows physically exist at this id. Consult it only to know
   *  whether a row is materialised — `commitEntity` creates the missing one. */
  entityKinds: string[];
  /** What the worklist says this filing is still missing; empty when mapped. */
  missing: string[];
  /** The refs this filing already holds. A slot socket reads it to know whether
   *  drawing from it would replace an existing link rather than add one. */
  refs: ScopeRefs;
  x: number;
  y: number;
}

/** The per-case pile of documents no filing claims. Editor mode only. */
export interface UnfiledBlock {
  key: EntityKey;
  caseId: string;
  docCount: number;
  indexedCount: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  source: EntityKey;
  target: EntityKey;
  kind: 'contains' | 'ref';
  /** The socket the edge leaves from. Ref edges name their ref slot; the case
   *  edge names `caseRef`, which is a structural slot rather than a tag. */
  slot?: RefSlot | 'caseRef';
}

export interface ScopeGraph {
  cases: CaseBlock[];
  filings: FilingBlock[];
  /** Empty unless the graph was built with `unlinkedLane`. */
  unfiled: UnfiledBlock[];
  edges: GraphEdge[];
  /** entity key → block position/size, for the canvas socket watcher. */
  boxes: Map<EntityKey, { x: number; y: number; w: number; h: number }>;
  /** case key → its filing keys, in layout order. */
  childrenByCase: Map<EntityKey, EntityKey[]>;
  /** filing key → case key. */
  caseOfFiling: Map<EntityKey, EntityKey>;
  /** Undirected ref adjacency between filing keys. */
  refNeighbors: Map<EntityKey, EntityKey[]>;
  filingById: Map<string, FilingBlock>;
  caseById: Map<string, CaseBlock>;
  /** Block height for every filing in THIS graph — see `filingHeightOf`. */
  filingH: number;
  /** Row pitch that follows from it, so bands and family rows stay aligned. */
  rowH: number;
  /** Where each case's band sits, for the horizontal rules and their labels.
   *  Derived here rather than re-measured from block positions: the layout is
   *  the only thing that knows a band's height before the blocks are placed. */
  bands: Array<{ key: EntityKey; name: string; top: number; height: number }>;
}

/**
 * How tall the filings in this graph have to be.
 *
 * A block's handles all sit on one of two edges, and which edge is
 * direction-dependent, so the honest bound is "every handle on the same edge":
 * the input hub plus every visible slot except caseRef, which has a fixed home
 * on the left. Held-but-unwritable slots count too — they are rendered, so they
 * take a place in the stack.
 *
 * Uniform across the graph on purpose: rows keep a single pitch, which is what
 * family alignment between columns depends on.
 */
export function filingHeightOf(filings: readonly ScopeFiling[]): number {
  let members = BASELINE_EDGE_MEMBERS;
  for (const filing of filings) {
    const slots = visibleSlotsFor(filing.primaryKind ?? '', filing.refs).filter(
      slot => slot !== 'caseRef',
    );
    members = Math.max(members, slots.length + 1);
  }
  return filingHeightFor(members);
}

/**
 * The width a title wraps inside: the block, less its 1px border on each side,
 * its 10px left padding, and the 64px gutter the right-edge slot labels render
 * into. The block's `border px-2.5 pr-16` is where the other copy of those
 * numbers lives.
 *
 * The border matters. Measured against every real title, 246 (border ignored)
 * under-reserved two of them and 244 under-reserved none — one pixel of slack
 * either side is the difference between a name shown in full and a name cut off.
 */
const TITLE_TEXT_W = FILING_W - 2 - 10 - 64;

/** This filing's title bar, one to three lines depending on its name (#99). */
export function titleHeightOf(label: string): number {
  return titleHeightFor(label, TITLE_TEXT_W);
}

function refTargetOf(filing: ScopeFiling): { id: string; slot: RefSlot } | null {
  for (const slot of REF_SLOTS) {
    const value = filing.refs?.[slot];
    if (typeof value === 'string' && value) return { id: value, slot };
  }
  return null;
}

/**
 * Order a case's filings so that a filing pointing at another filing in the
 * same case sits directly under its target, indented one level. Filings whose
 * ref points outside the payload (or nowhere) are roots in payload order.
 */
function orderFilings(filings: ScopeFiling[]): { filing: ScopeFiling; depth: number }[] {
  const present = new Set(filings.map(f => f.id));
  const childrenOf = new Map<string, ScopeFiling[]>();
  const roots: ScopeFiling[] = [];

  for (const filing of filings) {
    const ref = refTargetOf(filing);
    if (ref && ref.id !== filing.id && present.has(ref.id)) {
      const bucket = childrenOf.get(ref.id);
      if (bucket) bucket.push(filing);
      else childrenOf.set(ref.id, [filing]);
    } else {
      roots.push(filing);
    }
  }

  const ordered: { filing: ScopeFiling; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (filing: ScopeFiling, depth: number) => {
    if (seen.has(filing.id)) return;
    seen.add(filing.id);
    ordered.push({ filing, depth });
    for (const child of childrenOf.get(filing.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // Cycles among refs would strand their members; append them flat.
  for (const filing of filings) walk(filing, 0);
  return ordered;
}

interface Cell {
  column: number;
  row: number;
}

interface Placement {
  byFiling: Map<string, Cell>;
  /** Rows in the fullest column — the band's height in rows. */
  rowCount: number;
}

/**
 * Assign every filing in a case a column (by kind) and a row.
 *
 * The row is where the reading happens: a filing that references a motion takes
 * that motion's row when its own column has it free, so a motion and everything
 * answering it line up horizontally and their edges become short straight runs
 * instead of long diagonals. Filings with no such family fill the next free row
 * in their column.
 */
function placeFilingsInColumns(filings: ScopeFiling[]): Placement {
  const byFiling = new Map<string, Cell>();
  const taken: Array<Set<number>> = Array.from(
    { length: KIND_COLUMNS.length + 1 },
    () => new Set<number>(),
  );
  const nextFree = (column: number, from = 0): number => {
    let row = from;
    while (taken[column].has(row)) row += 1;
    return row;
  };
  const claim = (id: string, column: number, row: number) => {
    taken[column].add(row);
    byFiling.set(id, { column, row });
  };

  const present = new Set(filings.map(f => f.id));
  // Motions anchor their families, so they are placed first and everything
  // else aligns to them.
  const motions = filings.filter(f => columnForKind(f.primaryKind ?? '') === 0);
  for (const motion of motions) {
    claim(motion.id, 0, nextFree(0));
  }

  for (const filing of filings) {
    if (byFiling.has(filing.id)) continue;
    const column = columnForKind(filing.primaryKind ?? '');
    // The ref that says which family this filing belongs to.
    const anchorId = REF_SLOTS.map(slot => filing.refs?.[slot]).find(
      (value): value is string => typeof value === 'string' && present.has(value),
    );
    const anchorRow = anchorId ? byFiling.get(anchorId)?.row : undefined;
    const row =
      anchorRow !== undefined && !taken[column].has(anchorRow)
        ? anchorRow
        : nextFree(column, anchorRow ?? 0);
    claim(filing.id, column, row);
  }

  let rowCount = 0;
  for (const rows of taken) {
    for (const row of rows) rowCount = Math.max(rowCount, row + 1);
  }
  return { byFiling, rowCount };
}

export interface BuildOptions {
  /** Worklist rows — they badge their filing block with what's still missing. */
  unconnected?: UnconnectedRow[];
  /** Editor mode: add the unfiled-documents lane in a third column. */
  unlinkedLane?: boolean;
}

/** Build the positioned graph. Pure: same payload in, same layout out. */
export function buildScopeGraph(cases: ScopeCase[], options: BuildOptions = {}): ScopeGraph {
  // Every unconnected worklist row today resolves to a filing that already has
  // a block, so the lane badges blocks rather than inventing orphan ones.
  const missingByEntity = new Map<string, string[]>();
  for (const row of options.unconnected ?? []) {
    const bucket = missingByEntity.get(row.entityId) ?? [];
    for (const item of row.missing) if (!bucket.includes(item)) bucket.push(item);
    missingByEntity.set(row.entityId, bucket);
  }

  const graph: ScopeGraph = {
    cases: [],
    filings: [],
    unfiled: [],
    edges: [],
    boxes: new Map(),
    childrenByCase: new Map(),
    caseOfFiling: new Map(),
    refNeighbors: new Map(),
    filingById: new Map(),
    caseById: new Map(),
    filingH: 0,
    rowH: 0,
    bands: [],
  };
  // The body and footer are uniform (handles and chips); only the title varies.
  const bodyAndFooterH = filingHeightOf(cases.flatMap(c => c.filings)) - BLOCK_TITLE_H;
  // Rows keep ONE pitch — family alignment across columns depends on it — so
  // the pitch follows the tallest title in the graph even though each block is
  // drawn only as tall as its own name needs.
  const tallestTitle = cases
    .flatMap(c => c.filings)
    .reduce((tallest, f) => Math.max(tallest, titleHeightOf(f.label)), BLOCK_TITLE_H);
  graph.filingH = bodyAndFooterH + tallestTitle;
  graph.rowH = graph.filingH + ROW_GAP;

  let clusterTop = 0;

  const laneCol = columnX(UNFILED_COLUMN);

  for (const c of cases) {
    const ordered = orderFilings(c.filings);
    // Place every filing in its kind's column, then let each column stack its
    // own rows. A band is as tall as its fullest column, not as its filing
    // count — that is the whole point of columns.
    const placement = placeFilingsInColumns(ordered.map(o => o.filing));
    const laneRows = options.unlinkedLane && c.unfiledDocCount > 0 ? 1 : 0;
    const clusterHeight = Math.max(
      CASE_H,
      placement.rowCount * graph.rowH,
      laneRows * graph.rowH,
    );

    const indexedDocCount =
      c.filings.reduce((sum, f) => sum + f.indexedCount, 0) + c.unfiledIndexedCount;
    const docCount =
      c.filings.reduce((sum, f) => sum + f.docCount, 0) + c.unfiledDocCount;

    const cBlock: CaseBlock = {
      key: caseKey(c.id),
      id: c.id,
      name: c.name,
      filingCount: c.filings.length,
      indexedDocCount,
      docCount,
      unfiledDocCount: c.unfiledDocCount,
      unfiledIndexedCount: c.unfiledIndexedCount,
      x: 0,
      y: clusterTop + Math.max(0, (clusterHeight - CASE_H) / 2),
    };
    graph.cases.push(cBlock);
    graph.caseById.set(c.id, cBlock);
    graph.boxes.set(cBlock.key, { x: cBlock.x, y: cBlock.y, w: CASE_W, h: CASE_H });

    const childKeys: EntityKey[] = [];
    ordered.forEach(({ filing, depth }) => {
      const cell = placement.byFiling.get(filing.id) ?? { column: 6, row: 0 };
      const fBlock: FilingBlock = {
        key: filingKey(filing.id),
        id: filing.id,
        caseId: c.id,
        label: filing.label,
        titleH: titleHeightOf(filing.label),
        height: bodyAndFooterH + titleHeightOf(filing.label),
        filingDate: filing.filingDate ?? null,
        filingType: filing.filingType,
        docCount: filing.docCount,
        indexedCount: filing.indexedCount,
        depth,
        primaryKind: filing.primaryKind ?? 'motion',
        entityKinds: filing.entityKinds ?? [],
        missing: missingByEntity.get(filing.id) ?? [],
        refs: filing.refs ?? {},
        // `depth` is kept for the ref-nesting order it still encodes, but no
        // longer indents x: a filing's column is its kind, full stop.
        x: columnX(cell.column),
        y: clusterTop + cell.row * graph.rowH,
      };
      graph.filings.push(fBlock);
      graph.filingById.set(filing.id, fBlock);
      graph.boxes.set(fBlock.key, { x: fBlock.x, y: fBlock.y, w: FILING_W, h: fBlock.height });
      graph.caseOfFiling.set(fBlock.key, cBlock.key);
      childKeys.push(fBlock.key);
      // Drawn filing → case, matching the gesture: the filing's caseRef socket
      // points at the case's id. The edge still means containment; only the
      // direction it is authored from changed.
      graph.edges.push({
        id: `contains:${c.id}:${filing.id}`,
        source: fBlock.key,
        target: cBlock.key,
        kind: 'contains',
        slot: 'caseRef',
      });
    });
    graph.childrenByCase.set(cBlock.key, childKeys);

    if (laneRows > 0) {
      const uBlock: UnfiledBlock = {
        key: unfiledKey(c.id),
        caseId: c.id,
        docCount: c.unfiledDocCount,
        indexedCount: c.unfiledIndexedCount,
        x: laneCol,
        y: clusterTop,
      };
      graph.unfiled.push(uBlock);
      graph.boxes.set(uBlock.key, { x: uBlock.x, y: uBlock.y, w: FILING_W, h: graph.filingH });
      graph.edges.push({
        id: `unfiled:${c.id}`,
        source: cBlock.key,
        target: uBlock.key,
        kind: 'contains',
      });
    }

    graph.bands.push({
      key: cBlock.key,
      name: c.name,
      top: clusterTop,
      height: clusterHeight,
    });
    clusterTop += clusterHeight + CLUSTER_GAP;
  }

  // Ref edges, once every block exists (refs may cross cases).
  const addNeighbor = (a: EntityKey, b: EntityKey) => {
    const bucket = graph.refNeighbors.get(a);
    if (bucket) {
      if (!bucket.includes(b)) bucket.push(b);
    } else {
      graph.refNeighbors.set(a, [b]);
    }
  };

  for (const c of cases) {
    for (const filing of c.filings) {
      for (const slot of REF_SLOTS) {
        const targetId = filing.refs?.[slot];
        if (typeof targetId !== 'string' || !targetId || targetId === filing.id) continue;
        if (!graph.filingById.has(targetId)) continue;
        const source = filingKey(filing.id);
        const target = filingKey(targetId);
        graph.edges.push({ id: `${slot}:${filing.id}:${targetId}`, source, target, kind: 'ref', slot });
        addNeighbor(source, target);
        addNeighbor(target, source);
      }
    }
  }

  return graph;
}

/** Ref-connected filings reachable from `start`, capped. Symmetric walk. */
export function refCascade(graph: ScopeGraph, start: EntityKey): EntityKey[] {
  const out: EntityKey[] = [start];
  const seen = new Set<EntityKey>([start]);
  const queue: EntityKey[] = [start];
  while (queue.length > 0 && out.length < CASCADE_CAP) {
    const current = queue.shift() as EntityKey;
    for (const next of graph.refNeighbors.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      out.push(next);
      queue.push(next);
      if (out.length >= CASCADE_CAP) break;
    }
  }
  return out;
}

export type TriState = 'all' | 'some' | 'none';

export function caseTriState(
  graph: ScopeGraph,
  selected: Set<EntityKey>,
  key: EntityKey,
): TriState {
  const children = graph.childrenByCase.get(key) ?? [];
  if (children.length === 0) return selected.has(key) ? 'all' : 'none';
  let hits = 0;
  for (const child of children) if (selected.has(child)) hits += 1;
  if (hits === 0) return selected.has(key) ? 'some' : 'none';
  return hits === children.length ? 'all' : 'some';
}

export interface ScopeTotals {
  cases: number;
  filings: number;
  indexedDocs: number;
}

/** Live counter + the payload persisted as `search.scopeSet`. */
export function compileSelection(
  graph: ScopeGraph,
  selected: Set<EntityKey>,
): { selection: ScopeSelection; totals: ScopeTotals } {
  const caseIds: string[] = [];
  const filingIds: string[] = [];
  let filings = 0;
  let indexedDocs = 0;
  let casesTouched = 0;

  for (const c of graph.cases) {
    const state = caseTriState(graph, selected, c.key);
    if (state === 'none') continue;
    casesTouched += 1;
    const children = graph.childrenByCase.get(c.key) ?? [];
    const selectedChildren = children.filter(child => selected.has(child));
    filings += selectedChildren.length;

    if (state === 'all') {
      // Whole case in scope — this also pulls the case's unfiled documents in,
      // which have no block of their own on the canvas.
      caseIds.push(c.id);
      indexedDocs += c.indexedDocCount;
    } else {
      for (const child of selectedChildren) {
        const block = graph.filingById.get(child.slice('filing:'.length));
        if (!block) continue;
        filingIds.push(block.id);
        indexedDocs += block.indexedCount;
      }
    }
  }

  return {
    selection: { caseIds, filingIds },
    totals: { cases: casesTouched, filings, indexedDocs },
  };
}
