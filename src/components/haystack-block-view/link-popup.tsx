'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The fan-in popup: what a block's id tag lists when more than one ref points
 * at it.
 *
 * A flat menu would work for one link — and for one link that IS what opens, so
 * this only appears when there is genuinely a list to read. Each row acts on
 * its own ref, because that is the unit the user thinks in and the unit our
 * undo works at; "delete all" is a separate, confirmed action rather than a row
 * that looks like the others.
 */

export interface InboundLinkRow {
  edgeId: string;
  /** The block the ref comes FROM. */
  sourceKey: string;
  sourceLabel: string;
  slot: string;
}

interface Props {
  x: number;
  y: number;
  targetLabel: string;
  rows: InboundLinkRow[];
  onGoTo: (sourceKey: string) => void;
  onDelete: (edgeId: string) => void;
  onDeleteAll: (edgeIds: string[]) => void;
  onClose: () => void;
}

export function LinkPopup({
  x,
  y,
  targetLabel,
  rows,
  onGoTo,
  onDelete,
  onDeleteAll,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    // Capture phase: the canvas also listens for Escape (to drop a pinned
    // line), and an open popup owns the key.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Keep it on screen: same problem the tag-panel pickers solve, one popup.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) el.style.left = `${x - rect.width}px`;
    if (rect.bottom > window.innerHeight) el.style.top = `${y - rect.height}px`;
  }, [x, y]);

  return (
    <div
      ref={ref}
      data-link-popup="inbound"
      className="fixed z-50 max-h-[320px] w-[300px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl"
      style={{ left: x, top: y }}
    >
      <div className="border-b border-gray-100 px-3 py-1.5">
        <div className="truncate text-[11px] font-medium text-gray-700">{targetLabel}</div>
        <div className="text-[10px] text-gray-400">{rows.length} links point here</div>
      </div>
      <div className="max-h-[220px] overflow-y-auto py-1">
        {rows.map(row => (
          <div
            key={row.edgeId}
            data-popup-row={row.edgeId}
            className="flex items-center gap-1 px-2 py-1 hover:bg-gray-50"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-gray-800">{row.sourceLabel}</div>
              <div className="text-[10px] text-gray-500">{row.slot}</div>
            </div>
            <button
              onClick={() => {
                onGoTo(row.sourceKey);
                onClose();
              }}
              className="rounded px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100"
            >
              Go to
            </button>
            <button
              onClick={() => {
                onDelete(row.edgeId);
                onClose();
              }}
              className="rounded px-1.5 py-0.5 text-[10px] text-red-600 hover:bg-red-50"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
      <div className="border-t border-gray-100 px-2 py-1">
        {confirmingAll ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-600">Delete all {rows.length}?</span>
            <button
              onClick={() => {
                onDeleteAll(rows.map(r => r.edgeId));
                onClose();
              }}
              className="rounded bg-red-600 px-2 py-0.5 text-[10px] text-white hover:bg-red-700"
            >
              Delete all
            </button>
            <button
              onClick={() => setConfirmingAll(false)}
              className="rounded px-2 py-0.5 text-[10px] text-gray-600 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingAll(true)}
            className="rounded px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50"
          >
            Delete all links…
          </button>
        )}
      </div>
    </div>
  );
}
