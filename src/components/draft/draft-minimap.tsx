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

const DraftMinimap: React.FC<MinimapProps> = ({ editorHtml, scrollContainer }) => {
  const minimapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartScrollTopRef = useRef(0);

  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  // Sync minimap scroll position with editor + update viewport indicator
  const syncScroll = useCallback(() => {
    if (!scrollContainer || !minimapRef.current) return;

    const editor = scrollContainer;
    const minimap = minimapRef.current;

    // Proportionally scroll the minimap to match the editor's position
    const editorMaxScroll = editor.scrollHeight - editor.clientHeight;
    const minimapMaxScroll = minimap.scrollHeight - minimap.clientHeight;

    if (editorMaxScroll > 0 && minimapMaxScroll > 0) {
      const ratio = editor.scrollTop / editorMaxScroll;
      minimap.scrollTop = ratio * minimapMaxScroll;
    }

    // Viewport indicator: shows which part of the editor is visible
    // Map editor coordinates to minimap coordinates
    const contentScale = minimap.scrollHeight / editor.scrollHeight;
    const vpTopInContent = editor.scrollTop * contentScale;
    const vpHeightInContent = editor.clientHeight * contentScale;

    // Position relative to minimap's visible area
    const vpTop = vpTopInContent - minimap.scrollTop;

    setViewport({ top: vpTop, height: Math.max(vpHeightInContent, 4) });
  }, [scrollContainer]);

  useEffect(() => {
    if (!scrollContainer) return;
    syncScroll();
    scrollContainer.addEventListener('scroll', syncScroll, { passive: true });
    window.addEventListener('resize', syncScroll);
    return () => {
      scrollContainer.removeEventListener('scroll', syncScroll);
      window.removeEventListener('resize', syncScroll);
    };
  }, [scrollContainer, syncScroll]);

  // Re-sync when content changes
  useEffect(() => {
    const timer = setTimeout(syncScroll, 100);
    return () => clearTimeout(timer);
  }, [editorHtml, syncScroll]);

  // Click on minimap → jump editor to that position
  const scrollToPosition = useCallback(
    (clickY: number) => {
      if (!scrollContainer || !minimapRef.current) return;
      const minimap = minimapRef.current;
      const rect = minimap.getBoundingClientRect();

      // Click position in minimap content coordinates
      const clickInContent = (clickY - rect.top) + minimap.scrollTop;
      const contentScale = minimap.scrollHeight / scrollContainer.scrollHeight;

      if (contentScale <= 0) return;

      // Map back to editor coordinates
      const editorPos = clickInContent / contentScale;
      scrollContainer.scrollTop = editorPos - scrollContainer.clientHeight / 2;
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

  // Drag viewport indicator
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
        const minimap = minimapRef.current;
        const contentScale = minimap.scrollHeight / scrollContainer.scrollHeight;
        if (contentScale <= 0) return;

        // Convert minimap pixel delta to editor scroll delta
        const editorDelta = deltaY / contentScale;
        scrollContainer.scrollTop = dragStartScrollTopRef.current + editorDelta;
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
      className="relative w-full h-full bg-gray-50 cursor-pointer minimap-scroll"
      onClick={handleClick}
    >
      {/* Hide scrollbar but allow programmatic scroll */}
      <style>{`
        .minimap-scroll {
          overflow-y: scroll;
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
        .minimap-scroll::-webkit-scrollbar {
          display: none;
        }
      `}</style>

      {/* Content at fixed 8% zoom */}
      <div
        ref={contentRef}
        className="pointer-events-none select-none origin-top-left prose prose-sm max-w-none"
        style={{
          zoom: 0.08,
          width: '816px',
          padding: '96px',
          fontFamily: 'Times New Roman, serif',
          fontSize: '12px',
          lineHeight: '1.5',
          background: 'white',
        }}
        dangerouslySetInnerHTML={{ __html: sanitizeForMinimap(editorHtml) }}
      />

      {/* Viewport indicator — positioned relative to visible minimap area */}
      <div
        className="sticky left-0 right-0 bg-blue-400/20 border-y border-blue-400/40 cursor-grab active:cursor-grabbing pointer-events-auto"
        style={{
          top: `${viewport.top}px`,
          height: `${viewport.height}px`,
          position: 'absolute',
        }}
        onMouseDown={handleViewportMouseDown}
      />
    </div>
  );
};

export default React.memo(DraftMinimap);
