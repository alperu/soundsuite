'use client';

import { useCallback, useState } from 'react';

interface ResizableDividerProps {
  side: 'left' | 'right';
  onResizeStart: (side: 'left' | 'right', startX: number) => void;
}

export function ResizableDivider({ side, onResizeStart }: ResizableDividerProps) {
  const [dragging, setDragging] = useState(false);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      onResizeStart(side, e.clientX);

      const up = () => {
        setDragging(false);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mouseup', up);
    },
    [side, onResizeStart],
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`w-1 flex-shrink-0 cursor-col-resize transition-colors hover:bg-blue-400 ${
        dragging ? 'bg-blue-500' : 'bg-transparent'
      }`}
      style={{ minWidth: 4, maxWidth: 4 }}
      title="Drag to resize"
    />
  );
}
