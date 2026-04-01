'use client';

import { useEffect, useRef, useState } from 'react';

interface TOCContextMenuProps {
  x: number;
  y: number;
  attrs: {
    tocStyle: string;
    showNumbers: boolean;
    maxDepth: number;
  };
  onClose: () => void;
  onUpdateAttrs: (attrs: Partial<{ tocStyle: string; showNumbers: boolean; maxDepth: number }>) => void;
  onRemove: () => void;
}

const styles = [
  { value: 'default', label: 'Default' },
  { value: 'formal', label: 'Formal' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'dotted', label: 'Dotted (Legal)' },
  { value: 'boxed', label: 'Boxed' },
] as const;

const depths = [
  { value: 1, label: 'H1 Only' },
  { value: 2, label: 'H1 + H2' },
  { value: 3, label: 'H1 + H2 + H3' },
] as const;

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export function TOCContextMenu({ x, y, attrs, onClose, onUpdateAttrs, onRemove }: TOCContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<'style' | 'depth' | null>(null);
  const [styleSubmenuFlip, setStyleSubmenuFlip] = useState(false);
  const [depthSubmenuFlip, setDepthSubmenuFlip] = useState(false);
  const styleSubmenuRef = useRef<HTMLDivElement>(null);
  const depthSubmenuRef = useRef<HTMLDivElement>(null);

  // Close on click outside, escape, scroll
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = () => onClose();

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose]);

  // Viewport flip for main menu
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) menuRef.current.style.left = `${x - rect.width}px`;
    if (rect.bottom > vh) menuRef.current.style.top = `${y - rect.height}px`;
  }, [x, y]);

  // Viewport flip for style submenu
  useEffect(() => {
    if (openSubmenu !== 'style' || !styleSubmenuRef.current || !menuRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const subRect = styleSubmenuRef.current.getBoundingClientRect();
    setStyleSubmenuFlip(menuRect.right + subRect.width > window.innerWidth);
  }, [openSubmenu]);

  // Viewport flip for depth submenu
  useEffect(() => {
    if (openSubmenu !== 'depth' || !depthSubmenuRef.current || !menuRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const subRect = depthSubmenuRef.current.getBoundingClientRect();
    setDepthSubmenuFlip(menuRect.right + subRect.width > window.innerWidth);
  }, [openSubmenu]);

  const itemBase = 'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2';
  const enabledClass = 'text-gray-700 hover:bg-blue-50';

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[200px]"
      style={{ left: x, top: y }}
    >
      {/* Style submenu */}
      <div
        className="relative"
        onMouseEnter={() => setOpenSubmenu('style')}
        onMouseLeave={() => setOpenSubmenu((prev) => (prev === 'style' ? null : prev))}
      >
        <button className={`${itemBase} ${enabledClass} justify-between`}>
          <span className="flex items-center gap-2">
            {/* Palette icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" />
              <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" />
              <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" />
              <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" />
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
            </svg>
            Style
          </span>
          <ChevronRight />
        </button>

        {openSubmenu === 'style' && (
          <div
            ref={styleSubmenuRef}
            className={`absolute top-0 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[160px] ${
              styleSubmenuFlip ? 'right-full mr-1' : 'left-full ml-1'
            }`}
          >
            {styles.map((s) => {
              const isActive = attrs.tocStyle === s.value;
              return (
                <button
                  key={s.value}
                  className={`${itemBase} ${enabledClass} ${isActive ? 'bg-blue-50 font-medium' : ''} justify-between`}
                  onClick={() => {
                    onUpdateAttrs({ tocStyle: s.value });
                    onClose();
                  }}
                >
                  <span>{s.label}</span>
                  {isActive && <CheckIcon />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Numbering toggle */}
      <button
        className={`${itemBase} ${enabledClass} justify-between`}
        onClick={() => {
          onUpdateAttrs({ showNumbers: !attrs.showNumbers });
          onClose();
        }}
      >
        <span className="flex items-center gap-2">
          {/* Hash icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
            <line x1="10" y1="3" x2="8" y2="21" />
            <line x1="16" y1="3" x2="14" y2="21" />
          </svg>
          Show Numbers
        </span>
        {attrs.showNumbers && <CheckIcon />}
      </button>

      {/* Depth submenu */}
      <div
        className="relative"
        onMouseEnter={() => setOpenSubmenu('depth')}
        onMouseLeave={() => setOpenSubmenu((prev) => (prev === 'depth' ? null : prev))}
      >
        <button className={`${itemBase} ${enabledClass} justify-between`}>
          <span className="flex items-center gap-2">
            {/* Layers icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            Depth
          </span>
          <ChevronRight />
        </button>

        {openSubmenu === 'depth' && (
          <div
            ref={depthSubmenuRef}
            className={`absolute top-0 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[160px] ${
              depthSubmenuFlip ? 'right-full mr-1' : 'left-full ml-1'
            }`}
          >
            {depths.map((d) => {
              const isActive = attrs.maxDepth === d.value;
              return (
                <button
                  key={d.value}
                  className={`${itemBase} ${enabledClass} ${isActive ? 'bg-blue-50 font-medium' : ''} justify-between`}
                  onClick={() => {
                    onUpdateAttrs({ maxDepth: d.value });
                    onClose();
                  }}
                >
                  <span>{d.label}</span>
                  {isActive && <CheckIcon />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Separator */}
      <div className="border-t border-gray-100 my-1" />

      {/* Refresh */}
      <button
        className={`${itemBase} ${enabledClass}`}
        onClick={onClose}
      >
        {/* Refresh icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
        Refresh
      </button>

      {/* Remove */}
      <button
        className={`${itemBase} text-red-600 hover:bg-red-50`}
        onClick={() => {
          onRemove();
          onClose();
        }}
      >
        {/* Trash icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
        Remove
      </button>
    </div>
  );
}
