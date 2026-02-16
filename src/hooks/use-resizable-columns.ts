'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { getPreference, setPreference } from '@/lib/indexed-db';

export interface ColumnWidths {
  left: number;
  right: number;
}

const DEFAULTS: ColumnWidths = { left: 176, right: 288 };
const LIMITS = {
  left: { min: 140, max: 280 },
  right: { min: 200, max: 400 },
};
const PERSIST_KEY = 'search.columnWidths';

export function useResizableColumns() {
  const [widths, setWidths] = useState<ColumnWidths>(DEFAULTS);
  const initialized = useRef(false);

  // Load persisted widths on mount
  useEffect(() => {
    getPreference<ColumnWidths>(PERSIST_KEY)
      .then(stored => {
        if (stored) setWidths(stored);
        initialized.current = true;
      })
      .catch(() => { initialized.current = true; });
  }, []);

  // Persist after change
  const persist = useCallback((w: ColumnWidths) => {
    if (initialized.current) setPreference(PERSIST_KEY, w).catch(() => {});
  }, []);

  const startResize = useCallback(
    (side: 'left' | 'right', startX: number) => {
      const startWidth = side === 'left' ? widths.left : widths.right;
      const { min, max } = LIMITS[side];
      // For the right sidebar, dragging left increases width
      const direction = side === 'right' ? -1 : 1;

      const onMouseMove = (e: MouseEvent) => {
        const delta = (e.clientX - startX) * direction;
        const newWidth = Math.max(min, Math.min(max, startWidth + delta));
        setWidths(prev => {
          const next = { ...prev, [side]: newWidth };
          return next;
        });
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Persist final value
        setWidths(prev => {
          persist(prev);
          return prev;
        });
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [widths, persist],
  );

  return { widths, startResize };
}
