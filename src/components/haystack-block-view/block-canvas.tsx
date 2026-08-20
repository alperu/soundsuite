'use client';

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { NodeEditor, type GetSchemes } from 'rete';
import { AreaExtensions, AreaPlugin, type Position } from 'rete-area-plugin';
import { ClassicFlow, ConnectionPlugin, getSourceTarget } from 'rete-connection-plugin';
import { Presets, ReactPlugin, type ReactArea2D } from 'rete-react-plugin';
import { CLICK_SLOP } from './block-metrics';
import { beginDrag, currentDrag, endDrag, useDragState } from './drag-state';
import { resolveDrop } from './drop-target';
import {
  anchorSideFor,
  compatibleKeys,
  edgeStackFor,
  planLink,
  slotAnchorRatio,
  visibleSlotsFor,
  type LinkSlot,
} from './link-rules';
import {
  BlockConnection,
  BlockNode,
  ScopeBlock,
  SocketCircle,
  socketFor,
} from './scope-blocks';
import { caseTriState, type EntityKey, type ScopeGraph } from './scope-graph';
import { setTransform, setZoom } from './zoom-state';
import { setPinned, setSelectedBlocks, useHovered, usePinned, useSelectedBlocks } from './hover-state';
import { edgeVisibility } from './edge-visibility';
import { useShowAllLinks } from './link-visibility';
import { mountBandRules, mountColumnHeaders } from './column-headers';
import { fanPath, refPath } from './fan-route';
import { setupMarquee, type MarqueeResult } from './use-selection-area';

/** Left-button gesture. The lasso keeps its slot here for when it lands. */
export type CanvasTool = 'pointer' | 'marquee';

/**
 * What a right-click landed on, resolved by the canvas so the host never has to
 * read the DOM. Ordered narrowest-first when resolving: a badge sits inside a
 * slot, which sits inside a block.
 */
export type ContextTarget =
  | { kind: 'badge'; edgeId: string; blockKey: EntityKey }
  /** The drawn line itself — reachable once it is pinned or shown. */
  | { kind: 'edge'; edgeId: string }
  | { kind: 'idTag'; blockKey: EntityKey }
  | { kind: 'slot'; slot: string; blockKey: EntityKey }
  | { kind: 'block'; blockKey: EntityKey }
  | { kind: 'background' };

/** What the host can ask the canvas to do imperatively. */
export interface CanvasHandle {
  /** Bring a block into view at a readable zoom — "where did it go". */
  centerOn: (key: EntityKey) => void;
}

/** Below this the typed sockets are too small to aim at. */
const MIN_EDIT_ZOOM = 0.45;

type Schemes = GetSchemes<BlockNode, BlockConnection>;
type AreaExtra = ReactArea2D<Schemes>;

/**
 * The block canvas, shared by both tabs.
 *
 * Filtering mode is read-only structure: no connection plugin, no rete
 * selector, clicks feed the cascade store. Editor mode swaps that for linking:
 * sockets become draggable, a drawn connection is validated and committed by
 * the host, and a click makes the block active so the tag panel follows it.
 * Neither mode lets rete own domain state — nodes carry display flags only.
 */
type Props = {
  graph: ScopeGraph;
  /** A click that landed on nothing. Each tab decides what "nothing selected"
   *  means for it — filtering empties the cascade, the editor closes the tag
   *  panel — so the canvas only reports the gesture. */
  onBackgroundClick?: () => void;
} & (
  | {
      mode: 'filter';
      selected: Set<EntityKey>;
      /** `bare` (Ctrl/Cmd) asks for this block alone, without its ref chain. */
      onToggle: (key: EntityKey, bare: boolean) => void;
      /** Which gesture the left button performs. Absent means 'pointer'. */
      tool?: CanvasTool;
      /** A finished marquee. Editor mode has no multi-select to feed yet, so
       *  only filtering offers the tool at all. */
      onMarquee?: (result: MarqueeResult) => void;
    }
  | {
      mode: 'edit';
      activeKey: EntityKey | null;
      onSelectBlock: (key: EntityKey) => void;
      /** Resolves once the ref write (or its rejection) has been handled.
       *  `slot` is the output socket the drag came from — it names the ref. */
      onConnect: (source: EntityKey, target: EntityKey, slot?: string) => void | Promise<void>;
      /** A drop the pre-drop veto refused — the flow never proposes it, so the
       *  reason would otherwise never reach the user. */
      onRefuse?: (reason: string) => void;
      /** The user pulled an existing ref edge off a block's input hub. That
       *  grab is the unlink gesture — the host clears the ref (undoably) and
       *  the refetch redraws whatever the data then says. */
      onUnlink?: (edgeId: string) => void;
      /** A right-click, already resolved to what it landed on. */
      onContextMenu?: (target: ContextTarget, at: { x: number; y: number }) => void;
      /** True while the host is showing a menu. The canvas defers Escape to it
       *  rather than racing it for the key. */
      menuOpen?: boolean;
      /** Handed the imperative handle once the canvas is live. */
      onReady?: (api: CanvasHandle) => void;
    }
);

/**
 * Where the block at the far end of this socket's edge sits, if there is one.
 * An output slot points at whatever its ref names. The shared `in` hub takes
 * many edges at a single point, so it answers with the farthest-right block
 * pointing at this one — the direction the bundle arrives from.
 */
function edgeTargetX(
  graph: ScopeGraph,
  nodeId: string,
  side: 'input' | 'output',
  key: string,
): number | undefined {
  const filing = graph.filingById.get(nodeId.replace(/^filing:/, ''));
  if (!filing) return undefined;
  if (side === 'output') {
    const targetId = filing.refs?.[key];
    if (typeof targetId !== 'string') return undefined;
    return graph.filingById.get(targetId)?.x;
  }
  if (key !== 'in') return undefined;
  let rightmost: number | undefined;
  for (const edge of graph.edges) {
    if (edge.kind !== 'ref' || edge.target !== nodeId) continue;
    const source = graph.filingById.get(edge.source.replace(/^filing:/, ''));
    if (source && (rightmost === undefined || source.x > rightmost)) rightmost = source.x;
  }
  return rightmost;
}

/**
 * Socket positions come from the layout, not the DOM: blocks are fixed-size and
 * never move, so an anchor is arithmetic. Which EDGE it lands on depends on
 * where the edge is going — see `anchorSideFor`.
 */
function layoutSocketPositions(graph: ScopeGraph) {
  return {
    attach() {
      /* positions are static — nothing to watch */
    },
    listen(nodeId: string, side: 'input' | 'output', key: string, change: (p: Position) => void) {
      const box = graph.boxes.get(nodeId);
      if (box) {
        const filing = graph.filingById.get(nodeId.replace(/^filing:/, ''));
        const slots = filing ? visibleSlotsFor(filing.primaryKind, filing.refs) : [];
        // Which edge each handle sits on, decided exactly as the block decides
        // it — the block and this watcher share `edgeStackFor` and `sideOf`, so
        // a circle and the wire that ends on it read the same list.
        const sideOf = (slot: LinkSlot) =>
          anchorSideFor({
            slot,
            side: 'output',
            sourceX: box.x,
            targetX: edgeTargetX(graph, nodeId, 'output', slot),
          });
        const hubSide = filing
          ? anchorSideFor({
              slot: 'in',
              side: 'input',
              sourceX: box.x,
              targetX: edgeTargetX(graph, nodeId, 'input', 'in'),
            })
          : null;
        // `linkTo` is the hub's lane, not a socket of its own (#105): it holds
        // no edges, so it has no direction to derive and no place in any stack.
        // Anchoring it AS the hub is what makes a lane-armed drag draw its wire
        // from the id circle the user aimed at — left to itself it would fall
        // through to the block's centre-right, and #46/#77 are about exactly
        // this kind of quiet disagreement between a handle and its wire.
        const anchorKey = key === 'linkTo' ? 'in' : key;
        const onRight =
          anchorKey === 'in'
            ? hubSide === 'right'
            : anchorSideFor({
                slot: anchorKey,
                side,
                sourceX: box.x,
                targetX: edgeTargetX(graph, nodeId, side, anchorKey),
              }) === 'right';
        const stack = edgeStackFor({
          edge: onRight ? 'right' : 'left',
          slots,
          sideOf,
          hubSide,
        });
        // A case block draws no title bar, so its handles centre on the whole
        // block. Measuring from a band it never rendered is what pushed the
        // containment fan 12px off the id circle (#77).
        // A case block and the unfiled pile draw neither band; a filing draws
        // both. Measuring from a band the block never rendered is what put the
        // containment fan off its circle (#77).
        // Per-block title band (#99): a filing's bar is as tall as its own name
        // needs, so the anchors read THAT, not the constant. A case block and
        // the unfiled pile draw neither band.
        const ratio = slotAnchorRatio(
          anchorKey,
          stack,
          box.h,
          filing ? { titleH: filing.titleH } : { titleH: 0, footerH: 0 },
        );
        const position: Position = {
          x: onRight ? box.x + box.w : box.x,
          y: box.y + box.h * ratio,
        };
        // Deferred: the connection component subscribes during render.
        void Promise.resolve().then(() => change(position));
      }
      return () => {
        /* nothing to unsubscribe */
      };
    },
  };
}

/** The single painted-state rule, shared by the build pass and the repaint. */
function blockState(
  graph: ScopeGraph,
  props: Props,
  kind: 'case' | 'filing' | 'unfiled',
  key: EntityKey,
): 'active' | 'selected' | 'partial' | 'none' {
  if (props.mode === 'edit') return props.activeKey === key ? 'active' : 'none';
  if (kind !== 'case') return props.selected.has(key) ? 'selected' : 'none';
  const state = caseTriState(graph, props.selected, key);
  return state === 'all' ? 'selected' : state === 'some' ? 'partial' : 'none';
}

export default function BlockCanvas(props: Props) {
  const { graph } = props;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const marqueeLayerRef = useRef<HTMLDivElement | null>(null);
  // Set when a marquee just completed, so the click that ends the same gesture
  // isn't also read as a deselect.
  const marqueeConsumedRef = useRef(false);
  const areaRef = useRef<AreaPlugin<Schemes, AreaExtra> | null>(null);
  const nodesRef = useRef<Map<string, BlockNode>>(new Map());
  // Held in a ref so new handler identities never rebuild the canvas.
  const propsRef = useRef(props);
  propsRef.current = props;
  const paintedRef = useRef<Map<string, string>>(new Map());
  // Survives a rebuild so a committed edge doesn't yank the viewport back.
  const transformRef = useRef<{ x: number; y: number; k: number } | null>(null);
  const connectionRef = useRef<ConnectionPlugin<Schemes, AreaExtra> | null>(null);
  // Where the press that will become this click started, and whether it landed
  // on background at all — a pan ends in a click too, and a gesture that began
  // on a block or a socket is never a deselect however it ends.
  const pointerDownRef = useRef<{ x: number; y: number; onBackground: boolean } | null>(null);

  const editMode = props.mode === 'edit';

  // Build / rebuild, keyed on the graph identity and the mode only.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let layoutSettled = false;
    let buildingEdges = false;
    // `editor.clear()` on teardown removes every connection; those removals are
    // bookkeeping, not a user unlinking anything.
    let tearingDown = false;

    const editor = new NodeEditor<Schemes>();
    const area = new AreaPlugin<Schemes, AreaExtra>(container);
    // AreaPlugin appended its holder element to the shared container — keep a
    // reference so teardown removes exactly THIS mount's DOM. Wiping the whole
    // container from the deferred cleanup would destroy the next mount's
    // canvas (React's dev double-mount runs cleanup and the next effect
    // synchronously, before microtasks).
    const areaHolder = container.lastElementChild;
    // Motions whose orderRef is already satisfied — derived, because the ref
    // itself lives on the order (`resolves`), never on the motion.
    const orderRefTargets = new Set(
      graph.filings
        .map(f => f.refs?.resolves)
        .filter((id): id is string => typeof id === 'string' && !!id)
        .map(id => `filing:${id}`),
    );
    // Link badges stand in for the lines that are now hidden at rest, so each
    // block needs to know what leaves it and what arrives at it. Derived once
    // per build from the same edges the canvas draws — never a second traversal
    // of the refs, which could disagree with what the graph decided.
    const labelOf = (key: string) =>
      graph.filingById.get(key.replace(/^filing:/, ''))?.label ??
      graph.caseById.get(key.replace(/^case:/, ''))?.name ??
      'unknown';
    const outgoingLinks = new Map<string, { edgeId: string; targetLabel: string }>();
    const inboundLinks = new Map<string, { count: number; rows: string[] }>();
    for (const edge of graph.edges) {
      if (edge.kind !== 'ref') continue;
      outgoingLinks.set(`${edge.source}:${edge.slot ?? 'out'}`, {
        edgeId: edge.id,
        targetLabel: labelOf(edge.target),
      });
      const bucket = inboundLinks.get(edge.target) ?? { count: 0, rows: [] };
      bucket.count += 1;
      // Capped: a tooltip is a glance, not a report.
      if (bucket.rows.length < 8) bucket.rows.push(`${labelOf(edge.source)} — ${edge.slot ?? 'ref'}`);
      inboundLinks.set(edge.target, bucket);
    }

    const render = new ReactPlugin<Schemes, AreaExtra>({ createRoot });

    render.addPreset(
      Presets.classic.setup({
        socketPositionWatcher: layoutSocketPositions(graph),
        customize: {
          node() {
            return (nodeProps: { data: BlockNode; emit: (p: ReactArea2D<Schemes>) => void }) => (
              <ScopeBlock
                node={nodeProps.data}
                onToggle={(key, modifiers) => {
                  const current = propsRef.current;
                  if (current.mode === 'edit') current.onSelectBlock(key);
                  else current.onToggle(key, modifiers.bare);
                }}
                sockets={
                  {
                        // Filtering shows the same anatomy, drawn but inert:
                        // one canvas in two interaction modes, rather than two
                        // canvases. Only editor mode wires RefSocket, so only
                        // it can start a drag.
                        input: editMode ? (
                          <SocketHandle
                            node={nodeProps.data}
                            side="input"
                            socketKey="in"
                            emit={nodeProps.emit}
                          />
                        ) : (
                          <SocketCircle socket={socketFor(nodeProps.data.entityKind)} />
                        ),
                        // A case block's right edge carries its id — the handle
                        // a filing's caseRef links to.
                        caseTarget:
                          nodeProps.data.payload.kind !== 'case' ? undefined : editMode ? (
                            <SocketHandle
                              node={nodeProps.data}
                              side="input"
                              socketKey="contains"
                              emit={nodeProps.emit}
                            />
                          ) : (
                            <SocketCircle socket={socketFor('case')} />
                          ),
                        // The block draws each handle on the edge its wire will
                        // leave from — same helper the watcher anchors with.
                        sideOf: (slot: string) =>
                          anchorSideFor({
                            slot,
                            side: 'output',
                            sourceX: graph.boxes.get(nodeProps.data.id)?.x ?? 0,
                            targetX: edgeTargetX(graph, nodeProps.data.id, 'output', slot),
                          }),
                        inbound: inboundLinks.get(nodeProps.data.id),
                        // Filtering draws the same anatomy inert, so its circles
                        // are bare `SocketCircle` spans with no plugin behind
                        // them. Saying so is better than letting the row's
                        // lookup come back empty and calling that safe (#96).
                        armable: editMode,
                        // The lane a hub row arms (#105). Only the editor has a
                        // connection plugin, so only the editor renders it.
                        linkStart: editMode ? (
                          <SocketHandle
                            node={nodeProps.data}
                            side="input"
                            socketKey="linkTo"
                            emit={nodeProps.emit}
                          />
                        ) : undefined,
                        inputSide: anchorSideFor({
                          slot: 'in',
                          side: 'input',
                          sourceX: graph.boxes.get(nodeProps.data.id)?.x ?? 0,
                          targetX: edgeTargetX(graph, nodeProps.data.id, 'input', 'in'),
                        }),
                        outputs: nodeProps.data.writableSlots.map(slot => ({
                          slot,
                          occupied:
                            slot === 'orderRef'
                              ? // Nothing stores orderRef: it is occupied when
                                // some order already points back at this motion.
                                orderRefTargets.has(nodeProps.data.id)
                              : slot === 'caseRef'
                                ? // Every filing has a case; the marker is always
                                  // filled and a second draw is a MOVE.
                                  graph.caseOfFiling.has(nodeProps.data.id)
                                : nodeProps.data.payload.kind === 'filing' &&
                                  typeof nodeProps.data.payload.data.refs[slot] === 'string',
                          link: outgoingLinks.get(`${nodeProps.data.id}:${slot}`),
                          node: editMode ? (
                            <SocketHandle
                              node={nodeProps.data}
                              side="output"
                              socketKey={slot}
                              emit={nodeProps.emit}
                            />
                          ) : (
                            <SocketCircle socket={socketFor(slot)} />
                          ),
                        })),
                      }
                }
              />
            );
          },
          socket(context) {
            const socket = context.payload;
            return () => (
              <SocketCircle socket={socket as ReturnType<typeof socketFor>} />
            );
          },
          connection(context) {
            const payload = context.payload as BlockConnection;
            const isContains = payload.edgeKind === 'contains';
            const endpoints = [payload.source, payload.target];
            return (props: { data: BlockConnection }) => (
              <EdgeLayer
                isContains={isContains}
                endpoints={endpoints}
                editMode={editMode}
                props={props}
              />
            );
          },
        },
      }),
    );

    // Route the case fan orthogonally. `connectionpath` wants a FINISHED `d`
    // string; returning points instead would be refused for anything that is
    // not exactly two of them.
    render.addPipe(context => {
      const signal = context as {
        type?: string;
        data?: { payload?: BlockConnection; points?: Position[]; path?: string };
      };
      if (signal.type !== 'connectionpath' || !signal.data) return context;
      const payload = signal.data.payload;
      const points = signal.data.points;
      if (!payload || !points || points.length !== 2) return context;
      // One path source for both reveal modes: this pipe runs whenever a
      // connection is drawn, so a hovered line and a show-all line are the same
      // geometry by construction rather than by two code paths agreeing.
      const route = payload.edgeKind === 'contains' ? fanPath : refPath;
      const path = route(graph, payload.source, payload.target, points[0], points[1]);
      // Mutating the signal's own data rather than rebuilding the context: the
      // plugin reads `path` back off the object it emitted, and a fresh object
      // does not type-check against its union of signal shapes.
      if (path) signal.data.path = path;
      return context;
    });

    editor.use(area);

    if (editMode) {
      // Registered before the render plugin: it learns which elements are
      // sockets from the render signals, which only reach plugins already in
      // the pipeline.
      const connection = new ConnectionPlugin<Schemes, AreaExtra>();
      connectionRef.current = connection;
      // Compatibility is asked of `planLink`, the same rules the commit obeys —
      // one source of truth instead of a socket matrix that could drift from it.
      // `getSourceTarget` is not optional: a drag started on an input socket
      // arrives with source and target the other way round.
      connection.addPreset(
        () =>
          new ClassicFlow({
            canMakeConnection: (from, to) => {
              const pair = getSourceTarget(from, to);
              if (!pair) return false;
              const [source, target] = pair;
              // The slot comes from the NORMALISED source, never from the
              // socket the user happened to grab first: a backwards drag
              // (motion input → response slot) swaps the two.
              return planLink(graph, source.nodeId, target.nodeId, source.key).ok;
            },
            // `makeConnection` stays default so the drop still reaches
            // `connectioncreate` below, which is what commits the ref.
          }),
      );
      area.use(connection);

      // Pick/drop are observed on the connection plugin's own pipeline —
      // those signals stay inside its scope and never reach the area's.
      // Highlighting is component-level state, not a canvas repaint: every
      // block subscribes to the drag store and restyles itself.
      connection.addPipe(context => {
        const signal = context as { type?: string; data?: unknown };
        if (signal.type === 'connectionpick') {
          const picked = (
            signal.data as {
              socket?: { nodeId: string; side: 'input' | 'output'; key: string };
            }
          )?.socket;
          if (picked) {
            // One question, asked of the rules layer: `linkVerdicts` knows that
            // an output slot and the input hub ask mirror-image questions, and
            // the picker (#63) reads the reasons from the same call.
            const compatible = compatibleKeys(graph, picked.nodeId, {
              slot: picked.side === 'output' ? picked.key : undefined,
              side: picked.side,
            });
            beginDrag(picked.nodeId, compatible, {
              slot: picked.side === 'output' ? picked.key : null,
              side: picked.side,
            });
          }
        } else if (signal.type === 'connectiondrop') {
          endDrag();
        }
        return context;
      });
    }
    area.use(render);

    if (editMode) {
      // A user-drawn connection never lands in the editor: the host commits the
      // ref, the shell refetches, and the rebuilt graph draws the real edge.
      editor.addPipe(context => {
        // Pulling an existing edge off an input hub is how ClassicFlow starts a
        // re-route. We don't support re-routing — we read the gesture as
        // "unlink this" and block the removal, so the canvas keeps showing the
        // edge until the data actually loses it.
        if (context.type === 'connectionremove' && !buildingEdges && !tearingDown) {
          const removed = context.data as unknown as { id: string };
          const edge = graph.edges.find(e => e.id === removed.id);
          const current = propsRef.current;
          if (edge?.kind === 'ref' && current.mode === 'edit' && current.onUnlink) {
            current.onUnlink(removed.id);
            return undefined;
          }
          return context;
        }
        if (context.type !== 'connectioncreate' || buildingEdges) return context;
        const data = context.data as unknown as {
          source: string;
          target: string;
          sourceOutput?: string;
        };
        const current = propsRef.current;
        if (current.mode === 'edit') {
          void current.onConnect(data.source, data.target, data.sourceOutput);
        }
        return undefined;
      });
    }

    // Publish the zoom so blocks can drop detail that would be illegible, and
    // the full transform so the column chrome outside the canvas tracks it.
    area.addPipe(context => {
      const signal = context as { type?: string };
      if (signal.type === 'zoomed' || signal.type === 'translated' || signal.type === 'resized') {
        const t = area.area.transform;
        setZoom(t.k);
        setTransform({ x: t.x, y: t.y, k: t.k });
      }
      return context;
    });

    AreaExtensions.restrictor(area, {
      scaling: () => ({ min: 0.15, max: 1.5 }),
      translation: false,
    });
    // NOT `simpleNodesOrder`: it brings a node to the front by re-appending its
    // DOM element on pointerdown, and a real (trusted) click never fires when
    // the element moves mid-gesture — pointerdown and pointerup arrive, `click`
    // does not, so the block's onClick and the tag panel behind it are dead.
    // Dispatched events cannot show this: they don't go through the browser's
    // click-target computation, which is why an earlier repro matrix built on
    // element.dispatchEvent passed on every path. z-index ordering achieves the
    // same stacking without touching the DOM, and the plugin recommends it
    // wherever click handlers inside nodes must stay stable.
    AreaExtensions.zIndexNodesOrder(area);

    // Blocks sit where the layout puts them; only the initial positioning pass
    // is allowed to translate a node.
    area.addPipe(context =>
      context.type === 'nodetranslate' && layoutSettled ? undefined : context,
    );

    areaRef.current = area;
    nodesRef.current = new Map();
    paintedRef.current = new Map();

    void (async () => {
      const byKey = nodesRef.current;

      for (const block of [
        ...graph.cases.map(data => ({ kind: 'case' as const, data })),
        ...graph.filings.map(data => ({ kind: 'filing' as const, data })),
        ...graph.unfiled.map(data => ({ kind: 'unfiled' as const, data })),
      ]) {
        if (disposed) return;
        const node = new BlockNode(block, graph.boxes.get(block.data.key)?.h);
        // A rebuild (a refetch after `entity-updated`) has to come back with
        // the selection already painted — including a partial case.
        const state = blockState(graph, propsRef.current, block.kind, block.data.key);
        node.isSelected = state === 'selected';
        node.isPartial = state === 'partial';
        node.isActive = state === 'active';
        await editor.addNode(node);
        if (disposed) return;
        await area.translate(node.id, { x: block.data.x, y: block.data.y });
        if (disposed) return;
        byKey.set(node.id, node);
        paintedRef.current.set(node.id, state);
      }

      // Edges after every block exists and has painted once.
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (disposed) return;

      buildingEdges = true;
      for (const edge of graph.edges) {
        const source = byKey.get(edge.source);
        const target = byKey.get(edge.target);
        if (!source || !target) continue;
        // A ref edge leaves from the slot that holds it, so it lands on the
        // labelled socket the user would have drawn it from. Containment keeps
        // the generic port.
        // Ref edges leave from the slot holding them; the case edge leaves from
        // the filing's caseRef; the unfiled pile still hangs off the case.
        const sourceKey = edge.slot ?? 'out';
        if (!source.outputs[sourceKey]) continue;
        const targetKey = edge.kind === 'ref' ? 'in' : 'contains';
        const connection = new BlockConnection(source, sourceKey, target, targetKey);
        connection.id = edge.id;
        connection.edgeKind = edge.kind;
        await editor.addConnection(connection);
      }
      buildingEdges = false;

      if (disposed) return;
      layoutSettled = true;
      // An edit rebuilds the canvas on every commit — restore the viewport the
      // user was working in instead of snapping back to a full fit.
      const previous = transformRef.current;
      if (previous) {
        await area.area.zoom(previous.k, 0, 0);
        await area.area.translate(previous.x, previous.y);
      } else {
        // Fit the FIRST case band, not the whole corpus: with seven columns a
        // full fit lands near 0.20, where a socket is a couple of pixels and
        // nothing is legible. One band is a real starting place — the user pans
        // to the rest.
        const firstBand = graph.cases[0];
        const bandNodes = firstBand
          ? editor
              .getNodes()
              .filter(
                n =>
                  n.id === firstBand.key ||
                  graph.caseOfFiling.get(n.id) === firstBand.key ||
                  n.id === `unfiled:${firstBand.id}`,
              )
          : [];
        await AreaExtensions.zoomAt(area, bandNodes.length > 0 ? bandNodes : editor.getNodes());
        if (editMode && area.area.transform.k < MIN_EDIT_ZOOM) {
          await area.area.zoom(MIN_EDIT_ZOOM, 0, 0);
        }
      }
      setZoom(area.area.transform.k);
    })();

    return () => {
      disposed = true;
      tearingDown = true;
      // Only a canvas that finished building has a viewport worth restoring —
      // capturing the default transform of a half-built one (React's dev
      // double-mount) would defeat the initial fit.
      const t = layoutSettled ? area.area?.transform : null;
      if (t) transformRef.current = { x: t.x, y: t.y, k: t.k };
      areaRef.current = null;
      nodesRef.current = new Map();
      paintedRef.current = new Map();
      // Deferred so an addNode already past its `disposed` check can land
      // first. `editor.clear()` removes every node THROUGH the pipeline, which
      // is what makes rete-react-plugin unmount the per-node React roots it
      // created — destroy() + a bare DOM wipe detached the DOM but leaked one
      // root per node per rebuild. Removing only this mount's holder (never
      // the shared container) is what keeps the next mount's canvas alive.
      queueMicrotask(() => {
        void (async () => {
          try { await editor.clear(); } catch { /* noop */ }
          try { await area.destroy(); } catch { /* noop */ }
          areaHolder?.remove();
        })();
      });
    };
  }, [graph, editMode]);

  // Paint state: diff against what's on screen, repaint only what changed.
  const selectionSignal = props.mode === 'edit' ? props.activeKey : props.selected;

  // Selection is the third thing that can reveal an edge (#91). It lives in the
  // tab's own store — the cascade in filtering, the active block in the editor —
  // so the canvas mirrors it into the store edges subscribe to. Case keys are
  // included: selecting a case reveals its whole fan, which is the point.
  useEffect(() => {
    const current = propsRef.current;
    setSelectedBlocks(
      current.mode === 'edit'
        ? new Set(current.activeKey ? [current.activeKey] : [])
        : new Set(current.selected),
    );
  }, [selectionSignal]);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    for (const [id, node] of nodesRef.current) {
      const state = blockState(graph, propsRef.current, node.payload.kind, id);
      if (paintedRef.current.get(id) === state) continue;
      paintedRef.current.set(id, state);
      node.isSelected = state === 'selected';
      node.isPartial = state === 'partial';
      node.isActive = state === 'active';
      void area.update('node', id);
    }
  }, [selectionSignal, graph]);

  // A vetoed drop never reaches `connectiondrop`, so the pointer itself is what
  // reliably ends a drag. Capture phase: the plugin stops propagation on a
  // socket it accepts.
  useEffect(() => {
    if (!editMode) return;
    const clear = (event: PointerEvent) => {
      // The plugin only proposes a connection when the release lands on a
      // SOCKET, and a socket circle is 7px at corpus zoom on one edge of the
      // block — so letting go on the target block itself did nothing at all
      // (#93). The whole block is the drop target; `resolveDrop` asks the same
      // `planLink` the socket path obeys, and defers when the plugin has it.
      const drag = currentDrag();
      const current = propsRef.current;
      if (drag.active && current.mode === 'edit') {
        const outcome = resolveDrop({
          graph,
          drag,
          stack: document.elementsFromPoint(event.clientX, event.clientY),
        });
        if (outcome.type === 'commit') {
          void current.onConnect(outcome.sourceKey, outcome.targetKey, outcome.slot);
        } else if (outcome.type === 'refuse') {
          current.onRefuse?.(outcome.reason);
        }
      }
      endDrag();
      // A refused drop leaves ClassicFlow holding the picked socket, so the
      // wire keeps following the cursor until the user clicks somewhere empty.
      // Deferred: the plugin's own pointerup runs in the bubble phase and must
      // get its chance to accept a valid drop first.
      setTimeout(() => connectionRef.current?.drop(), 0);
    };
    window.addEventListener('pointerup', clear, true);
    window.addEventListener('pointercancel', clear, true);
    return () => {
      window.removeEventListener('pointerup', clear, true);
      window.removeEventListener('pointercancel', clear, true);
      endDrag();
    };
  }, [editMode, graph]);

  // A click that hit no block is the "nothing selected" gesture — until now the
  // editor had no way at all to close the tag panel. Panning is the same
  // pointer on the same element, so the press has to be remembered and a click
  // that travelled is read as a pan, not a deselect.
  const handleBackgroundClick = (event: ReactMouseEvent) => {
    const start = pointerDownRef.current;
    pointerDownRef.current = null;
    if (marqueeConsumedRef.current) {
      marqueeConsumedRef.current = false;
      return;
    }
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
    // A link drag that misses its target releases over background, and the
    // browser then fires the click on the common ancestor — the canvas. Reading
    // that as "deselect" would close the tag panel every time a drop is refused.
    if (start && !start.onBackground) return;
    // Blocks and edges handle their own clicks; only what falls between them
    // counts as background.
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[data-block-id],[data-edge-kind]')) return;
    // A pinned line SURVIVES this (#75): the user asked for it explicitly and
    // takes it away explicitly, through "Hide links". Only the selection goes.
    propsRef.current.onBackgroundClick?.();
  };

  // The press has to be caught in the CAPTURE phase: rete's area owns dragging
  // and stops `pointerdown` propagating, so a React `onPointerDown` on this
  // wrapper never fires — and a pan with no recorded start reads as a click,
  // which would wipe the selection on every drag of the background.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const down = (event: PointerEvent) => {
      // Left button only. A right-click that opens a menu must not be
      // remembered as the start of a click that could later deselect.
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      pointerDownRef.current = {
        x: event.clientX,
        y: event.clientY,
        onBackground: !target?.closest?.('[data-block-id]'),
      };
    };
    wrapper.addEventListener('pointerdown', down, true);
    return () => wrapper.removeEventListener('pointerdown', down, true);
  }, []);

  // Escape drops a pinned line. Cheap to own here: the canvas is the only
  // thing that pins, and the key has no other meaning while it is focused.
  useEffect(() => {
    // Escape used to drop the pin. It no longer does (#75) — a pinned line is
    // a deliberate state with a deliberate way out, and Escape is already
    // spoken for by menus, the picker and a pending link.
    return () => {};
  }, []);

  // Right-click, resolved to what it hit. The host gets a discriminated target
  // rather than an event, so no menu code ever reads the canvas DOM.
  const handleContextMenu = (event: ReactMouseEvent) => {
    const current = propsRef.current;
    if (current.mode !== 'edit' || !current.onContextMenu) return;
    event.preventDefault();
    // Guard: a right-click during a link drag means "cancel", exactly as
    // Escape does — not "open a menu about whatever is under the cursor".
    if (currentDrag().active) {
      endDrag();
      connectionRef.current?.drop();
      return;
    }
    const el = event.target as HTMLElement | null;
    const at = { x: event.clientX, y: event.clientY };
    // A line is not inside a block, so it is asked about first.
    const edgeEl = el?.closest?.('[data-edge-id]') as HTMLElement | null;
    const edgeId = edgeEl?.getAttribute('data-edge-id');
    if (edgeId) {
      current.onContextMenu({ kind: 'edge', edgeId }, at);
      return;
    }
    const blockEl = el?.closest?.('[data-block-id]') as HTMLElement | null;
    const blockKey = blockEl?.getAttribute('data-block-id') ?? null;
    const badge = el?.closest?.('[data-link-badge]') as HTMLElement | null;
    const badgeId = badge?.getAttribute('data-link-badge') ?? null;
    const slotEl = el?.closest?.('[data-slot]') as HTMLElement | null;
    const slot = slotEl?.getAttribute('data-slot') ?? null;

    if (!blockKey) {
      current.onContextMenu({ kind: 'background' }, at);
      return;
    }
    // Narrowest first: a badge lives inside a slot, which lives inside a block.
    if (badgeId && badgeId !== 'inbound') {
      current.onContextMenu({ kind: 'badge', edgeId: badgeId, blockKey }, at);
    } else if (slot === 'id' || badgeId === 'inbound') {
      current.onContextMenu({ kind: 'idTag', blockKey }, at);
    } else if (slot) {
      current.onContextMenu({ kind: 'slot', slot, blockKey }, at);
    } else {
      current.onContextMenu({ kind: 'block', blockKey }, at);
    }
  };

  // The imperative handle. Published once per build, because the area it drives
  // is created there.
  useEffect(() => {
    const current = propsRef.current;
    if (current.mode !== 'edit' || !current.onReady) return;
    current.onReady({
      centerOn: (key: EntityKey) => {
        const area = areaRef.current;
        const box = graph.boxes.get(key);
        if (!area || !box) return;
        // Read the block's centre and put it in the middle of the viewport at a
        // zoom where its handles are aimable — the same floor the initial fit
        // uses, so "go to" never lands somewhere unusable.
        const k = Math.max(area.area.transform.k, MIN_EDIT_ZOOM);
        const rect = area.container.getBoundingClientRect();
        void (async () => {
          await area.area.zoom(k, 0, 0);
          await area.area.translate(
            rect.width / 2 - (box.x + box.w / 2) * k,
            rect.height / 2 - (box.y + box.h / 2) * k,
          );
        })();
      },
    });
  }, [graph]);

  // The marquee attaches to the container element, which outlives any single
  // rete mount, and reads the area through a ref — so switching tools never
  // rebuilds the canvas.
  useEffect(() => {
    const container = containerRef.current;
    const overlay = marqueeLayerRef.current;
    if (!container || !overlay) return;
    return setupMarquee({
      container,
      overlay,
      transform: () => areaRef.current?.area.transform ?? { x: 0, y: 0, k: 1 },
      boxes: () => graph.boxes,
      enabled: () => {
        const current = propsRef.current;
        return current.mode === 'filter' && current.tool === 'marquee' && !!current.onMarquee;
      },
      // A link drag owns the pointer while it is in flight.
      blocked: () => currentDrag().active,
      onSelect: result => {
        const current = propsRef.current;
        if (current.mode !== 'filter') return;
        // The gesture ends in a click on the wrapper, which would otherwise
        // read as "clicked nothing" and clear what the marquee just selected.
        // A flag, not a second distance threshold: two thresholds owning one
        // boundary is how a 3px drag both selects and clears.
        marqueeConsumedRef.current = true;
        current.onMarquee?.(result);
      },
    });
  }, [graph]);

  // Column chrome is plain DOM over the canvas, positioned from the transform
  // subscription rather than re-rendered.
  useEffect(() => {
    const layer = overlayRef.current;
    if (!layer) return;
    const unmountColumns = mountColumnHeaders(layer);
    const unmountBands = mountBandRules(layer, graph);
    return () => {
      unmountBands();
      unmountColumns();
    };
  }, [graph]);

  return (
    // The rete container keeps its own element: teardown removes exactly the
    // holder rete appended to it, so the overlay is a SIBLING, never a parent.
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden"
      onClick={handleBackgroundClick}
      onContextMenu={handleContextMenu}
    >
      <div ref={containerRef} className="h-full w-full" />
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 z-10"
        data-canvas-chrome="columns"
      />
      {/* The rubber band gets its own layer: the column chrome owns the
          contents of its own, and teardown there must not take the band. */}
      <div
        ref={marqueeLayerRef}
        className="pointer-events-none absolute inset-0 z-20"
        data-canvas-chrome="marquee-layer"
      />
    </div>
  );
}

/**
 * How loudly an edge draws itself.
 *
 * Containment is ~82 of ~90 edges and, since kind columns, fans from every
 * column back to the case block — it buries the ref chains that are the point
 * of the canvas. So it hides by default and reveals exactly when it is the
 * thing being worked on: while a caseRef link is being dragged, or while one of
 * its own blocks is hovered. Filtering never shows it — nothing is authored
 * there, and the band already says which case owns what.
 *
 * Ref edges stay drawn, and fade when the pointer is on some other block, so
 * the hovered filing's own chain is what stands out.
 */
function EdgeLayer({
  isContains,
  endpoints,
  editMode,
  props,
}: {
  isContains: boolean;
  endpoints: string[];
  editMode: boolean;
  props: { data: BlockConnection };
}) {
  const drag = useDragState();
  const hovered = useHovered();
  const pinned = usePinned();
  const selected = useSelectedBlocks();
  const showAll = useShowAllLinks();

  // The decision lives in `edgeVisibility` — four reveal sources with a stated
  // precedence, testable without a canvas.
  const shown = edgeVisibility({
    isContains,
    endpoints,
    editMode,
    hovered,
    pinned,
    selected,
    showAll,
    draggingCaseRef: drag.active && drag.slot === 'caseRef',
  });
  if (!shown.visible) return null;

  return (
    <div
      style={{ opacity: shown.opacity }}
      // Only a deliberately revealed line takes the pointer, and only along its
      // stroke — so an edge can be right-clicked and deleted (#75/#91) without
      // swallowing clicks meant for the blocks beneath it.
      className={shown.interactive ? '[&_path]:[pointer-events:stroke]' : undefined}
      data-edge-kind={isContains ? 'contains' : 'ref'}
      data-edge-id={props.data.id}
      data-edge-state={shown.state}
    >
      <Presets.classic.Connection {...props} />
    </div>
  );
}

/**
 * A connection drag handle. Only editor mode renders these; `stopPropagation`
 * keeps a drag from also toggling the block underneath.
 */
function SocketHandle({
  node,
  side,
  socketKey,
  emit,
}: {
  node: BlockNode;
  side: 'input' | 'output';
  socketKey: string;
  emit: (props: ReactArea2D<Schemes>) => void;
}) {
  // An output handle is typed by the slot it writes; the input hub is typed by
  // the block's own kind, which is what a source slot checks against.
  const payload = side === 'output' && socketKey !== 'out'
    ? socketFor(socketKey)
    : socketFor(node.entityKind);
  return (
    <div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      <Presets.classic.RefSocket
        name={`${side}-socket`}
        side={side}
        emit={emit}
        socketKey={socketKey}
        nodeId={node.id}
        payload={payload}
      />
    </div>
  );
}
