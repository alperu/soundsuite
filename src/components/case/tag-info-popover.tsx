'use client';

/**
 * TagInfoPopover — click-to-open rich info popup for the "?" icon on each
 * tag row in the right-edge tag panel.
 *
 * Replaces the static `title=` browser tooltip with a structured, readable
 * panel that explains what each tag is, how it`s derived, where it persists
 * (Prisma column / tags JSON path), and where it maps in the XETO spec.
 *
 * Falls back to the 1-line `spec.doc` text when `spec.info` is undefined,
 * so every tag still surfaces something useful.
 *
 * Positioning: reuses `pickAnchor` (popup-anchor.ts) so the popover flips
 * to the left or up when it would otherwise fall off the viewport edge —
 * essential since the tag panel sits flush against the right edge of the
 * case-management layout.
 *
 * Related-tags chips: when the user clicks a related-tag chip, we look it
 * up in the supplied `specsForRelated` list and swap the popover content
 * in-place. Unknown names render as inert text (no error).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { pickAnchor } from './popup-anchor';
import type { TagSpec, TagTier } from './tag-spec';

const POPOVER_W = 360;
const POPOVER_MAX_H = 480;

interface Pos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  centered: boolean;
}

function computePos(anchorRect: DOMRect | null | undefined): Pos {
  if (typeof window === 'undefined') {
    return { top: 0, left: 0, width: POPOVER_W, maxHeight: POPOVER_MAX_H, centered: false };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Narrow viewport — center modal-style.
  if (!anchorRect || vw < 480) {
    return {
      top: Math.max(16, (vh - POPOVER_MAX_H) / 2),
      left: Math.max(8, (vw - Math.min(POPOVER_W, vw - 16)) / 2),
      width: Math.min(POPOVER_W, vw - 16),
      maxHeight: Math.min(POPOVER_MAX_H, vh - 32),
      centered: true,
    };
  }
  const anchor = pickAnchor(anchorRect, POPOVER_W, POPOVER_MAX_H);
  const spaceBelow = vh - anchorRect.bottom;
  const spaceAbove = anchorRect.top;
  const flipUp = anchor.vertical === 'above';
  const maxHeight = Math.min(
    POPOVER_MAX_H,
    Math.max(160, flipUp ? spaceAbove - 12 : spaceBelow - 12),
  );
  const top = flipUp
    ? Math.max(8, anchorRect.top - maxHeight - 4)
    : anchorRect.bottom + 4;
  let left =
    anchor.horizontal === 'left'
      ? anchorRect.left
      : anchorRect.right - POPOVER_W;
  if (left + POPOVER_W > vw - 8) left = vw - POPOVER_W - 8;
  if (left < 8) left = 8;
  return { top, left, width: POPOVER_W, maxHeight, centered: false };
}

const TIER_BADGE_STYLES: Record<TagTier, string> = {
  marker: 'bg-blue-50 text-blue-700 border-blue-200',
  ref: 'bg-violet-50 text-violet-700 border-violet-200',
  refs: 'bg-violet-50 text-violet-700 border-violet-200',
  value: 'bg-slate-50 text-slate-700 border-slate-200',
};

const TIER_LABEL_SHORT: Record<TagTier, string> = {
  marker: 'marker',
  ref: 'ref',
  refs: 'refs',
  value: 'value',
};

export interface TagInfoPopoverProps {
  /** Whether the popover is open. */
  open: boolean;
  /**
   * The tag spec to render. May be `null` while the popover is closing —
   * the component renders nothing when `open` is false anyway.
   */
  spec: TagSpec | null;
  /** Bounding rect of the trigger button — used for placement. */
  anchorRect: DOMRect | null;
  /** Close callback (click-outside or Esc). */
  onClose(): void;
  /**
   * Spec list to resolve related-tag chips. Pass the same `visibleSpecs`
   * the tag panel renders. If a related name isn't found, the chip renders
   * as inert text.
   */
  specsForRelated?: TagSpec[];
}

export function TagInfoPopover({
  open,
  spec: initialSpec,
  anchorRect,
  onClose,
  specsForRelated,
}: TagInfoPopoverProps) {
  // Local state so clicking a related-tag chip can swap the displayed spec
  // without moving the popover off its anchor.
  const [shownSpec, setShownSpec] = useState<TagSpec | null>(initialSpec);
  const popRef = useRef<HTMLDivElement | null>(null);

  // When the parent passes a new spec (a different "?" was clicked), reset.
  useEffect(() => {
    setShownSpec(initialSpec);
  }, [initialSpec]);

  // Bump on window resize so positioning recomputes.
  const [resizeTick, setResizeTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const onResize = () => setResizeTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  const pos = useMemo(
    () => computePos(anchorRect ?? null),
    // resizeTick is intentional — its only purpose is to invalidate the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchorRect, resizeTick],
  );

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!popRef.current) return;
      if (e.target instanceof Node && !popRef.current.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onClose]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onRelatedClick = useCallback(
    (name: string) => {
      if (!specsForRelated) return;
      const next = specsForRelated.find((s) => s.name === name);
      if (next) setShownSpec(next);
    },
    [specsForRelated],
  );

  if (!open || !shownSpec) return null;

  const info = shownSpec.info;
  const description = info?.whatItIs ?? shownSpec.doc;
  const tierLabel = TIER_LABEL_SHORT[shownSpec.tier];
  const tierBadge = TIER_BADGE_STYLES[shownSpec.tier];

  const style: React.CSSProperties = {
    position: 'fixed',
    top: pos.top,
    left: pos.left,
    width: pos.width,
    maxHeight: pos.maxHeight,
    zIndex: 60,
  };

  return (
    <div
      ref={popRef}
      style={style}
      role="dialog"
      aria-label={`Tag info: ${shownSpec.name}`}
      className="bg-white border border-gray-200 rounded-lg shadow-lg flex flex-col overflow-hidden text-gray-800"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-gradient-to-b from-slate-50 to-white">
        <InfoBubbleIcon />
        <span className="font-mono text-[13px] font-semibold text-slate-900 truncate flex-1">
          {shownSpec.name}
        </span>
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider border ${tierBadge}`}
        >
          {tierLabel}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="p-0.5 text-gray-400 hover:text-gray-700 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5 text-[12px] leading-snug">
        {/* What it is */}
        <Section title="What it is">
          <p className="text-slate-700">{description}</p>
        </Section>

        {info?.howItWorks && (
          <Section title="How it works">
            <p className="text-slate-700 whitespace-pre-line">{info.howItWorks}</p>
          </Section>
        )}

        {info?.mapsTo && (
          <Section title="Where it maps">
            <code className="block px-2 py-1 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-800 font-mono break-all">
              {info.mapsTo}
            </code>
          </Section>
        )}

        {info?.xetoSpec && (
          <Section title="XETO spec">
            <code className="block px-2 py-1 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-800 font-mono break-all">
              {info.xetoSpec}
            </code>
          </Section>
        )}

        {info?.example && (
          <Section title="Example">
            <code className="block px-2 py-1 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-800 font-mono break-all">
              {info.example}
            </code>
          </Section>
        )}

        {info?.relatedTags && info.relatedTags.length > 0 && (
          <Section title="Related tags">
            <div className="flex flex-wrap gap-1">
              {info.relatedTags.map((name) => {
                const found = specsForRelated?.some((s) => s.name === name);
                if (found) {
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => onRelatedClick(name)}
                      className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors"
                    >
                      {name}
                    </button>
                  );
                }
                return (
                  <span
                    key={name}
                    title="Tag not in current entity"
                    className="px-1.5 py-0.5 rounded text-[11px] font-mono bg-slate-50 text-slate-500 border border-slate-200"
                  >
                    {name}
                  </span>
                );
              })}
            </div>
          </Section>
        )}

        {!info && (
          <p className="text-[11px] text-slate-400 italic">
            Detailed info not yet documented for this tag.
          </p>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoBubbleIcon() {
  return (
    <svg
      className="w-4 h-4 text-blue-500 flex-shrink-0"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle cx={12} cy={12} r={9} strokeWidth={1.5} />
      <path strokeLinecap="round" strokeWidth={1.5} d="M12 8h.01" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 12h1v5h1" />
    </svg>
  );
}
