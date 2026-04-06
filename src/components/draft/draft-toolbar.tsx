'use client';

import React, { useRef, useState, useEffect, lazy, Suspense } from 'react';
import type { Editor } from '@tiptap/react';

const ImageInsertModal = lazy(() => import('./image-insert-modal'));

const FONT_FAMILIES = [
  { value: '', label: 'Default' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Garamond', label: 'Garamond' },
  { value: 'Calibri', label: 'Calibri' },
  { value: 'Verdana', label: 'Verdana' },
];

const FONT_SIZES = [
  { value: '', label: 'Size' },
  { value: '8pt', label: '8' },
  { value: '9pt', label: '9' },
  { value: '10pt', label: '10' },
  { value: '11pt', label: '11' },
  { value: '12pt', label: '12' },
  { value: '13pt', label: '13' },
  { value: '14pt', label: '14' },
  { value: '16pt', label: '16' },
  { value: '18pt', label: '18' },
  { value: '20pt', label: '20' },
  { value: '24pt', label: '24' },
  { value: '28pt', label: '28' },
  { value: '32pt', label: '32' },
  { value: '36pt', label: '36' },
  { value: '48pt', label: '48' },
];

interface DraftToolbarProps {
  editor: Editor | null;
  saveStatus: 'saved' | 'unsaved' | 'saving';
  trackChanges: boolean;
  onToggleTrackChanges: () => void;
  fontFamily: string;
  onFontFamilyChange: (font: string) => void;
  caseId?: string;
  onImportComplete?: () => void;
  onWordImport?: (html: string) => void;
  showMarks?: boolean;
  onToggleShowMarks?: () => void;
  pageView?: boolean;
  onTogglePageView?: () => void;
  draftId?: string;
  provider?: string;
  model?: string;
  onImageInsert?: (url: string, alt: string) => void;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  styleDefaults?: {
    defaultFont: string;
    defaultFontSize: string;
    h1Size: string; h2Size: string; h3Size: string; h4Size: string; h5Size: string;
    lineSpacing: string;
    paragraphSpacing: string;
  };
  pageSettings?: { pageSize: string; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number };
  onManualSave?: () => void;
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

/** Format shortcut for display: Ctrl → ⌘ on Mac */
function fmtShortcut(shortcut: string): string {
  if (isMac) {
    return shortcut
      .replace(/Ctrl\+/gi, '⌘')
      .replace(/Shift\+/gi, '⇧')
      .replace(/Alt\+/gi, '⌥');
  }
  return shortcut;
}

function Tooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleEnter = () => {
    timerRef.current = setTimeout(() => {
      if (wrapperRef.current) {
        const rect = wrapperRef.current.getBoundingClientRect();
        setPos({
          top: rect.top - 6,
          left: rect.left + rect.width / 2,
        });
      }
      setShow(true);
    }, 200);
  };
  const handleLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setShow(false);
    setPos(null);
  };

  return (
    <div ref={wrapperRef} onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {show && pos && (
        <div
          className="fixed z-[200] pointer-events-none whitespace-nowrap -translate-x-1/2 -translate-y-full"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="bg-gray-800 text-white text-[11px] leading-tight rounded px-2 py-1 shadow-lg flex items-center gap-1.5">
            <span>{label}</span>
            {shortcut && (
              <kbd className="bg-gray-700 text-gray-300 text-[10px] px-1 py-0.5 rounded font-mono">
                {fmtShortcut(shortcut)}
              </kbd>
            )}
          </div>
          {/* Arrow pointing down */}
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-1 w-2 h-2 bg-gray-800 rotate-45" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolbarButton
// ---------------------------------------------------------------------------

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  shortcut,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  shortcut?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={title} shortcut={shortcut}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`w-8 h-8 flex items-center justify-center rounded text-sm font-medium transition-colors
          ${active ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200'}
          ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Separator() {
  return <div className="w-px h-6 bg-gray-300 mx-1" />;
}

function FontFamilyDropdown({ editor, value, onChange }: { editor: Editor; value: string; onChange: (f: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => {
        const font = e.target.value;
        onChange(font);
        if (font) {
          editor.chain().focus().setFontFamily(font).run();
        } else {
          editor.chain().focus().unsetFontFamily().run();
        }
      }}
      className="h-8 px-2 text-sm border border-gray-300 rounded bg-white text-gray-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400 max-w-[130px]"
    >
      {FONT_FAMILIES.map(f => (
        <option key={f.value} value={f.value} style={f.value ? { fontFamily: f.value } : undefined}>
          {f.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Shared heading helpers
// ---------------------------------------------------------------------------

interface TOCEntry {
  level: 1 | 2 | 3;
  text: string;
  pos: number;
}

function extractHeadings(editor: Editor): TOCEntry[] {
  const found: TOCEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      found.push({
        level: node.attrs.level as 1 | 2 | 3,
        text: node.textContent || '(empty)',
        pos,
      });
    }
  });
  return found;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function HeadingDropdown({ editor }: { editor: Editor }) {
  const current = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : editor.isActive('heading', { level: 4 })
          ? 'h4'
          : editor.isActive('heading', { level: 5 })
            ? 'h5'
            : 'p';

  return (
    <select
      value={current}
      onChange={(e) => {
        const val = e.target.value;
        if (val === 'p') {
          editor.chain().focus().setParagraph().run();
        } else {
          const level = parseInt(val.replace('h', ''), 10) as 1 | 2 | 3 | 4 | 5;
          editor.chain().focus().toggleHeading({ level }).run();
        }
      }}
      className="h-8 px-2 text-sm border border-gray-300 rounded bg-white text-gray-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400"
    >
      <option value="p">Paragraph</option>
      <option value="h1">Heading 1</option>
      <option value="h2">Heading 2</option>
      <option value="h3">Heading 3</option>
      <option value="h4">Heading 4</option>
      <option value="h5">Heading 5</option>
    </select>
  );
}

function SaveIndicator({ status }: { status: 'saved' | 'unsaved' | 'saving' }) {
  if (status === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-gray-500" title="Saving...">
        <svg className="w-3 h-3 animate-spin" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" />
        </svg>
        Saving
      </span>
    );
  }
  const color = status === 'saved' ? 'bg-green-500' : 'bg-yellow-500';
  const label = status === 'saved' ? 'Saved' : 'Unsaved';
  return (
    <span className="flex items-center gap-1 text-xs text-gray-500" title={label}>
      <span className={`w-2 h-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}

// Inline SVG icons (16x16)
const BoldIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 2h5a3 3 0 0 1 2.1 5.15A3.5 3.5 0 0 1 9.5 14H4V2zm2 5h3a1 1 0 1 0 0-2H6v2zm0 2v3h3.5a1.5 1.5 0 0 0 0-3H6z" />
  </svg>
);

const ItalicIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M6 2h6v2h-2.2l-2.6 8H9v2H3v-2h2.2l2.6-8H6V2z" />
  </svg>
);

const UnderlineIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M4 2v5.5a4 4 0 0 0 8 0V2h-2v5.5a2 2 0 0 1-4 0V2H4zM3 14h10v1.5H3V14z" />
  </svg>
);

const StrikethroughIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <path d="M5.5 3C6.1 2.4 7 2 8.2 2c1.2 0 2.2.4 2.9 1 .5.5.8 1.1.9 1.8h-2c-.1-.3-.3-.5-.5-.7-.4-.3-.8-.4-1.3-.4-.6 0-1 .1-1.3.4-.3.2-.4.5-.4.9 0 .3.1.6.4.8H5c-.3-.4-.5-.9-.5-1.5 0-.5.3-1 1-1.3zM3 8h10v1.5H3V8zm5.7 2.5H11c-.1.5-.4 1-.8 1.4-.7.6-1.6 1-2.7 1-1.2 0-2.1-.3-2.8-.9-.4-.4-.7-.8-.8-1.3h2c.1.2.3.4.5.5.4.3.8.4 1.3.4.6 0 1-.2 1.3-.4.2-.2.4-.4.4-.7z" />
  </svg>
);

const BulletListIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="3" cy="4" r="1.5" /><rect x="6" y="3" width="8" height="2" rx="0.5" />
    <circle cx="3" cy="8" r="1.5" /><rect x="6" y="7" width="8" height="2" rx="0.5" />
    <circle cx="3" cy="12" r="1.5" /><rect x="6" y="11" width="8" height="2" rx="0.5" />
  </svg>
);

const OrderedListIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <text x="1" y="5.5" fontSize="5" fontWeight="bold">1.</text><rect x="6" y="3" width="8" height="2" rx="0.5" />
    <text x="1" y="9.5" fontSize="5" fontWeight="bold">2.</text><rect x="6" y="7" width="8" height="2" rx="0.5" />
    <text x="1" y="13.5" fontSize="5" fontWeight="bold">3.</text><rect x="6" y="11" width="8" height="2" rx="0.5" />
  </svg>
);

const AlignLeftIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="2" width="12" height="2" rx="0.5" /><rect x="2" y="6" width="8" height="2" rx="0.5" />
    <rect x="2" y="10" width="10" height="2" rx="0.5" /><rect x="2" y="14" width="6" height="2" rx="0.5" />
  </svg>
);

const AlignCenterIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="2" width="12" height="2" rx="0.5" /><rect x="4" y="6" width="8" height="2" rx="0.5" />
    <rect x="3" y="10" width="10" height="2" rx="0.5" /><rect x="5" y="14" width="6" height="2" rx="0.5" />
  </svg>
);

const AlignRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="2" width="12" height="2" rx="0.5" /><rect x="6" y="6" width="8" height="2" rx="0.5" />
    <rect x="4" y="10" width="10" height="2" rx="0.5" /><rect x="8" y="14" width="6" height="2" rx="0.5" />
  </svg>
);

const AlignJustifyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="2" width="12" height="2" rx="0.5" /><rect x="2" y="6" width="12" height="2" rx="0.5" />
    <rect x="2" y="10" width="12" height="2" rx="0.5" /><rect x="2" y="14" width="12" height="2" rx="0.5" />
  </svg>
);

const HighlightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="10" width="12" height="4" rx="1" opacity="0.3" fill="#facc15" />
    <path d="M4 2h8v2H4V2zm-1 3h10v3H3V5z" />
  </svg>
);

const LinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

const UnlinkIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);

const TOCIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="2" width="3" height="2" rx="0.5" /><rect x="6" y="2" width="8" height="2" rx="0.5" />
    <rect x="3" y="7" width="2" height="2" rx="0.5" /><rect x="6" y="7" width="7" height="2" rx="0.5" />
    <rect x="3" y="12" width="2" height="2" rx="0.5" /><rect x="6" y="12" width="6" height="2" rx="0.5" />
  </svg>
);

// ---------------------------------------------------------------------------
// Link Dialog (inline popover)
// ---------------------------------------------------------------------------

function LinkDialog({
  editor,
  onClose,
  anchorRef,
}: {
  editor: Editor;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const currentHref = editor.getAttributes('link').href || '';
  const isAnchor = currentHref.startsWith('#');
  const [tab, setTab] = useState<'headings' | 'url'>(isAnchor || !currentHref ? 'headings' : 'url');
  const [url, setUrl] = useState(isAnchor ? '' : currentHref);
  const [search, setSearch] = useState('');
  const [headings, setHeadings] = useState<TOCEntry[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  // Extract headings
  React.useEffect(() => {
    setHeadings(extractHeadings(editor));
    const handler = () => setHeadings(extractHeadings(editor));
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor]);

  // Auto-focus
  React.useEffect(() => {
    if (tab === 'headings') searchRef.current?.focus();
    else urlRef.current?.focus();
  }, [tab]);

  // Position dialog using fixed coordinates from the button
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  React.useEffect(() => {
    if (!anchorRef.current) return;
    const btnRect = anchorRef.current.getBoundingClientRect();
    let top = btnRect.bottom + 4;
    let left = btnRect.left;

    // Defer measurement to next frame so dialogRef has dimensions
    requestAnimationFrame(() => {
      if (!dialogRef.current) return;
      const dlgRect = dialogRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Flip up if overflows bottom
      if (top + dlgRect.height > vh - 8) {
        top = btnRect.top - dlgRect.height - 4;
      }
      // Flip left if overflows right
      if (left + 360 > vw - 8) {
        left = vw - 360 - 8;
      }
      // Clamp
      if (left < 8) left = 8;
      if (top < 8) top = 8;

      setPos({ top, left });
    });

    setPos({ top: btnRect.bottom + 4, left: btnRect.left });
  }, [anchorRef, tab]);

  // Close on click outside / escape
  React.useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node) &&
          anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose, anchorRef]);

  const applyHeadingLink = (entry: TOCEntry) => {
    const slug = slugify(entry.text);
    if (slug) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: `#${slug}` }).run();
    }
    onClose();
  };

  const applyUrl = () => {
    const trimmed = url.trim();
    if (trimmed) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    onClose();
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onClose();
  };

  const filtered = headings.filter(h =>
    h.text.toLowerCase().includes(search.toLowerCase())
  );

  const currentSlug = isAnchor ? currentHref.slice(1) : '';

  return (
    <div
      ref={dialogRef}
      className="fixed z-[100] bg-white border border-gray-200 rounded-lg shadow-xl"
      style={{ width: 360, top: pos.top, left: pos.left }}
    >
      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setTab('headings')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'headings'
              ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/50'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Headings
        </button>
        <button
          onClick={() => setTab('url')}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === 'url'
              ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/50'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          URL
        </button>
      </div>

      {tab === 'headings' ? (
        <div>
          {/* Search */}
          <div className="p-2 border-b border-gray-100">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search headings..."
              className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>

          {/* Heading list */}
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-gray-400 text-center">
                {headings.length === 0
                  ? 'No headings in document. Add H1, H2, or H3 headings first.'
                  : 'No headings match your search.'}
              </div>
            ) : (
              filtered.map((entry, i) => {
                const entrySlug = slugify(entry.text);
                const isLinked = currentSlug === entrySlug;
                return (
                  <button
                    key={i}
                    onClick={() => applyHeadingLink(entry)}
                    className={`w-full text-left px-3 py-1.5 text-sm transition-colors truncate flex items-center gap-2 ${
                      isLinked
                        ? 'bg-blue-100 text-blue-800 font-medium'
                        : 'hover:bg-blue-50 text-gray-700'
                    } ${
                      entry.level === 1 ? 'font-semibold' :
                      entry.level === 2 ? 'pl-6' :
                      'pl-9 text-gray-600'
                    }`}
                    title={entry.text}
                  >
                    <span className="truncate">{entry.text}</span>
                    {isLinked && (
                      <svg className="w-3.5 h-3.5 shrink-0 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Remove link (if editing existing) */}
          {currentHref && (
            <div className="p-2 border-t border-gray-100">
              <button
                onClick={removeLink}
                className="w-full px-2 py-1 text-xs font-medium text-red-600 border border-red-300 rounded hover:bg-red-50"
              >
                Remove Link
              </button>
            </div>
          )}
        </div>
      ) : (
        /* URL tab */
        <div className="p-2.5 space-y-2">
          <input
            ref={urlRef}
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyUrl(); }}
            placeholder="https://..."
            className="w-full px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex gap-1.5">
            <button
              onClick={applyUrl}
              className="flex-1 px-2 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
            >
              Apply
            </button>
            {currentHref && (
              <button
                onClick={removeLink}
                className="px-2 py-1 text-xs font-medium text-red-600 border border-red-300 rounded hover:bg-red-50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TOC Modal
// ---------------------------------------------------------------------------

function TOCModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [entries, setEntries] = useState<TOCEntry[]>([]);
  const modalRef = useRef<HTMLDivElement>(null);

  // Extract headings (reuse shared helper)
  React.useEffect(() => {
    const refresh = () => setEntries(extractHeadings(editor));
    refresh();
    editor.on('update', refresh);
    return () => { editor.off('update', refresh); };
  }, [editor]);

  // Close on click outside / escape
  React.useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const scrollTo = (pos: number) => {
    editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
    onClose();
  };

  return (
    <div
      ref={modalRef}
      className="fixed z-50 bg-white rounded-lg shadow-xl border border-gray-200 w-80 max-h-[60vh] overflow-y-auto"
      style={{ top: 80, right: 40 }}
    >
      <div className="sticky top-0 bg-white border-b border-gray-200 px-3 py-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">Table of Contents</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="px-3 py-4 text-xs text-gray-400 text-center">
          No headings found. Add headings (H1, H2, H3) to see the document structure.
        </div>
      ) : (
        <div className="py-1">
          {entries.map((e, i) => (
            <button
              key={i}
              onClick={() => scrollTo(e.pos)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 transition-colors truncate ${
                e.level === 1 ? 'font-semibold text-gray-800' :
                e.level === 2 ? 'pl-6 font-medium text-gray-700' :
                'pl-9 text-gray-600'
              }`}
              title={e.text}
            >
              {e.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DraftToolbar({
  editor,
  saveStatus,
  trackChanges,
  onToggleTrackChanges,
  fontFamily,
  onFontFamilyChange,
  caseId,
  onImportComplete,
  onWordImport,
  showMarks,
  onToggleShowMarks,
  pageView,
  onTogglePageView,
  draftId,
  provider,
  model,
  onImageInsert,
  zoom = 1,
  onZoomChange,
  styleDefaults,
  pageSettings,
  onManualSave,
}: DraftToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wordInputRef = useRef<HTMLInputElement>(null);
  const linkBtnRef = useRef<HTMLButtonElement | null>(null);
  const [wordImporting, setWordImporting] = useState(false);
  const [wordExporting, setWordExporting] = useState(false);
  const [paintFormat, setPaintFormat] = useState<Record<string, any> | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [imageModalOpen, setImageModalOpen] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  // Track font size on selection change so the dropdown always shows the current value.
  // The editor parent has shouldRerenderOnTransaction: false, so the toolbar won't
  // re-render on selection changes — we need our own listener.
  const defaultFS = styleDefaults?.defaultFontSize || '12pt';
  const [selFontSize, setSelFontSize] = useState<string>(defaultFS);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const fs = editor.getAttributes('textStyle').fontSize || defaultFS;
      setSelFontSize(fs);
    };
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    update();
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('transaction', update);
    };
  }, [editor, defaultFS]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const url = caseId ? `/api/drafts/export?caseId=${caseId}` : '/api/drafts/export';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `drafts-export-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert('Export failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
    setExporting(false);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/drafts/import', { method: 'POST', body: form });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Import failed');
      const msg = `Imported: ${result.imported}, Skipped: ${result.skipped}` +
        (result.errors?.length ? `\n\nWarnings:\n${result.errors.join('\n')}` : '');
      alert(msg);
      onImportComplete?.();
    } catch (e) {
      alert('Import failed: ' + (e instanceof Error ? e.message : 'Unknown error'));
    }
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  if (!editor) return null;

  const ribbonGroup = "flex items-center gap-0.5 px-1.5 py-0.5 border border-gray-200 rounded bg-white";

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1 bg-gray-50 border-b border-gray-200 shrink-0">
      {/* ── Font group ── */}
      <div className={ribbonGroup}>
        <Tooltip label="Font Family">
          <FontFamilyDropdown editor={editor} value={fontFamily} onChange={onFontFamilyChange} />
        </Tooltip>
        <Tooltip label="Font Size">
          <select
            value={selFontSize}
            onChange={(e) => {
              const size = e.target.value;
              if (size) {
                (editor.chain().focus() as any).setFontSize(size).run();
              } else {
                (editor.chain().focus() as any).unsetFontSize().run();
              }
            }}
            className="h-7 px-1 text-xs border border-gray-200 rounded bg-white text-gray-700 cursor-pointer"
          >
            {FONT_SIZES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </Tooltip>
      </div>

      {/* ── Headings group ── */}
      <div className={ribbonGroup}>
        <ToolbarButton
          onClick={() => editor.chain().focus().setParagraph().run()}
          active={!editor.isActive('heading')}
          title="Paragraph"
        >
          <span className="text-[11px] font-bold leading-none">P</span>
        </ToolbarButton>
        {([1, 2, 3, 4, 5] as const).map(level => (
          <ToolbarButton
            key={level}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
            active={editor.isActive('heading', { level })}
            title={`Heading ${level}`}
          >
            <span className="text-[11px] font-bold leading-none">H{level}</span>
          </ToolbarButton>
        ))}
      </div>

      {/* ── Text format group ── */}
      <div className={ribbonGroup}>
        <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold" shortcut="Ctrl+B"><BoldIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic" shortcut="Ctrl+I"><ItalicIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline" shortcut="Ctrl+U"><UnderlineIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough" shortcut="Ctrl+Shift+S"><StrikethroughIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleSubscript().run()} active={editor.isActive('subscript')} title="Subscript">
          <span className="text-[11px] font-bold leading-none">X<sub style={{fontSize:'7px'}}>2</sub></span>
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleSuperscript().run()} active={editor.isActive('superscript')} title="Superscript">
          <span className="text-[11px] font-bold leading-none">X<sup style={{fontSize:'7px'}}>2</sup></span>
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} title="Highlight" shortcut="Ctrl+Shift+H"><HighlightIcon /></ToolbarButton>
        <ToolbarButton
          onClick={() => {
            if (paintFormat) {
              const chain = editor.chain().focus();
              if (paintFormat.bold) chain.setBold(); else chain.unsetBold();
              if (paintFormat.italic) chain.setItalic(); else chain.unsetItalic();
              if (paintFormat.underline) (chain as any).setUnderline(); else (chain as any).unsetUnderline();
              if (paintFormat.strike) chain.setStrike(); else chain.unsetStrike();
              if (paintFormat.highlight) chain.setHighlight(); else chain.unsetHighlight();
              if (paintFormat.fontFamily) (chain as any).setFontFamily(paintFormat.fontFamily);
              if (paintFormat.fontSize) (chain as any).setFontSize(paintFormat.fontSize);
              chain.run();
              setPaintFormat(null);
            } else {
              const marks: Record<string, any> = {
                bold: editor.isActive('bold'),
                italic: editor.isActive('italic'),
                underline: editor.isActive('underline'),
                strike: editor.isActive('strike'),
                highlight: editor.isActive('highlight'),
                fontFamily: editor.getAttributes('textStyle').fontFamily || null,
                fontSize: editor.getAttributes('textStyle').fontSize || null,
              };
              setPaintFormat(marks);
            }
          }}
          active={!!paintFormat}
          title={paintFormat ? 'Click text to apply format (Esc to cancel)' : 'Copy Format (Format Painter)'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M10.5 1.5l2 2-1 1-2-2 1-1zM4 8l5-5 2 2-5 5H4V8zm-1 4h10v1.5H3V12z" />
          </svg>
        </ToolbarButton>
      </div>

      {/* ── Lists + Alignment group ── */}
      <div className={ribbonGroup}>
        <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List"><BulletListIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Ordered List"><OrderedListIcon /></ToolbarButton>
        <span className="w-px h-5 bg-gray-200 mx-0.5" />
        <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('left').run()} active={editor.isActive({ textAlign: 'left' })} title="Align Left"><AlignLeftIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('center').run()} active={editor.isActive({ textAlign: 'center' })} title="Align Center"><AlignCenterIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('right').run()} active={editor.isActive({ textAlign: 'right' })} title="Align Right"><AlignRightIcon /></ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().setTextAlign('justify').run()} active={editor.isActive({ textAlign: 'justify' })} title="Justify"><AlignJustifyIcon /></ToolbarButton>
      </div>

      {/* ── Insert group ── */}
      <div className={ribbonGroup}>
        <div className="relative">
          <Tooltip label={editor.isActive('link') ? 'Edit Link' : 'Insert Link'} shortcut="Ctrl+K">
            <button
              ref={linkBtnRef}
              type="button"
              onClick={() => setLinkDialogOpen(!linkDialogOpen)}
              className={`w-7 h-7 flex items-center justify-center rounded text-sm font-medium transition-colors cursor-pointer
                ${editor.isActive('link') ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200'}`}
            >
              <LinkIcon />
            </button>
          </Tooltip>
          {linkDialogOpen && (
            <LinkDialog editor={editor} onClose={() => setLinkDialogOpen(false)} anchorRef={linkBtnRef} />
          )}
        </div>
        {editor.isActive('link') && (
          <ToolbarButton onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()} title="Remove Link"><UnlinkIcon /></ToolbarButton>
        )}
        <ToolbarButton onClick={() => (editor.chain().focus() as any).insertTableOfContents().run()} title="Insert Table of Contents"><TOCIcon /></ToolbarButton>
        <ToolbarButton onClick={() => { editor.chain().focus().run(); (editor.commands as any).addFootnote(); }} title="Insert Footnote">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <text x="2" y="9" fontSize="8" fontWeight="bold" fontFamily="serif">F</text>
            <text x="8" y="12" fontSize="6" fontFamily="serif">n</text>
          </svg>
        </ToolbarButton>
        <ToolbarButton onClick={() => setImageModalOpen(true)} title="Insert Image / Exhibit">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Insert Page Break">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="2" width="12" height="1.5" rx="0.5" opacity="0.3" />
            <rect x="2" y="7" width="12" height="2" rx="0.5" />
            <rect x="2" y="12.5" width="12" height="1.5" rx="0.5" opacity="0.3" />
          </svg>
        </ToolbarButton>
      </div>

      {imageModalOpen && caseId && draftId && (
        <Suspense fallback={null}>
          <ImageInsertModal
            caseId={caseId}
            draftId={draftId}
            provider={provider || 'ollama'}
            model={model || ''}
            onInsert={(url, alt) => {
              editor.chain().focus().setImage({ src: url, alt }).run();
              if (alt && alt !== 'Exhibit image') {
                editor.commands.createParagraphNear();
                editor.commands.insertContent({
                  type: 'paragraph',
                  attrs: { textAlign: 'center' },
                  content: [{ type: 'text', marks: [{ type: 'bold' }], text: alt }],
                });
              }
              onImageInsert?.(url, alt);
              setImageModalOpen(false);
            }}
            onClose={() => setImageModalOpen(false)}
          />
        </Suspense>
      )}

      {/* ── View group ── */}
      <div className={ribbonGroup}>
        <ToolbarButton onClick={() => onToggleShowMarks?.()} active={showMarks} title={showMarks ? 'Hide Formatting Marks' : 'Show Formatting Marks (¶ ↵ ·)'}>
          <span className="text-sm font-bold leading-none" style={{ fontFamily: 'serif' }}>¶</span>
        </ToolbarButton>
        <ToolbarButton onClick={() => onTogglePageView?.()} active={pageView} title={pageView ? 'Switch to Continuous View' : 'Switch to Page View'}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="1" width="10" height="6" rx="1" />
            <rect x="3" y="9" width="10" height="6" rx="1" />
          </svg>
        </ToolbarButton>
        <ToolbarButton onClick={onToggleTrackChanges} active={trackChanges} title={trackChanges ? 'Track Changes: ON' : 'Track Changes: OFF'}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </ToolbarButton>
      </div>

      {/* ── Spacer ── */}
      <div className="flex-1" />

      {/* ── Zoom + status group ── */}
      {onZoomChange && (
        <div className="flex items-center gap-0.5 mr-2">
          <button
            onClick={() => onZoomChange(Math.max(0.5, zoom - 0.1))}
            className="w-6 h-6 flex items-center justify-center rounded text-xs text-gray-600 hover:bg-gray-200"
            title="Zoom Out (Ctrl+Scroll)"
          >−</button>
          <select
            value={String(zoom)}
            onChange={(e) => {
              const val = e.target.value;
              if (val === 'fit') {
                // Find the middle panel column (the flex-1 flex-col parent of the editor area)
                const editorDom = editor?.view?.dom;
                // Walk up: ProseMirror -> zoom-inner -> draft-editor-wrapper -> editor-area-div -> middle-panel
                const middlePanel = editorDom?.closest?.('.draft-editor-wrapper')?.parentElement?.parentElement;
                if (middlePanel) {
                  const availableW = middlePanel.clientWidth - 40;
                  const PAGE_WIDTHS: Record<string, number> = { letter: 816, a4: 794, legal: 816 };
                  const pageSize = document.querySelector('[data-page-size]')?.getAttribute('data-page-size') || 'letter';
                  const pageW = PAGE_WIDTHS[pageSize] || 816;
                  // Fit means page should fit within available width
                  const fitZoom = Math.min(1.5, Math.max(0.3, availableW / pageW));
                  onZoomChange(Math.round(fitZoom * 100) / 100);
                }
              } else {
                onZoomChange(parseFloat(val));
              }
            }}
            className="h-6 px-0.5 text-[11px] border border-gray-200 rounded bg-white text-gray-600 cursor-pointer min-w-[52px] text-center"
            title="Zoom Level"
          >
            <option value={String(zoom)}>{Math.round(zoom * 100)}%</option>
            <option value="fit">Fit Width</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
          </select>
          <button
            onClick={() => onZoomChange(Math.min(2, zoom + 0.1))}
            className="w-6 h-6 flex items-center justify-center rounded text-xs text-gray-600 hover:bg-gray-200"
            title="Zoom In (Ctrl+Scroll)"
          >+</button>
        </div>
      )}

      {/* Word count */}
      {editor.storage?.characterCount && (
        <span className="text-[10px] text-gray-400 mr-2 whitespace-nowrap">
          {editor.storage.characterCount.words()} words
        </span>
      )}
      {onManualSave && (
        <Tooltip label="Save" shortcut="Ctrl+S">
          <button
            onClick={onManualSave}
            disabled={saveStatus === 'saved' || saveStatus === 'saving'}
            className={`w-8 h-8 flex items-center justify-center rounded text-sm transition-colors ${
              saveStatus === 'unsaved'
                ? 'text-blue-600 hover:bg-blue-100'
                : 'text-gray-400 cursor-default'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
          </button>
        </Tooltip>
      )}
      <SaveIndicator status={saveStatus} />
    </div>
  );
}
