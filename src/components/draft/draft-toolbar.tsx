'use client';

import React, { useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

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

interface DraftToolbarProps {
  editor: Editor | null;
  saveStatus: 'saved' | 'unsaved' | 'saving';
  trackChanges: boolean;
  onToggleTrackChanges: () => void;
  fontFamily: string;
  onFontFamilyChange: (font: string) => void;
  caseId?: string;
  onImportComplete?: () => void;
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-8 h-8 flex items-center justify-center rounded text-sm font-medium transition-colors
        ${active ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200'}
        ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      {children}
    </button>
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
      title="Font family"
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

function HeadingDropdown({ editor }: { editor: Editor }) {
  const current = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : 'p';

  return (
    <select
      value={current}
      onChange={(e) => {
        const val = e.target.value;
        if (val === 'p') {
          editor.chain().focus().setParagraph().run();
        } else {
          const level = parseInt(val.replace('h', ''), 10) as 1 | 2 | 3;
          editor.chain().focus().toggleHeading({ level }).run();
        }
      }}
      title="Text style"
      className="h-8 px-2 text-sm border border-gray-300 rounded bg-white text-gray-700 cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-400"
    >
      <option value="p">Paragraph</option>
      <option value="h1">Heading 1</option>
      <option value="h2">Heading 2</option>
      <option value="h3">Heading 3</option>
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
  const [url, setUrl] = useState(currentHref);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Close on click outside
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

  const apply = () => {
    const trimmed = url.trim();
    if (trimmed) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    onClose();
  };

  const remove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onClose();
  };

  return (
    <div
      ref={dialogRef}
      className="absolute top-full left-0 mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-2 flex items-center gap-1.5"
      style={{ minWidth: 320 }}
    >
      <input
        ref={inputRef}
        type="url"
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') apply(); }}
        placeholder="https://..."
        className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
      />
      <button
        onClick={apply}
        className="px-2 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700"
      >
        Apply
      </button>
      {currentHref && (
        <button
          onClick={remove}
          className="px-2 py-1 text-xs font-medium text-red-600 border border-red-300 rounded hover:bg-red-50"
        >
          Remove
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TOC Modal
// ---------------------------------------------------------------------------

interface TOCEntry {
  level: 1 | 2 | 3;
  text: string;
  pos: number;
}

function TOCModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [entries, setEntries] = useState<TOCEntry[]>([]);
  const modalRef = useRef<HTMLDivElement>(null);

  // Extract headings
  React.useEffect(() => {
    const extract = () => {
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
      setEntries(found);
    };
    extract();
    editor.on('update', extract);
    return () => { editor.off('update', extract); };
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
}: DraftToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkBtnRef = useRef<HTMLButtonElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

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

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-gray-50 border border-b-0 rounded-t-lg flex-wrap">
      {/* Font family dropdown */}
      <FontFamilyDropdown editor={editor} value={fontFamily} onChange={onFontFamilyChange} />

      {/* Heading dropdown */}
      <HeadingDropdown editor={editor} />

      <Separator />

      {/* Text formatting */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title="Bold (Ctrl+B)"
      >
        <BoldIcon />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title="Italic (Ctrl+I)"
      >
        <ItalicIcon />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        active={editor.isActive('underline')}
        title="Underline"
      >
        <UnderlineIcon />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title="Strikethrough"
      >
        <StrikethroughIcon />
      </ToolbarButton>

      <Separator />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
        title="Bullet List"
      >
        <BulletListIcon />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
        title="Ordered List"
      >
        <OrderedListIcon />
      </ToolbarButton>

      <Separator />

      {/* Alignment */}
      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        active={editor.isActive({ textAlign: 'left' })}
        title="Align Left"
      >
        <AlignLeftIcon />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        active={editor.isActive({ textAlign: 'center' })}
        title="Align Center"
      >
        <AlignCenterIcon />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        active={editor.isActive({ textAlign: 'right' })}
        title="Align Right"
      >
        <AlignRightIcon />
      </ToolbarButton>

      <ToolbarButton
        onClick={() => editor.chain().focus().setTextAlign('justify').run()}
        active={editor.isActive({ textAlign: 'justify' })}
        title="Justify"
      >
        <AlignJustifyIcon />
      </ToolbarButton>

      <Separator />

      {/* Highlight */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        active={editor.isActive('highlight')}
        title="Highlight"
      >
        <HighlightIcon />
      </ToolbarButton>

      <Separator />

      {/* Hyperlink */}
      <div className="relative">
        <button
          ref={linkBtnRef}
          type="button"
          onClick={() => setLinkDialogOpen(!linkDialogOpen)}
          title={editor.isActive('link') ? 'Edit Link (Ctrl+K)' : 'Insert Link (Ctrl+K)'}
          className={`w-8 h-8 flex items-center justify-center rounded text-sm font-medium transition-colors cursor-pointer
            ${editor.isActive('link') ? 'bg-blue-500 text-white' : 'text-gray-700 hover:bg-gray-200'}`}
        >
          <LinkIcon />
        </button>
        {linkDialogOpen && (
          <LinkDialog editor={editor} onClose={() => setLinkDialogOpen(false)} anchorRef={linkBtnRef} />
        )}
      </div>

      {editor.isActive('link') && (
        <ToolbarButton
          onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
          title="Remove Link"
        >
          <UnlinkIcon />
        </ToolbarButton>
      )}

      {/* Table of Contents */}
      <ToolbarButton
        onClick={() => setTocOpen(!tocOpen)}
        active={tocOpen}
        title="Table of Contents"
      >
        <TOCIcon />
      </ToolbarButton>
      {tocOpen && <TOCModal editor={editor} onClose={() => setTocOpen(false)} />}

      <Separator />

      {/* Track Changes */}
      <ToolbarButton
        onClick={onToggleTrackChanges}
        active={trackChanges}
        title={trackChanges ? 'Track Changes: ON' : 'Track Changes: OFF'}
      >
        <span className="text-xs font-bold">TC</span>
      </ToolbarButton>

      <Separator />

      {/* Export */}
      <ToolbarButton
        onClick={handleExport}
        active={false}
        title={exporting ? 'Exporting...' : 'Export All Drafts'}
      >
        {exporting ? (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1v8m0 0l-3-3m3 3l3-3M3 12v1.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5V12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </ToolbarButton>

      {/* Import */}
      <ToolbarButton
        onClick={() => fileInputRef.current?.click()}
        active={false}
        title={importing ? 'Importing...' : 'Import Drafts'}
      >
        {importing ? (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 11V3m0 0l-3 3m3-3l3 3M3 12v1.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5V12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </ToolbarButton>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleImport}
        className="hidden"
      />

      {/* Spacer + Save status */}
      <div className="flex-1" />
      <SaveIndicator status={saveStatus} />
    </div>
  );
}
