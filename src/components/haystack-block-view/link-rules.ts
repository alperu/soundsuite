import { commit as hsCommit, firstRow, gridHasError } from '@/lib/haystack-client';
import { BLOCK_TITLE_H, FILING_H } from './scope-graph';
import type { FilingBlock, ScopeGraph } from './scope-graph';

/**
 * Block programming rules: which drawn connection means which ref slot, and
 * how that ref reaches the database.
 *
 * A drawn edge is a proposal. It is validated here, written through the same
 * `commit` the tag panel uses, and only becomes visible once the refetch
 * re-derives the graph — the canvas never holds an edge the data doesn't have.
 */

export type LinkSlot =
  | 'respondingTo'
  | 'replyingTo'
  | 'resolves'
  | 'motionRef'
  | 'amends'
  | 'supersedes'
  /** Inverted: drawn from a motion, but written on the ORDER as `resolves`.
   *  A motion never stores this — it is derived from the orders pointing at it. */
  | 'orderRef'
  /** Structural: the filing's case. Writes the `caseId` COLUMN rather than a
   *  tag, and drawing it again MOVES the filing to another case. */
  | 'caseRef';

/** Filing kinds that rule on a motion — they write `resolves`, not the generic
 *  `motionRef` parentage. Mirrors ORDER_SHAPED_KINDS in `@/lib/haystack/refs`
 *  (duplicated rather than imported: that module is server-only). */
const ORDER_SHAPED_KINDS = new Set(['order', 'proposedOrder', 'judgment', 'decree']);

/** Every slot a block keeps a port for. A filing gets all of them even when its
 *  kind writes only one, because historical data can hold a ref in a slot the
 *  kind no longer offers — an order-shaped filing carrying an older `motionRef`
 *  still has to be able to draw that edge. */
export const ALL_SLOTS: readonly LinkSlot[] = [
  'respondingTo',
  'replyingTo',
  'resolves',
  'motionRef',
  'amends',
  'supersedes',
  'orderRef',
  'caseRef',
];

/** Slots describing structure rather than argument. They are never reached by
 *  the unslotted fallback — the user pulls their socket deliberately. */
const STRUCTURAL_SLOTS = new Set<LinkSlot>(['orderRef', 'caseRef']);

/** Which edge a slot's socket lives on. caseRef faces the case column on the
 *  left; a right-edge socket would route its edge the long way round. */
export function slotEdge(slot: LinkSlot): 'left' | 'right' {
  return slot === 'caseRef' ? 'left' : 'right';
}

/**
 * Which edge a socket sits on, given where its edge is headed.
 *
 * Kind columns put filings in docket order, so refs point LEFTWARD: a response
 * in column 2 references a motion in column 0. Leaving that from the right edge
 * sends the wire out right, back across the whole block and away to the left —
 * a lasso. Facing the target keeps the run short and readable.
 *
 * The block and the position watcher both call this. The last time those two
 * did their own anchor arithmetic (#46) the circles and the edge endpoints
 * drifted apart, so it stays one function.
 */
export function anchorSideFor(params: {
  slot: string;
  side: 'input' | 'output';
  /** Left edge of the block this socket belongs to. */
  sourceX: number;
  /** Left edge of the block at the far end, when the edge exists. */
  targetX?: number;
}): 'left' | 'right' {
  const { slot, side, sourceX, targetX } = params;
  // Structural sockets have fixed homes: a filing's caseRef faces the case
  // column on its left, a case's id tag sits on its right.
  if (slot === 'caseRef') return 'left';
  if (slot === 'contains') return 'right';
  // Nothing drawn yet — a drag can go anywhere, so keep the default rather
  // than guessing a direction.
  if (targetX === undefined) return 'right';
  if (side === 'output') return targetX < sourceX ? 'left' : 'right';
  // The receiving end mirrors it: an edge arriving from the right lands on the
  // right edge.
  return targetX > sourceX ? 'right' : 'left';
}

interface SlotSpec {
  /** What the socket is called on screen — the tag name, deliberately. */
  label: string;
  /** Verb for the banner: "responds to", "rules on". */
  description: string;
  /** Kinds this slot may point at. */
  accepts: (targetKind: string) => boolean;
  /** Shown when the drop lands somewhere this slot cannot reference. */
  refusal: string;
  /**
   * The gesture runs one way and the write lands the other. A motion is drawn
   * to the order that rules on it, but a motion stores nothing — the ORDER
   * holds `resolves`. `planLink` therefore takes the commit row from the
   * target, and the edge appears on the order's right edge after the refetch.
   */
  invert?: true;
  /** The slot actually written when `invert` is set. */
  commitSlot?: LinkSlot;
}

const SLOT_SPECS: Record<LinkSlot, SlotSpec> = {
  respondingTo: {
    label: 'respondingTo',
    description: 'responds to',
    accepts: kind => kind === 'motion',
    refusal: 'respondingTo points at a motion',
  },
  replyingTo: {
    label: 'replyingTo',
    description: 'replies to',
    accepts: kind => kind === 'response' || kind === 'motion',
    refusal: 'replyingTo points at a response or a motion',
  },
  resolves: {
    label: 'resolves',
    description: 'rules on',
    accepts: kind => kind === 'motion',
    refusal: 'resolves points at the motion being ruled on',
  },
  motionRef: {
    label: 'motionRef',
    description: 'belongs to',
    accepts: kind => kind === 'motion',
    refusal: 'motionRef points at the parent motion',
  },
  // A filing amends or supersedes another filing of its own kind — an amended
  // motion amends a motion, a supplemental response supersedes a response.
  // The check is made against the source kind by `planLink`, which is why
  // these accept everything here.
  amends: {
    label: 'amends',
    description: 'amends',
    accepts: () => true,
    refusal: 'amends points at an earlier filing of the same kind',
  },
  supersedes: {
    label: 'supersedes',
    description: 'supersedes',
    accepts: () => true,
    refusal: 'supersedes points at an earlier filing of the same kind',
  },
  orderRef: {
    label: 'orderRef',
    description: 'is ruled on by',
    accepts: kind => ORDER_SHAPED_KINDS.has(kind),
    refusal: 'orderRef points at an order, judgment or decree',
    invert: true,
    commitSlot: 'resolves',
  },
  caseRef: {
    label: 'caseRef',
    description: 'belongs to case',
    // Handled ahead of the generic path: the target is a case block, not a
    // filing, and the write goes to a column rather than a tag.
    accepts: kind => kind === 'case',
    refusal: "caseRef points at a case block's id",
  },
};

/** Slots whose target must match the source's own kind. */
const SAME_KIND_SLOTS = new Set<LinkSlot>(['amends', 'supersedes']);

export function slotLabel(slot: LinkSlot): string {
  return SLOT_SPECS[slot].label;
}

/**
 * The writable ref slots a kind offers — the one source the sockets, the
 * drag-time veto and the commit all read, so none of them can disagree. A
 * motion is the root of every chain and writes nothing outward.
 */
export function slotsForKind(kind: string): LinkSlot[] {
  // Any filing can supersede or amend an earlier one of its own kind, so those
  // two travel with every kind — including a motion, which writes nothing else.
  const revision: LinkSlot[] = ['amends', 'supersedes'];
  // Every filing belongs to a case, so caseRef travels with every kind — as
  // the LAST entry. Structural slots (caseRef) and inverted ones (orderRef)
  // must never be what the unslotted fallback picks, since the fallback takes
  // the first writable slot; the explicit-pick guard in `planLink` backs this up.
  if (kind === 'response') return ['respondingTo', ...revision, 'caseRef'];
  if (kind === 'reply') return ['replyingTo', ...revision, 'caseRef'];
  if (ORDER_SHAPED_KINDS.has(kind)) return ['resolves', ...revision, 'caseRef'];
  if (kind === 'motion') return [...revision, 'orderRef', 'caseRef'];
  return ['motionRef', ...revision, 'caseRef'];
}

export function isLinkSlot(key: string): key is LinkSlot {
  return (ALL_SLOTS as readonly string[]).includes(key);
}

/** Left-edge anchors: the case edge lands on the caseRef marker, so the ref
 *  hub sits above it rather than sharing a point with it. */
export const LEFT_ANCHORS = { in: 0.25, caseRef: 0.5 } as const;

/**
 * Where a socket sits on its edge, as a fraction of block height. The block
 * and the canvas's position watcher both call this — when each did its own
 * arithmetic, an edge could anchor to a circle that had since moved.
 */
export function slotAnchorRatio(
  side: 'input' | 'output',
  key: string,
  visibleSlots: readonly LinkSlot[],
): number {
  if (side === 'input') {
    return inBody(key === 'caseRef' ? LEFT_ANCHORS.caseRef : LEFT_ANCHORS.in);
  }
  const index = visibleSlots.indexOf(key as LinkSlot);
  if (index < 0) return inBody(0.5);
  return inBody(visibleSlots.length <= 1 ? 0.5 : (index + 1) / (visibleSlots.length + 1));
}

/**
 * Sockets belong in the block's BODY, under the title bar. Spread over the full
 * height, the first slot landed inside the title and sat on the filing's name.
 * The title's share is excluded here — in the one helper the block and the
 * position watcher both read, so they cannot disagree about where a circle is.
 */
function inBody(ratio: number): number {
  const bodyStart = BLOCK_TITLE_H / FILING_H;
  return bodyStart + ratio * (1 - bodyStart);
}

/**
 * The kind a block speaks for, normalised. `primaryKind ?? 'motion'` only
 * catches null and undefined; an empty string sailed through and made a
 * block's slot list disagree with the canvas's.
 */
export function normalizeKind(kind: string | null | undefined): string {
  return kind && kind.trim() ? kind : 'motion';
}

/**
 * The slots a block shows: what its kind can write, plus any slot that already
 * holds a ref. The second half matters more than it looks — an order-shaped
 * filing carrying an older `motionRef` needs that socket rendered, both so the
 * edge is honest about where it leaves from and so the link can be undone.
 * rete's ClassicFlow refuses to grab an edge whose source socket isn't
 * rendered, which is exactly the unlink gesture.
 */
export function visibleSlotsFor(
  kind: string,
  refs: Record<string, unknown> | undefined,
): LinkSlot[] {
  const writable = slotsForKind(normalizeKind(kind));
  const held = ALL_SLOTS.filter(
    slot =>
      // `orderRef` is never stored on anything — it is derived from the orders
      // pointing back — so a held-slot scan must not resurrect it.
      slot !== 'orderRef' &&
      !writable.includes(slot) &&
      typeof refs?.[slot] === 'string' &&
      refs[slot],
  );
  return [...writable, ...held];
}

export interface RefLinkPlan {
  type: 'ref';
  slot: LinkSlot;
  /** The tag row that owns the slot — `motion` or an attachment kind. */
  kind: string;
  /** Entity id to patch (equal to the source filing's id). */
  id: string;
  targetId: string;
  description: string;
  /** Set when the slot already held a different ref — this write replaces it. */
  replaces?: string;
  /** The write landed on the block the user dragged TO, not the one they
   *  dragged from (inverted slots). The banner says so, because the edge shows
   *  up on the other block's edge after the refetch. */
  wroteOnTarget?: true;
}

/**
 * Filing a loose document. `Document.caseId` is fixed at ingestion — a document
 * is never linked to a case by hand — so the only writable link is `filingId`,
 * and it goes through the documents route rather than Haystack.
 */
export interface FileDocumentPlan {
  type: 'file-document';
  documentId: string;
  filingId: string;
  description: string;
}

/**
 * Moving a filing between cases. `Filing.caseId` is a column, unreachable
 * through haystack commit (there is no `filing` kind in the model map), and a
 * change has to cascade to the entity rows and the filing's documents. One
 * call to `PATCH /api/cases/[id]/filings/[filingId]` owns all of that — the
 * canvas never orchestrates a multi-endpoint write.
 */
export interface MoveFilingPlan {
  type: 'move-filing';
  filingId: string;
  fromCaseId: string;
  toCaseId: string;
  /** Rows that must agree on the new case — the server patches them. */
  entityKinds: string[];
  description: string;
  /** True when the filing already belonged to another case: this is a move. */
  moves: boolean;
}

export type LinkPlan = RefLinkPlan | FileDocumentPlan | MoveFilingPlan;

/**
 * Live since the filings route began cascading a caseId change transactionally
 * — Filing + Motion rows, MotionEvents, attachments and records, and the
 * filing's attached documents. It stayed dark until then so a half-move was
 * never possible from the canvas.
 */
export const MOVE_FILING_ENABLED = true;

/**
 * What a filing is, and therefore which row a ref write lands on. The server
 * derives this once; a filing with no tag row yet still reports its real kind,
 * and `commitEntity` materialises the matching row on first save.
 */
function commitKind(block: FilingBlock): string {
  return block.primaryKind;
}

/** Already the normalised camelCase kind — lowercasing it would break e.g.
 *  `proposedOrder`. */
function normalizedKind(block: FilingBlock): string {
  return block.primaryKind;
}

/** Prose form for a refusal message; kinds are camelCase on the wire. */
function kindLabel(kind: string): string {
  return kind
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

/**
 * Decide what a source → target drag means. Returns a reason string when the
 * pair isn't a relationship this canvas knows how to write.
 */
export function planLink(
  graph: ScopeGraph,
  sourceKey: string,
  targetKey: string,
  /** The output socket the drag came from. Omitted (panel drags, callers that
   *  only know the pair) falls back to the kind's single writable slot. */
  pickedSlot?: string,
): { ok: true; plan: LinkPlan } | { ok: false; reason: string } {
  if (sourceKey === targetKey) return { ok: false, reason: 'A filing cannot reference itself' };

  if (sourceKey.startsWith('document:')) {
    const documentId = sourceKey.slice('document:'.length);
    const filing = graph.filingById.get(targetKey.replace(/^filing:/, ''));
    if (!targetKey.startsWith('filing:') || !filing) {
      return { ok: false, reason: 'Drop a document onto a filing — its case is already fixed' };
    }
    return {
      ok: true,
      plan: { type: 'file-document', documentId, filingId: filing.id, description: 'filed under' },
    };
  }

  const source = graph.filingById.get(sourceKey.replace(/^filing:/, ''));
  if (!sourceKey.startsWith('filing:') || !source) {
    return { ok: false, reason: 'Only a filing block can start a link' };
  }

  // caseRef is the one slot that ends on a case block, and the one whose write
  // is a column rather than a tag. It is handled before the ref machinery
  // because none of that machinery applies.
  if (targetKey.startsWith('case:')) {
    if (pickedSlot !== 'caseRef') {
      return { ok: false, reason: "Pull the caseRef socket to change a filing's case" };
    }
    const toCaseId = targetKey.slice('case:'.length);
    if (!graph.caseById.has(toCaseId)) {
      return { ok: false, reason: 'That case is not on the canvas' };
    }
    if (source.caseId === toCaseId) {
      return { ok: false, reason: 'This filing is already in that case' };
    }
    return {
      ok: true,
      plan: {
        type: 'move-filing',
        filingId: source.id,
        fromCaseId: source.caseId,
        toCaseId,
        entityKinds: source.entityKinds.length > 0 ? source.entityKinds : [source.primaryKind],
        description: 'moves to case',
        moves: true,
      },
    };
  }

  const target = graph.filingById.get(targetKey.replace(/^filing:/, ''));
  if (!targetKey.startsWith('filing:') || !target) {
    return { ok: false, reason: 'A link has to end on a filing block' };
  }
  if (pickedSlot === 'caseRef') {
    return { ok: false, reason: "caseRef points at a case block's id" };
  }

  const from = normalizedKind(source);
  const to = normalizedKind(target);

  const writable = slotsForKind(from);
  if (writable.length === 0) {
    return {
      ok: false,
      reason: `A ${kindLabel(from) || 'filing'} is the root of a chain — link the other filing to it instead`,
    };
  }

  // The socket the user pulled from decides the relationship. Without one
  // (a panel drag) the kind's single writable slot is the only candidate.
  const picked = pickedSlot && isLinkSlot(pickedSlot) && writable.includes(pickedSlot)
    ? pickedSlot
    : null;
  // Structural slots (caseRef) and inverted ones (orderRef) never come from the
  // fallback: one writes a column, the other writes on the OTHER block, and
  // neither should be what an unaimed drag happens to mean.
  const fallback = writable.find(s => !STRUCTURAL_SLOTS.has(s)) ?? writable[0];
  const slot = picked ?? fallback;
  const spec = SLOT_SPECS[slot];
  if (STRUCTURAL_SLOTS.has(slot) && !picked) {
    return { ok: false, reason: `Pull the ${slot} socket to record that link` };
  }

  if (SAME_KIND_SLOTS.has(slot)) {
    if (to !== from) {
      return { ok: false, reason: `${slot} points at another ${kindLabel(from)}` };
    }
  } else if (!spec.accepts(to)) {
    return { ok: false, reason: spec.refusal };
  }

  // Inverted slots commit on the target: motion → order writes `resolves` on
  // the ORDER, pointing back at the motion. Everything downstream — the write,
  // the unlink, the edge that appears after the refetch — belongs to the order.
  const writeOn = spec.invert ? target : source;
  const writeSlot = spec.commitSlot ?? slot;
  const pointsAt = spec.invert ? source : target;

  const current = writeOn.refs?.[writeSlot];
  if (typeof current === 'string' && current === pointsAt.id) {
    return { ok: false, reason: `${writeSlot} already points there` };
  }

  return {
    ok: true,
    plan: {
      type: 'ref',
      slot: writeSlot,
      kind: commitKind(writeOn),
      id: writeOn.id,
      targetId: pointsAt.id,
      // A singular slot that already holds a value is replaced, not appended.
      description: typeof current === 'string' && current ? 'replaces' : spec.description,
      replaces: typeof current === 'string' && current ? current : undefined,
      // The banner has to name where it landed: the user drew from the motion
      // but the row that changed is the order's.
      wroteOnTarget: spec.invert ? true : undefined,
    },
  };
}

/**
 * Write the ref. Announces `entity-updated` on success so the shell refetches
 * and every mounted view re-derives from the new data.
 */
export async function commitLink(plan: LinkPlan): Promise<{ ok: boolean; message: string }> {
  if (plan.type === 'file-document') return fileDocument(plan);
  if (plan.type === 'move-filing') return moveFiling(plan);
  try {
    const grid = await hsCommit({
      id: plan.id,
      kind: plan.kind,
      patch: { [plan.slot]: plan.targetId },
    });
    const error = gridHasError(grid);
    if (error) return { ok: false, message: `Link failed: ${error}` };
    if (!firstRow(grid)) return { ok: false, message: 'Link failed: no row returned' };

    window.dispatchEvent(
      new CustomEvent('entity-updated', { detail: { kind: plan.kind, id: plan.id } }),
    );
    return {
      ok: true,
      message: plan.wroteOnTarget
        ? `Linked — saved on the order as ${plan.slot}`
        : plan.replaces
          ? `Linked — ${plan.slot} replaced`
          : `Linked — ${plan.slot} saved`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Link failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/**
 * Clear a ref. The same commit path as writing one, with the slot set to null —
 * `previousTargetId` comes back so the caller can offer an undo.
 */
export async function unlinkRef(params: {
  kind: string;
  id: string;
  slot: LinkSlot;
  previousTargetId: string;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const grid = await hsCommit({
      id: params.id,
      kind: params.kind,
      patch: { [params.slot]: null },
    });
    const error = gridHasError(grid);
    if (error) return { ok: false, message: `Unlink failed: ${error}` };

    window.dispatchEvent(
      new CustomEvent('entity-updated', { detail: { kind: params.kind, id: params.id } }),
    );
    return { ok: true, message: `Unlinked — ${params.slot} cleared` };
  } catch (err) {
    return {
      ok: false,
      message: `Unlink failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/** Put a cleared ref back — the undo half of `unlinkRef`. */
export async function relinkRef(params: {
  kind: string;
  id: string;
  slot: LinkSlot;
  targetId: string;
}): Promise<{ ok: boolean; message: string }> {
  return commitLink({
    type: 'ref',
    slot: params.slot,
    kind: params.kind,
    id: params.id,
    targetId: params.targetId,
    description: 'restores',
  });
}

/**
 * Move a filing to another case. One call: the filings route owns the cascade
 * to entity rows and attached documents, which is why this does not stitch
 * several endpoints together from the browser.
 */
async function moveFiling(plan: MoveFilingPlan): Promise<{ ok: boolean; message: string }> {
  if (!MOVE_FILING_ENABLED) {
    return {
      ok: false,
      message: 'Moving a filing between cases is not enabled yet — the server cascade is pending',
    };
  }
  try {
    // The URL carries the SOURCE case (that is how the route resolves the
    // filing); the body carries the destination. The server owns the cascade.
    const res = await fetch(`/api/cases/${plan.fromCaseId}/filings/${plan.filingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caseId: plan.toCaseId }),
    });
    const body = (await res.json().catch(() => null)) as
      | {
          error?: string;
          moved?: { from: string; to: string };
          chunkRestamp?: 'ok' | 'failed' | 'skipped';
        }
      | null;
    if (!res.ok) {
      return { ok: false, message: `Move failed: ${body?.error ?? res.status}` };
    }
    // Both cases' contents changed, so the whole graph refetches.
    window.dispatchEvent(
      new CustomEvent('entity-updated', { detail: { kind: 'filing', id: plan.filingId } }),
    );
    // The restamp runs fire-and-forget after the move commits, so a failure
    // leaves the SQL side correct and the vector side stale — searches would
    // still scope those chunks to the OLD case. That is worth saying out loud;
    // 'ok' and 'skipped' (nothing indexed) need no commentary.
    if (body?.chunkRestamp === 'failed') {
      return {
        ok: true,
        message:
          'Filing moved, but its indexed chunks still carry the old case — see server logs',
      };
    }
    return {
      ok: true,
      message: body?.moved
        ? 'Filing moved — its cluster on the canvas has changed'
        : 'Filing moved',
    };
  } catch (err) {
    return {
      ok: false,
      message: `Move failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/** Send a document back to the unfiled pile — the reverse of `fileDocument`. */
export async function unfileDocument(
  documentId: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`/api/documents/${documentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filingId: null }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, message: `Unfile failed: ${body?.error ?? res.status}` };
    }
    window.dispatchEvent(
      new CustomEvent('entity-updated', { detail: { kind: 'document', id: documentId } }),
    );
    return { ok: true, message: 'Document moved back to unfiled' };
  } catch (err) {
    return {
      ok: false,
      message: `Unfile failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/** `PATCH /api/documents/[id]` owns `filingId`; Haystack has no document kind. */
async function fileDocument(plan: FileDocumentPlan): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`/api/documents/${plan.documentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filingId: plan.filingId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, message: `Filing failed: ${body?.error ?? res.status}` };
    }
    window.dispatchEvent(
      new CustomEvent('entity-updated', { detail: { kind: 'document', id: plan.documentId } }),
    );
    return { ok: true, message: 'Document filed under that filing' };
  } catch (err) {
    return {
      ok: false,
      message: `Filing failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}
