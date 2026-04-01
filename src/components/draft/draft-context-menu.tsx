'use client';

import { useEffect, useRef, useState } from 'react';

interface DraftContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onAction: (action: string, options?: { tone?: string }) => void;
  hasSelection: boolean;
}

const tones = ['Formal', 'Persuasive', 'Neutral', 'Aggressive', 'Sympathetic'] as const;

export function DraftContextMenu({ x, y, onClose, onAction, hasSelection }: DraftContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [submenuFlipLeft, setSubmenuFlipLeft] = useState(false);
  const submenuRef = useRef<HTMLDivElement>(null);
  const toneItemRef = useRef<HTMLDivElement>(null);

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

  // Viewport flip for submenu
  useEffect(() => {
    if (!submenuOpen || !submenuRef.current || !menuRef.current) return;
    const menuRect = menuRef.current.getBoundingClientRect();
    const subRect = submenuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    setSubmenuFlipLeft(menuRect.right + subRect.width > vw);
  }, [submenuOpen]);

  const handleAction = (action: string, options?: { tone?: string }) => {
    onAction(action, options);
    onClose();
  };

  const handleClipboard = (command: string) => {
    document.execCommand(command);
    onClose();
  };

  const disabledClass = 'text-gray-300 pointer-events-none';
  const enabledClass = 'text-gray-700 hover:bg-blue-50';
  const itemBase = 'w-full text-left px-3 py-1.5 text-sm flex items-center gap-2';

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[200px]"
      style={{ left: x, top: y }}
    >
      {/* Adjust Tone - with submenu */}
      <div
        ref={toneItemRef}
        className="relative"
        onMouseEnter={() => hasSelection && setSubmenuOpen(true)}
        onMouseLeave={() => setSubmenuOpen(false)}
      >
        <button
          className={`${itemBase} ${hasSelection ? enabledClass : disabledClass} justify-between`}
          onClick={() => hasSelection && setSubmenuOpen(!submenuOpen)}
          disabled={!hasSelection}
        >
          <span className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
            Adjust Tone
          </span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>

        {submenuOpen && hasSelection && (
          <div
            ref={submenuRef}
            className={`absolute top-0 bg-white rounded-lg shadow-lg border border-gray-200 py-1 min-w-[150px] ${
              submenuFlipLeft ? 'right-full mr-1' : 'left-full ml-1'
            }`}
          >
            {tones.map((tone) => (
              <button
                key={tone}
                className={`${itemBase} ${enabledClass}`}
                onClick={() => handleAction('adjust_tone', { tone: tone.toLowerCase() })}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {tone === 'Formal' && <><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></>}
                  {tone === 'Persuasive' && <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>}
                  {tone === 'Neutral' && <><circle cx="12" cy="12" r="10" /><line x1="8" y1="15" x2="16" y2="15" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></>}
                  {tone === 'Aggressive' && <><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></>}
                  {tone === 'Sympathetic' && <><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></>}
                </svg>
                {tone}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Fix Spelling & Grammar */}
      <button
        className={`${itemBase} ${hasSelection ? enabledClass : disabledClass}`}
        onClick={() => handleAction('fix_grammar')}
        disabled={!hasSelection}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Fix Spelling &amp; Grammar
      </button>

      {/* Extend Text */}
      <button
        className={`${itemBase} ${hasSelection ? enabledClass : disabledClass}`}
        onClick={() => handleAction('extend')}
        disabled={!hasSelection}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <polyline points="19 12 12 19 5 12" />
        </svg>
        Extend Text
      </button>

      {/* Simplify Text */}
      <button
        className={`${itemBase} ${hasSelection ? enabledClass : disabledClass}`}
        onClick={() => handleAction('simplify')}
        disabled={!hasSelection}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="14" y2="12" />
          <line x1="4" y1="18" x2="8" y2="18" />
        </svg>
        Simplify Text
      </button>

      {/* Legalize Sentence */}
      <button
        className={`${itemBase} ${hasSelection ? enabledClass : disabledClass}`}
        onClick={() => handleAction('legalize')}
        disabled={!hasSelection}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <line x1="9" y1="9" x2="9.01" y2="9" />
          <line x1="15" y1="9" x2="15.01" y2="9" />
        </svg>
        Legalize Sentence
      </button>

      {/* Separator */}
      <div className="border-t border-gray-100 my-1" />

      {/* Cut */}
      <button
        className={`${itemBase} ${enabledClass}`}
        onClick={() => handleClipboard('cut')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="20" y1="4" x2="8.12" y2="15.88" />
          <line x1="14.47" y1="14.48" x2="20" y2="20" />
          <line x1="8.12" y1="8.12" x2="12" y2="12" />
        </svg>
        Cut
      </button>

      {/* Copy */}
      <button
        className={`${itemBase} ${enabledClass}`}
        onClick={() => handleClipboard('copy')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        Copy
      </button>

      {/* Paste */}
      <button
        className={`${itemBase} ${enabledClass}`}
        onClick={() => handleClipboard('paste')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        </svg>
        Paste
      </button>
    </div>
  );
}
