'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface MinimapProps {
  editorHtml: string;
  scrollContainer: HTMLElement | null;
}

const DraftMinimap: React.FC<MinimapProps> = ({ editorHtml, scrollContainer }) => {
  const minimapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartScrollTopRef = useRef(0);

  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  const updateViewport = useCallback(() => {
    if (!scrollContainer || !minimapRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const minimapHeight = minimapRef.current.clientHeight;

    if (scrollHeight <= 0) return;

    const top = (scrollTop / scrollHeight) * minimapHeight;
    const height = (clientHeight / scrollHeight) * minimapHeight;

    setViewport({ top, height: Math.max(height, 8) });
  }, [scrollContainer]);

  // Listen to scroll events on the scroll container
  useEffect(() => {
    if (!scrollContainer) return;

    updateViewport();
    scrollContainer.addEventListener('scroll', updateViewport, { passive: true });
    window.addEventListener('resize', updateViewport);

    return () => {
      scrollContainer.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [scrollContainer, updateViewport]);

  // Update viewport when content changes
  useEffect(() => {
    updateViewport();
  }, [editorHtml, updateViewport]);

  const scrollToPosition = useCallback(
    (clickY: number) => {
      if (!scrollContainer || !minimapRef.current) return;

      const minimapRect = minimapRef.current.getBoundingClientRect();
      const relativeY = clickY - minimapRect.top;
      const minimapHeight = minimapRef.current.clientHeight;

      if (minimapHeight <= 0) return;

      const ratio = relativeY / minimapHeight;
      const { scrollHeight, clientHeight } = scrollContainer;
      scrollContainer.scrollTop = ratio * scrollHeight - clientHeight / 2;
    },
    [scrollContainer]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isDraggingRef.current) return;
      scrollToPosition(e.clientY);
    },
    [scrollToPosition]
  );

  const handleViewportMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      isDraggingRef.current = true;
      dragStartYRef.current = e.clientY;
      dragStartScrollTopRef.current = scrollContainer?.scrollTop ?? 0;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current || !scrollContainer || !minimapRef.current) return;

        const deltaY = moveEvent.clientY - dragStartYRef.current;
        const minimapHeight = minimapRef.current.clientHeight;
        const { scrollHeight } = scrollContainer;

        if (minimapHeight <= 0) return;

        const scrollDelta = (deltaY / minimapHeight) * scrollHeight;
        scrollContainer.scrollTop = dragStartScrollTopRef.current + scrollDelta;
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [scrollContainer]
  );

  return (
    <div
      ref={minimapRef}
      className="relative w-full h-full bg-gray-50 cursor-pointer overflow-hidden"
      onClick={handleClick}
    >
      {/* Scaled content */}
      <div
        ref={contentRef}
        className="pointer-events-none overflow-hidden select-none origin-top-left prose prose-sm max-w-none"
        style={{
          zoom: 0.06,
          width: '816px',
          padding: '96px',
          fontFamily: 'Times New Roman, serif',
          fontSize: '12px',
          lineHeight: '1.5',
          background: 'white',
        }}
        dangerouslySetInnerHTML={{ __html: editorHtml }}
      />

      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 bg-blue-400/20 border-y border-blue-400/40 cursor-grab active:cursor-grabbing"
        style={{
          top: `${viewport.top}px`,
          height: `${viewport.height}px`,
        }}
        onMouseDown={handleViewportMouseDown}
      />
    </div>
  );
};

export default React.memo(DraftMinimap);
