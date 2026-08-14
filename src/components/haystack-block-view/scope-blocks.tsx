'use client';

import type { ReactNode } from 'react';
import { ClassicPreset } from 'rete';
import { useDragState } from './drag-state';
import { setHovered } from './hover-state';
import {
  ALL_SLOTS,
  edgeStackFor,
  normalizeKind,
  slotAnchorRatio,
  slotEdge,
  slotLabel,
  visibleSlotsFor,
  type LinkSlot,
} from './link-rules';
import { SLOT_PITCH } from './block-metrics';
import { beginRowPress } from './slot-row-press';
import { LABEL_MIN_ZOOM, labelFontSize, useZoom } from './zoom-state';
import {
  CASE_H,
  CASE_W,
  BLOCK_FOOTER_H,
  FILING_H,
  FILING_W,
  type CaseBlock,
  type FilingBlock,
  type UnfiledBlock,
} from './scope-graph';

/**
 * Rete node subclass + the React blocks that paint it.
 *
 * The node carries display flags only (`isSelected` / `isPartial`); the store
 * owns selection and pushes flag changes with a targeted `area.update`.
 */

/**
 * A socket that knows what kind of entity it belongs to. The kind is what the
 * user sees (the circle takes the block's type colour) and what the drag-time
 * veto reasons about — compatibility itself is still derived from `planLink`,
 * never from a second table that could drift out of step with it.
 */
export class BlockSocket extends ClassicPreset.Socket {
  constructor(public entityKind: string) {
    super(entityKind);
  }
}

/** One socket instance per kind — nodes of the same kind share it. */
const socketRegistry = new Map<string, BlockSocket>();

export function socketFor(entityKind: string): BlockSocket {
  const key = entityKind || 'filing';
  const existing = socketRegistry.get(key);
  if (existing) return existing;
  const socket = new BlockSocket(key);
  socketRegistry.set(key, socket);
  return socket;
}

export type BlockPayload =
  | { kind: 'case'; data: CaseBlock }
  | { kind: 'filing'; data: FilingBlock }
  | { kind: 'unfiled'; data: UnfiledBlock };

/** The entity kind a block speaks for, as the link rules understand it. */
export function blockEntityKind(payload: BlockPayload): string {
  if (payload.kind === 'case') return 'case';
  if (payload.kind === 'unfiled') return 'unfiled';
  // `primaryKind` is the server's single answer and is already camelCase —
  // lowercasing it here would turn `proposedOrder` into a kind nothing knows.
  return normalizeKind(payload.data.primaryKind);
}

export class BlockNode extends ClassicPreset.Node {
  width: number;
  height: number;
  isSelected = false;
  isPartial = false;
  /** Editor mode: the block whose tags the right-hand panel is showing. */
  isActive = false;
  entityKind: string;

  /** `height` comes from the graph: filings are sized to the tallest edge
   *  stack in the corpus, so it is not a constant. */
  constructor(public payload: BlockPayload, height?: number) {
    super(payload.kind);
    this.id = payload.data.key;
    this.width = payload.kind === 'case' ? CASE_W : FILING_W;
    this.height = payload.kind === 'case' ? CASE_H : height ?? FILING_H;
    this.entityKind = blockEntityKind(payload);
    const blockSocket = socketFor(this.entityKind);
    // multipleConnections MUST be true on both sides: a motion is a hub that
    // accumulates many inbound refs (responses, replies, orders). Without it,
    // rete's syncConnections removes the port's existing edges on every
    // accepted drop — the post-refetch rebuild masked it, but a failed commit
    // would leave an unrelated valid edge deleted.
    this.addInput('in', new ClassicPreset.Input(blockSocket, undefined, true));
    this.addOutput('out', new ClassicPreset.Output(blockSocket, undefined, true));
    // Containment gets its own lane. Sharing the ref hub meant every filing's
    // input already held its case's edge, and rete's ClassicFlow grabs an
    // existing edge instead of starting a new link when you pick an occupied
    // input — which made a target-first drag impossible.
    this.addInput('contains', new ClassicPreset.Input(blockSocket, undefined, true));
    // A port per ref slot, not just the writable ones. Data written before a
    // filing's kind changed can still hold a ref in a slot the kind no longer
    // offers, and an edge with no port to attach to throws the whole edge pass.
    // Singular slots keep `multipleConnections` on: replacement is enforced in
    // `planLink`, so rete never silently drops an edge the data still has.
    if (payload.kind === 'filing') {
      for (const slot of ALL_SLOTS) {
        this.addOutput(slot, new ClassicPreset.Output(socketFor(slot), slotLabel(slot), true));
      }
    }
  }

  /** The slots this block actually offers the user, in render order. */
  get writableSlots(): LinkSlot[] {
    return this.payload.kind === 'filing'
      ? visibleSlotsFor(this.entityKind, this.payload.data.refs)
      : [];
  }
}

export class BlockConnection extends ClassicPreset.Connection<BlockNode, BlockNode> {
  edgeKind: 'contains' | 'ref' = 'contains';
}

const TYPE_CHIP: Record<string, string> = {
  motion: 'bg-blue-100 text-blue-700',
  response: 'bg-amber-100 text-amber-700',
  reply: 'bg-violet-100 text-violet-700',
  order: 'bg-emerald-100 text-emerald-700',
  notice: 'bg-slate-100 text-slate-600',
  exhibit: 'bg-rose-100 text-rose-700',
  affidavit: 'bg-teal-100 text-teal-700',
  petition: 'bg-indigo-100 text-indigo-700',
};

const FALLBACK_CHIPS = [
  'bg-cyan-100 text-cyan-700',
  'bg-lime-100 text-lime-700',
  'bg-orange-100 text-orange-700',
  'bg-fuchsia-100 text-fuchsia-700',
];

/**
 * The circle a socket paints, in its kind's colour.
 *
 * Sized and coloured with inline styles on purpose: the value is derived from
 * the entity kind at runtime, and Tailwind only emits classes it can read
 * literally in the source — a computed `bg-…-400` would come out unstyled.
 */
export function SocketCircle({ socket }: { socket: BlockSocket }) {
  return (
    <span
      title={socket.entityKind}
      style={{
        display: 'block',
        width: 14,
        height: 14,
        borderRadius: 9999,
        border: '1px solid #fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
        background: dotColor(socket.entityKind),
      }}
    />
  );
}

/** Same hues as the type chips, so a socket and its block read as one colour. */
const DOT_COLORS: Record<string, string> = {
  motion: '#60a5fa',
  response: '#fbbf24',
  reply: '#a78bfa',
  order: '#34d399',
  notice: '#94a3b8',
  exhibit: '#fb7185',
  affidavit: '#2dd4bf',
  petition: '#818cf8',
  reportersrecord: '#f472b6',
  clerksrecord: '#c084fc',
  brief: '#38bdf8',
  supplement: '#facc15',
  objection: '#f97316',
  letter: '#a3a3a3',
  case: '#475569',
  unfiled: '#cbd5e1',
};

const DOT_FALLBACKS = ['#22d3ee', '#a3e635', '#fb923c', '#e879f9'];

function dotColor(entityKind: string): string {
  const normalized = (entityKind || '').toLowerCase();
  for (const [needle, color] of Object.entries(DOT_COLORS)) {
    if (normalized.includes(needle)) return color;
  }
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  return DOT_FALLBACKS[Math.abs(hash) % DOT_FALLBACKS.length];
}

function chipClass(filingType: string): string {
  const normalized = (filingType || '').toLowerCase();
  for (const [needle, cls] of Object.entries(TYPE_CHIP)) {
    if (normalized.includes(needle)) return cls;
  }
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) hash = (hash * 31 + normalized.charCodeAt(i)) | 0;
  return FALLBACK_CHIPS[Math.abs(hash) % FALLBACK_CHIPS.length];
}

export interface SlotHandle {
  slot: LinkSlot;
  /** True when the slot already holds a ref — drawing again replaces it. */
  occupied: boolean;
  node: ReactNode;
  /** The link this slot holds, when it holds one. Drives the badge that stands
   *  in for the line now that lines are hidden at rest (#67). */
  link?: { edgeId: string; targetLabel: string };
}

/** Refs arriving AT a block, for the count on its id tag. */
export interface InboundLinks {
  count: number;
  /** "<source> — <slot>" rows for the tooltip, already trimmed by the canvas. */
  rows: string[];
}

/** What a click carried, as the stores understand it — never a DOM event. */
export interface ClickModifiers {
  /** Ctrl (or Cmd on macOS) was held: act on this block alone, no cascade. */
  bare: boolean;
}

/** macOS turns Ctrl-click into a context menu, so Cmd is the modifier that
 *  actually arrives there — both are accepted. */
function modifiersOf(event: { ctrlKey: boolean; metaKey: boolean }): ClickModifiers {
  return { bare: event.ctrlKey || event.metaKey };
}

interface BlockProps {
  node: BlockNode;
  onToggle: (key: string, modifiers: ClickModifiers) => void;
  /** Editor mode renders drag handles so connections can be drawn. The output
   *  side is one handle per writable ref slot, each labelled with the tag it
   *  writes, so the relationship is legible before the drag ends. */
  sockets?: {
    input: ReactNode;
    outputs: SlotHandle[];
    /** Case blocks only: the right-edge drop handle a filing's caseRef targets. */
    caseTarget?: ReactNode;
    /** Which edge each socket sits on — the canvas decides, from where the
     *  edge is headed, so the handle and its wire agree. */
    sideOf?: (slot: string) => 'left' | 'right';
    inputSide?: 'left' | 'right';
    /** What points at this block — shown as a count on its id tag. */
    inbound?: InboundLinks;
    /** Whether a slot's row can start a link (#96). Only the editor wires the
     *  connection plugin, so only there is there anything for a row to arm. */
    armable?: boolean;
  };
}


/**
 * The badge that says a link LEAVES here.
 *
 * A hairline stub out from the socket, then a stroked ring: the detachment is
 * the whole message. A filled dot on the circle reads "this slot is full"; a
 * ring sitting off the edge of the block reads "something leaves from here and
 * goes somewhere else" — which is what the user needs now that the line itself
 * is hidden until hover (#67). It replaces the ' •' the label used to carry.
 *
 * `data-link-badge` carries the edge id: the geometry assertion excludes these
 * from its circle measurements, and #62's menu will need the id anyway.
 */
function LinkBadge({
  edgeId,
  side,
  color,
  title,
}: {
  edgeId: string;
  side: 'left' | 'right';
  color: string;
  title: string;
}) {
  const outward = side === 'right' ? { left: '100%' } : { right: '100%' };
  return (
    <span
      data-link-badge={edgeId}
      title={title}
      style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        ...outward,
        display: 'flex',
        alignItems: 'center',
        flexDirection: side === 'right' ? 'row' : 'row-reverse',
        // Interactive from #62: the badge is the right-click target for the
        // link it stands for, so it has to be able to receive the event.
        pointerEvents: 'auto',
      }}
    >
      <span style={{ display: 'block', width: 10, height: 1, background: color, opacity: 0.7 }} />
      <span
        style={{
          display: 'block',
          width: 11,
          height: 11,
          borderRadius: 9999,
          border: `1.5px solid ${color}`,
          background: 'transparent',
        }}
      />
    </span>
  );
}

/**
 * How many refs point AT this block, shown on its id tag.
 *
 * Fan-in is the interesting number on this canvas — a motion collects
 * responses, replies and the order that rules on it — so the count lives on the
 * receiving end. One inbound ref is a bare ring; two or more carries the
 * number, because that is when "how many" starts being a question.
 */
function InboundBadge({ inbound, side, color }: { inbound: InboundLinks; side: 'left' | 'right'; color: string }) {
  if (inbound.count < 1) return null;
  const outward = side === 'right' ? { left: '100%' } : { right: '100%' };
  return (
    <span
      data-link-badge="inbound"
      data-inbound-count={inbound.count}
      title={inbound.rows.join('\n')}
      style={{
        position: 'absolute',
        top: '50%',
        transform: 'translateY(-50%)',
        ...outward,
        display: 'flex',
        alignItems: 'center',
        flexDirection: side === 'right' ? 'row' : 'row-reverse',
        // Right-clickable: this is what opens the fan-in list.
        pointerEvents: 'auto',
      }}
    >
      <span style={{ display: 'block', width: 10, height: 1, background: color, opacity: 0.7 }} />
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 11,
          height: 11,
          padding: inbound.count > 1 ? '0 2px' : 0,
          borderRadius: 9999,
          border: `1.5px solid ${color}`,
          background: 'rgba(255,255,255,0.9)',
          fontSize: 8,
          lineHeight: 1,
          color,
        }}
      >
        {inbound.count > 1 ? inbound.count : ''}
      </span>
    </span>
  );
}

export function ScopeBlock({ node, onToggle, sockets }: BlockProps) {
  const { payload, isSelected, isPartial, isActive } = node;
  const size = { width: node.width, height: node.height };

  // While a link is being dragged, every block says whether it would take it.
  const drag = useDragState();
  const zoom = useZoom();
  const isDragSource = drag.active && drag.sourceKey === node.id;
  const isCompatible = drag.active && drag.compatible.has(node.id);
  const dragClass = !drag.active
    ? ''
    : isCompatible
      ? 'ring-2 ring-emerald-400'
      : isDragSource
        ? ''
        : 'opacity-40';

  const ring = isActive
    ? 'ring-2 ring-indigo-500 border-indigo-400'
    : isSelected
      ? 'ring-2 ring-blue-500 border-blue-400'
      : isPartial
        ? 'border-2 border-dashed border-blue-400'
        : 'border-gray-200';

  // The socket's own element has to be a block box: the connection plugin
  // hit-tests it with `elementsFromPoint`, and an inline wrapper's box doesn't
  // cover the handle its children paint.
  const handleBox = 'absolute [&_.input-socket]:block [&_.output-socket]:block';
  // caseRef sits on the left edge; every other slot on the right. Splitting
  // here keeps each edge's stacking independent, so adding caseRef doesn't
  // shift the ref slots down.
  // Which side each handle sits on is the canvas's call — it knows where the
  // wire is going. Without a decision (filter mode) fall back to the slot's
  // structural home.
  const sideOf = (slot: LinkSlot) => sockets?.sideOf?.(slot) ?? slotEdge(slot);
  const leftHandles = (sockets?.outputs ?? []).filter(h => sideOf(h.slot) === 'left');
  const rightHandles = (sockets?.outputs ?? []).filter(h => sideOf(h.slot) === 'right');
  // One stack per edge, hub included — the hub is a circle on the same edge as
  // the slots, and laying it out on a scale of its own is how it ended up
  // exactly on top of the first slot (#65). The canvas's watcher builds these
  // from the same helper, so a handle and its wire cannot disagree.
  const hubSide = payload.kind === 'case' ? null : sockets?.inputSide ?? 'left';
  const slotKeys = (sockets?.outputs ?? []).map(h => h.slot);
  const leftStack = edgeStackFor({ edge: 'left', slots: slotKeys, sideOf, hubSide });
  const rightStack = edgeStackFor({ edge: 'right', slots: slotKeys, sideOf, hubSide });
  const hubStack = hubSide === 'left' ? leftStack : rightStack;
  // Only a FILING draws a title bar. The unfiled pile and the case block don't,
  // so their handles centre on the whole block — and the watcher has to be told
  // the same thing or the two disagree by half the title height (#77).
  // A filing's title bar is one to three lines of its own name (#99), so the
  // band the anchors exclude is per BLOCK, not a constant. Everything that
  // measures it reads this one value — a shared constant beside a per-block bar
  // is exactly how the fan came to miss its circle in #77.
  const titleH = payload.kind === 'filing' ? payload.data.titleH : 0;
  const bands = payload.kind === 'filing' ? { titleH } : { titleH: 0, footerH: 0 };
  /**
   * The grab handle for a slot is its whole ROW, not its 6.3px circle (#96).
   *
   * Transparent, half the block wide, one SLOT_PITCH tall, pinned to the slot's
   * own edge — so a left-edge row and a right-edge row can never cover the same
   * point, and rows on one edge tile at exactly the pitch. Each row is bound to
   * ONE slot at render time, so there is no nearest-socket search and nothing to
   * disambiguate; that is what enlarging the circles could not offer, since at
   * 9.9px of on-screen pitch their boxes would have had to overlap.
   *
   * `data-slot-row`, never `data-slot`: the geometry verifier reads every
   * `[data-slot]` as a handle and measures the circle inside it, and these rows
   * have no circle. They are also not `.output-socket`, which is what keeps
   * `resolveDrop`'s socket-bail as narrow as it is.
   */
  const slotRow = (handle: SlotHandle, edge: 'left' | 'right', stack: string[]) => (
    <div
      key={`row-${handle.slot}`}
      className={`absolute ${edge === 'left' ? 'left-0' : 'right-0'} w-1/2 -translate-y-1/2`}
      style={{
        top: `${slotAnchorRatio(handle.slot, stack, node.height, bands) * 100}%`,
        height: SLOT_PITCH,
      }}
      data-slot-row={handle.slot}
      onPointerDown={event => {
        // `currentTarget` is read HERE, synchronously: React nulls it as soon as
        // the handler returns, and the arming decision is made later, on the
        // move that crosses the slop. The QUERY stays lazy so a re-render
        // between press and threshold can't leave us holding a detached circle.
        const stack = event.currentTarget.parentElement;
        beginRowPress(event, {
          circleFor: () =>
            stack?.querySelector(`[data-slot="${handle.slot}"] .output-socket`) ?? null,
        });
      }}
    />
  );

  const handles = sockets ? (
    <>
      {/* Rows FIRST, handles second. Painted underneath, a press on the circle
          reaches the circle (the plugin's own gesture, armed once) and a click
          on a LinkBadge still reaches the badge — badges sit outside the
          handle's box but are how a link is opened and deleted (#61/#75), and a
          row painted over them would swallow that. */}
      {sockets.armable && leftHandles.map(handle => slotRow(handle, 'left', leftStack))}
      {sockets.armable && rightHandles.map(handle => slotRow(handle, 'right', rightStack))}
      {/* The ref hub faces whichever side its inbound edges arrive from: under
          docket order refs point leftward, so a motion collects them on its
          RIGHT edge rather than dragging every wire around the block.
          A case block never shows it — a case has exactly one affordance, the
          id tag, and its ports exist only so edges have somewhere to attach. */}
      {payload.kind !== 'case' && <div
        className={`${handleBox} ${
          (sockets.inputSide ?? 'left') === 'right'
            ? 'right-0 translate-x-1/2'
            : 'left-0 -translate-x-1/2'
        } -translate-y-1/2`}
        style={{ top: `${slotAnchorRatio('in', hubStack, node.height, bands) * 100}%` }}
        data-hub-side={sockets.inputSide ?? 'left'}
        // The hub is what a ref points AT, so it is this block's id — the same
        // thing a case block already advertises. It worked all along; with no
        // label it read as decoration, which is why linking a motion to an
        // order's id looked impossible.
        data-slot="id"
        // The unfiled pile has no entity of its own; it speaks for its case.
        title={`id — ${payload.kind === 'filing' ? payload.data.id : payload.data.caseId}`}
      >
        {sockets.input}
        {sockets.inbound && (
          <InboundBadge
            inbound={sockets.inbound}
            side={sockets.inputSide ?? 'left'}
            color={dotColor(node.entityKind)}
          />
        )}
        {zoom >= LABEL_MIN_ZOOM && (
          <span
            style={{ fontSize: labelFontSize(zoom) }}
            className={`pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-white/85 px-1 leading-tight text-gray-500 shadow-sm ${
              (sockets.inputSide ?? 'left') === 'right' ? 'right-full mr-1' : 'left-full ml-1'
            }`}
          >
            id
          </span>
        )}
      </div>}
      {/* caseRef leaves from the LEFT edge — it faces the case column, so its
          edge runs straight there instead of round the block. Its label sits
          to the RIGHT of the circle, i.e. still inside the block. */}
      {leftHandles.map(handle => (
        <div
          key={handle.slot}
          className={`${handleBox} left-0 -translate-x-1/2 -translate-y-1/2`}
          style={{ top: `${slotAnchorRatio(handle.slot, leftStack, node.height, bands) * 100}%` }}
          data-slot={handle.slot}
          data-slot-edge="left"
          data-slot-occupied={handle.occupied ? 'yes' : 'no'}
          title={`${slotLabel(handle.slot)}${
            handle.occupied ? ' — drawing to another case moves this filing' : ''
          }`}
        >
          {handle.node}
          {handle.link && (
            <LinkBadge
              edgeId={handle.link.edgeId}
              side="left"
              color={dotColor(handle.slot)}
              title={`${slotLabel(handle.slot)} → ${handle.link.targetLabel}`}
            />
          )}
          {zoom >= LABEL_MIN_ZOOM && (
            <span style={{ fontSize: labelFontSize(zoom) }}
              className="pointer-events-none absolute left-full top-1/2 ml-1 -translate-y-1/2 whitespace-nowrap rounded bg-white/85 px-1 leading-tight text-gray-500 shadow-sm">
              {slotLabel(handle.slot)}
            </span>
          )}
        </div>
      ))}
      {rightHandles.map((handle, index) => (
        <div
          key={handle.slot}
          className={`${handleBox} right-0 translate-x-1/2 -translate-y-1/2`}
          style={{ top: `${slotAnchorRatio(handle.slot, rightStack, node.height, bands) * 100}%` }}
          data-slot={handle.slot}
          data-slot-edge="right"
          data-slot-occupied={handle.occupied ? 'yes' : 'no'}
          title={`${slotLabel(handle.slot)}${handle.occupied ? ' — already linked; drawing again replaces it' : ''}`}
        >
          {handle.node}
          {handle.link && (
            <LinkBadge
              edgeId={handle.link.edgeId}
              side="right"
              color={dotColor(handle.slot)}
              title={`${slotLabel(handle.slot)} → ${handle.link.targetLabel}`}
            />
          )}
          {/* The tag name is the whole point of a slot socket: it says where
              the link will be written before the drag ends. Below the legible
              zoom it would be a 4px smudge, so the tooltip carries it instead.
              ABSOLUTE, outside the layout flow: the wrapper was a flex row, so
              the label's appearance at the zoom threshold widened it and the
              translate-x-1/2 centering pushed the circle off the block edge —
              the anchor math (box.x + box.w) never moves, so circles and edge
              endpoints visibly disagreed exactly when labels were visible. */}
          {zoom >= LABEL_MIN_ZOOM && (
            <span
              // INSIDE the block, to the left of the circle: edges leave from
              // the right edge, so a label sitting outside had every outgoing
              // wire drawn straight through it. Still absolute — that is what
              // keeps the circle pinned to the edge (the #46 regression).
              style={{ fontSize: labelFontSize(zoom) }}
              className="pointer-events-none absolute right-full top-1/2 mr-1 -translate-y-1/2 whitespace-nowrap rounded bg-white/85 px-1 leading-tight text-gray-500 shadow-sm"
            >
              {slotLabel(handle.slot)}
            </span>
          )}
        </div>
      ))}
    </>
  ) : null;

  if (payload.kind === 'unfiled') {
    const u = payload.data;
    return (
      <div
        style={size}
        onClick={event => onToggle(u.key, modifiersOf(event))}
        onPointerEnter={() => setHovered(u.key)}
        onPointerLeave={() => setHovered(null)}
        className={`relative flex cursor-pointer select-none flex-col justify-center rounded-md border border-dashed bg-gray-50 px-2.5 shadow-sm transition-opacity ${
          isActive ? 'ring-2 ring-indigo-500' : 'border-gray-300'
        } ${dragClass}`}
        data-block-kind="unfiled"
        data-drag-target={drag.active ? (isCompatible ? 'yes' : 'no') : undefined}
        data-block-id={u.key}
        data-block-state={isActive ? 'active' : 'none'}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Unfiled documents
        </div>
        <div className="mt-0.5 text-[11px] text-gray-500">
          {u.docCount} docs · {u.indexedCount} indexed · no filing
        </div>
        <div className="mt-0.5 text-[10px] text-gray-400">
          listed in the Unfiled docs panel — drag one onto a filing
        </div>
        {handles}
      </div>
    );
  }

  if (payload.kind === 'case') {
    const c = payload.data;
    return (
      <div
        style={size}
        onClick={event => onToggle(c.key, modifiersOf(event))}
        onPointerEnter={() => setHovered(c.key)}
        onPointerLeave={() => setHovered(null)}
        className={`relative flex cursor-pointer select-none flex-col justify-center rounded-lg border bg-white px-3 shadow-sm transition-colors ${ring} ${
          isSelected ? 'bg-blue-50/60' : 'hover:bg-gray-50'
        } ${dragClass}`}
        data-block-kind="case"
        data-drag-target={drag.active ? (isCompatible ? 'yes' : 'no') : undefined}
        data-block-id={c.key}
        data-block-state={
          isActive ? 'active' : isSelected ? 'selected' : isPartial ? 'partial' : 'none'
        }
      >
        <div className="truncate text-[13px] font-semibold text-gray-800">{c.name}</div>
        <div className="mt-1 text-[11px] text-gray-500">
          {c.filingCount} filings · {c.indexedDocCount}/{c.docCount} indexed
        </div>
        {c.unfiledDocCount > 0 && (
          <div className="mt-0.5 text-[10px] text-gray-400">
            {c.unfiledDocCount} unfiled docs
          </div>
        )}
        {/* The case exposes its id on the right edge: that is what a filing's
            caseRef links TO, so it reads as a tag rather than a bare socket. */}
        {sockets?.caseTarget && (
          <div
            className={`${handleBox} right-0 translate-x-1/2 -translate-y-1/2`}
            // Same helper the edge watcher anchors with, with no title band:
            // two copies of this arithmetic is how the fan and the circle ended
            // up 12px apart.
            style={{ top: `${slotAnchorRatio('contains', [], node.height, { titleH: 0, footerH: 0 }) * 100}%` }}
            data-slot="id"
            data-slot-edge="right"
            title={`id — ${c.id}`}
          >
            {sockets.caseTarget}
            {zoom >= LABEL_MIN_ZOOM && (
              <span style={{ fontSize: labelFontSize(zoom) }}
              className="pointer-events-none absolute right-full top-1/2 mr-1 -translate-y-1/2 whitespace-nowrap rounded bg-white/85 px-1 leading-tight text-gray-500 shadow-sm">
                id
              </span>
            )}
          </div>
        )}
        {handles}
      </div>
    );
  }

  const f = payload.data;
  const unindexed = f.indexedCount === 0;
  return (
    <div
      style={size}
      onClick={event => onToggle(f.key, modifiersOf(event))}
      onPointerEnter={() => setHovered(f.key)}
      onPointerLeave={() => setHovered(null)}
      // NOT `overflow-hidden`: handles are centred ON the edge, so half of each
      // circle sits outside the box and clipping sliced every one in half. The
      // title bar rounds its own top corners instead of relying on the parent.
      className={`relative flex cursor-pointer select-none flex-col rounded-md border shadow-sm transition-colors ${ring} ${
        unindexed ? 'bg-gray-50' : 'bg-white'
      } ${isSelected ? 'bg-blue-50/60' : 'hover:bg-gray-50'} ${dragClass}`}
      data-block-kind="filing"
      data-drag-target={drag.active ? (isCompatible ? 'yes' : 'no') : undefined}
      data-block-id={f.key}
      data-block-state={isActive ? 'active' : isSelected ? 'selected' : 'none'}
      data-block-mapped={f.missing.length === 0 ? 'yes' : 'no'}
    >
      {/* Title bar, like a rete node's: the filing's name is what identifies it,
          so it reads first. Padded clear of the slot labels that render inside
          the right edge, and truncated with the full name in the tooltip. */}
      <div
        style={{ height: titleH }}
        // Wraps to the height the layout already reserved for it. `line-clamp`
        // rather than `truncate`: a filing's name is how the user tells two
        // motions in the same matter apart, and an ellipsis after four words
        // makes them identical.
        className={`flex shrink-0 items-start rounded-t-md border-b px-2.5 pr-16 pt-1 text-[12px] font-medium leading-[15px] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:5] overflow-hidden ${
          unindexed
            ? 'border-gray-200 bg-gray-100/70 text-gray-400'
            : 'border-gray-200 bg-gray-50 text-gray-800'
        }`}
        title={f.label}
        data-block-title="filing"
      >
        {f.label}
      </div>
      {/* The body belongs to the slots. It used to carry the chips as well,
          which is why the labels needed 4rem of right padding and why a fourth
          handle started crowding the badges — the two were competing for one
          band. Now it is deliberately empty. */}
      <div className="flex-1" data-block-body="slots" />
      {/* Footer: what the filing IS and how much of it is indexed, on one row
          out of the slots' way. Mirrors the title bar at the other end. */}
      <div
        style={{ height: BLOCK_FOOTER_H }}
        className={`flex shrink-0 items-center gap-1.5 overflow-hidden rounded-b-md border-t px-2.5 ${
          unindexed ? 'border-gray-200 bg-gray-100/70' : 'border-gray-200 bg-gray-50'
        }`}
        data-block-footer="filing"
      >
        <span
          className={`shrink-0 rounded px-1.5 text-[9px] font-semibold uppercase tracking-wide ${chipClass(
            f.filingType,
          )} ${unindexed ? 'opacity-60' : ''}`}
        >
          {f.filingType || 'filing'}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 text-[9px] font-medium ${
            unindexed ? 'bg-gray-100 text-gray-400' : 'bg-gray-100 text-gray-600'
          }`}
        >
          {f.indexedCount}/{f.docCount} docs
        </span>
        {f.missing.length > 0 && (
          <span
            className="shrink-0 rounded bg-amber-50 px-1.5 text-[9px] font-medium text-amber-700"
            title={f.missing.join(', ')}
          >
            unmapped
          </span>
        )}
      </div>
      {handles}
    </div>
  );
}
