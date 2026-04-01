'use client';

import React from 'react';
import type { Editor } from '@tiptap/react';

interface DraftToolbarProps {
  editor: Editor | null;
  saveStatus: 'saved' | 'unsaved' | 'saving';
  trackChanges: boolean;
  onToggleTrackChanges: () => void;
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

export default function DraftToolbar({
  editor,
  saveStatus,
  trackChanges,
  onToggleTrackChanges,
}: DraftToolbarProps) {
  if (!editor) return null;

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-gray-50 border border-b-0 rounded-t-lg flex-wrap">
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

      {/* Track Changes */}
      <ToolbarButton
        onClick={onToggleTrackChanges}
        active={trackChanges}
        title={trackChanges ? 'Track Changes: ON' : 'Track Changes: OFF'}
      >
        <span className="text-xs font-bold">TC</span>
      </ToolbarButton>

      {/* Spacer + Save status */}
      <div className="flex-1" />
      <SaveIndicator status={saveStatus} />
    </div>
  );
}
