'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface MinimapProps {
  editorHtml: string;
  scrollContainer: HTMLElement | null;
}

const SCALE = 0.08;
const CONTENT_WIDTH = 816; // letter width in px

const DraftMinimap: React.FC<MinimapProps> = ({ editorHtml, scrollContainer }) => {
  const minimapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartScrollTopRef = useRef(0);
  const [scaledHeight, setScaledHeight] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  // Measure content and set wrapper height after render
  useEffect(() => {
    if (!contentRef.current) return;
    // Use RAF to let browser lay out the content first
    const raf = requestAnimationFrame(() => {
      if (contentRef.current) {
        const fullHeight = contentRef.current.scrollHeight;
        setScaledHeight(fullHeight * SCALE);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [editorHtml]);

  const updateViewport = useCallback(() => {
    if (!scrollContainer || !minimapRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const minimapHeight = minimapRef.current.clientHeight;

    if (scrollHeight <= 0 || minimapHeight <= 0) return;

    const top = (scrollTop / scrollHeight) * minimapHeight;
    const height = (clientHeight / scrollHeight) * minimapHeight;

    setViewport({ top, height: Math.max(height, 8) });
  }, [scrollContainer]);

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

  useEffect(() => {
    updateViewport();
  }, [editorHtml, updateViewport, scaledHeight]);

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

  const scaledWidth = CONTENT_WIDTH * SCALE;

  return (
    <div
      ref={minimapRef}
      className="relative bg-gray-50 cursor-pointer overflow-hidden"
      style={{ width: scaledWidth, height: '100%' }}
      onClick={handleClick}
    >
      {/* Content wrapper — clips overflow and sets correct scaled dimensions */}
      <div
        style={{
          width: scaledWidth,
          height: scaledHeight || '100%',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          ref={contentRef}
          className="pointer-events-none select-none prose prose-sm max-w-none"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transform: `scale(${SCALE})`,
            transformOrigin: 'top left',
            width: `${CONTENT_WIDTH}px`,
            padding: '96px',
            fontFamily: 'Times New Roman, serif',
            fontSize: '12px',
            lineHeight: '1.5',
            background: 'white',
          }}
          dangerouslySetInnerHTML={{ __html: editorHtml }}
        />
      </div>

      {/* Force images to fit within content width */}
      <style>{`
        .draft-minimap-content img,
        .draft-minimap-content iframe,
        .draft-minimap-content video {
          max-width: 100% !important;
          height: auto !important;
        }
      `}</style>

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
