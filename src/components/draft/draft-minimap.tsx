'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface MinimapProps {
  editorHtml: string;
  scrollContainer: HTMLElement | null;
}

/** Ensure images scale proportionally — no height cap so minimap matches editor proportions */
function sanitizeForMinimap(html: string): string {
  return html.replace(
    /<img\b([^>]*)>/gi,
    (_match, attrs) => {
      const cleaned = (attrs as string).replace(/style="[^"]*"/gi, '');
      return `<img style="max-width:100%!important;height:auto!important;" ${cleaned.trim()}>`;
    }
  );
}

const ZOOM = 0.08;

const DraftMinimap: React.FC<MinimapProps> = ({ editorHtml, scrollContainer }) => {
  const minimapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const rafRef = useRef(0);

  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  // Core sync: editor scroll → minimap scroll + viewport indicator
  const syncScroll = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      if (!scrollContainer || !minimapRef.current || !contentRef.current) return;

      const editor = scrollContainer;
      const minimap = minimapRef.current;

      // Use the ACTUAL rendered content height, not the container's scrollHeight
      // This prevents the viewport from going into empty gray space
      const contentHeight = contentRef.current.getBoundingClientRect().height;

      const E_sh = editor.scrollHeight;
      const E_ch = editor.clientHeight;
      const E_st = editor.scrollTop;
      const E_ms = E_sh - E_ch;

      const M_sh = minimap.scrollHeight;
      const M_ch = minimap.clientHeight;
      const M_ms = M_sh - M_ch;

      // 1. Proportionally scroll the minimap
      if (E_ms > 0 && M_ms > 0) {
        minimap.scrollTop = (E_st / E_ms) * M_ms;
      } else {
        minimap.scrollTop = 0;
      }

      // 2. Viewport indicator — use actual content height for scale
      // so the indicator never goes past the rendered content
      const scale = E_sh > 0 ? contentHeight / E_sh : 0;

      const vpTop = E_st * scale;
      const vpHeight = Math.max(4, E_ch * scale);

      // Clamp so indicator doesn't exceed content boundary
      const clampedTop = Math.min(vpTop, contentHeight - vpHeight);
      setViewport({ top: Math.max(0, clampedTop), height: vpHeight });
    });
  }, [scrollContainer]);

  useEffect(() => {
    if (!scrollContainer) return;
    syncScroll();
    scrollContainer.addEventListener('scroll', syncScroll, { passive: true });
    window.addEventListener('resize', syncScroll);
    return () => {
      cancelAnimationFrame(rafRef.current);
      scrollContainer.removeEventListener('scroll', syncScroll);
      window.removeEventListener('resize', syncScroll);
    };
  }, [scrollContainer, syncScroll]);

  useEffect(() => {
    const timer = setTimeout(syncScroll, 150);
    return () => clearTimeout(timer);
  }, [editorHtml, syncScroll]);

  // Click on minimap → jump editor to that position
  const jumpEditorTo = useCallback(
    (clientY: number) => {
      if (!scrollContainer || !minimapRef.current || !contentRef.current) return;
      const minimap = minimapRef.current;
      const rect = minimap.getBoundingClientRect();
      const contentHeight = contentRef.current.getBoundingClientRect().height;

      // Click position in minimap content coordinates
      const clickInContent = (clientY - rect.top) + minimap.scrollTop;
      const scale = contentHeight / scrollContainer.scrollHeight;
      if (scale <= 0) return;

      // Map to editor content position, center viewport there
      const editorPos = clickInContent / scale;
      scrollContainer.scrollTop = editorPos - scrollContainer.clientHeight / 2;
    },
    [scrollContainer]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isDraggingRef.current) return;
      jumpEditorTo(e.clientY);
    },
    [jumpEditorTo]
  );

  // Drag viewport indicator — position-based (not delta-based)
  const handleViewportMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      isDraggingRef.current = true;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return;
        jumpEditorTo(moveEvent.clientY);
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        syncScroll();
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [jumpEditorTo, syncScroll]
  );

  return (
    <div
      ref={minimapRef}
      className="relative w-full h-full bg-gray-50 cursor-pointer minimap-hide-scrollbar"
      onClick={handleClick}
    >
      <style>{`
        .minimap-hide-scrollbar {
          overflow-y: scroll;
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
        .minimap-hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>

      {/* Content clone at 8% zoom */}
      <div
        ref={contentRef}
        className="pointer-events-none select-none origin-top-left prose prose-sm max-w-none"
        style={{
          zoom: ZOOM,
          width: '816px',
          padding: '96px',
          fontFamily: 'Times New Roman, serif',
          fontSize: '12px',
          lineHeight: '1.5',
          background: 'white',
        }}
        dangerouslySetInnerHTML={{ __html: sanitizeForMinimap(editorHtml) }}
      />

      {/* Viewport indicator — absolute inside scrollable parent = content coordinates */}
      <div
        className="absolute left-0 right-0 bg-blue-400/20 border-y-2 border-blue-400/50 cursor-grab active:cursor-grabbing pointer-events-auto"
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
