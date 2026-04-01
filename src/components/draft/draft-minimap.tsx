'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface MinimapProps {
  editorHtml: string;
  scrollContainer: HTMLElement | null;
}

/** Cap image sizes so they don't blow up the minimap layout */
function sanitizeForMinimap(html: string): string {
  return html.replace(
    /<img\b/gi,
    '<img style="max-width:100%!important;max-height:200px!important;height:auto!important;object-fit:contain!important;"'
  );
}

const CONTENT_WIDTH = 816;

const DraftMinimap: React.FC<MinimapProps> = ({ editorHtml, scrollContainer }) => {
  const minimapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartScrollTopRef = useRef(0);

  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [dynamicZoom, setDynamicZoom] = useState(0.08);

  // Calculate zoom so entire content fits in the minimap container height
  useEffect(() => {
    const calculate = () => {
      if (!contentRef.current || !minimapRef.current) return;

      // First render at a known zoom to measure natural content height
      contentRef.current.style.zoom = '1';
      const naturalHeight = contentRef.current.scrollHeight;
      const containerHeight = minimapRef.current.clientHeight;
      const containerWidth = minimapRef.current.clientWidth;

      if (naturalHeight <= 0 || containerHeight <= 0) {
        contentRef.current.style.zoom = String(dynamicZoom);
        return;
      }

      // Zoom to fit: content must fit both width and height of container
      const zoomByHeight = containerHeight / naturalHeight;
      const zoomByWidth = containerWidth / CONTENT_WIDTH;
      const newZoom = Math.min(zoomByHeight, zoomByWidth, 0.15); // cap at 15% max

      setDynamicZoom(newZoom);
      contentRef.current.style.zoom = String(newZoom);
    };

    // Defer to let content render first
    const raf = requestAnimationFrame(calculate);
    const timer = setTimeout(calculate, 500);
    return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
  }, [editorHtml]);

  const updateViewport = useCallback(() => {
    if (!scrollContainer || !minimapRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const minimapHeight = minimapRef.current.clientHeight;

    if (scrollHeight <= 0 || minimapHeight <= 0) return;

    const top = (scrollTop / scrollHeight) * minimapHeight;
    const height = (clientHeight / scrollHeight) * minimapHeight;

    setViewport({ top, height: Math.max(height, 4) });
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
  }, [editorHtml, updateViewport, dynamicZoom]);

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
      {/* Content scaled to fit entire document in visible minimap area */}
      <div
        ref={contentRef}
        className="pointer-events-none select-none origin-top-left prose prose-sm max-w-none"
        style={{
          zoom: dynamicZoom,
          width: `${CONTENT_WIDTH}px`,
          padding: '96px',
          fontFamily: 'Times New Roman, serif',
          fontSize: '12px',
          lineHeight: '1.5',
          background: 'white',
        }}
        dangerouslySetInnerHTML={{ __html: sanitizeForMinimap(editorHtml) }}
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
