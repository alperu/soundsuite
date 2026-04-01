'use client';

import React, { forwardRef, useImperativeHandle, useEffect, useCallback, useRef } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { FontSize } from '@/lib/draft/font-size-extension';
import { TableOfContents } from '@/lib/draft/toc-extension';
import { PaginationPlus, PAGE_SIZES } from 'tiptap-pagination-plus';

export interface SelectionInfo {
  selectedText: string;
  from: number;
  to: number;
  hasSelection: boolean;
}

export interface DraftEditorHandle {
  editor: Editor | null;
  getSelection: () => SelectionInfo;
  replaceSelection: (text: string) => void;
  insertAtCursor: (text: string) => void;
  getHTML: () => string;
  getJSON: () => Record<string, unknown>;
  getMarkdown: () => string;
}

interface PageSettings {
  pageSize: 'letter' | 'a4' | 'legal';
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

interface DraftEditorProps {
  content: string | object;
  onUpdate: (json: string) => void;
  onSelectionChange?: (sel: { selectedText: string; hasSelection: boolean }) => void;
  onContextMenu?: (e: MouseEvent) => void;
  className?: string;
  showMarks?: boolean;
  pageView?: boolean;
  pageSettings?: PageSettings;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
}

const DraftEditor = forwardRef<DraftEditorHandle, DraftEditorProps>(
  ({ content, onUpdate, onSelectionChange, onContextMenu, className, showMarks, pageView, pageSettings, zoom = 1, onZoomChange }, ref) => {
    // Compute page size config for pagination
    const ps = pageSettings || { pageSize: 'letter', marginTop: 96, marginBottom: 96, marginLeft: 96, marginRight: 96 };
    const pageSizeMap: Record<string, any> = {
      letter: PAGE_SIZES.LETTER,
      a4: PAGE_SIZES.A4,
      legal: PAGE_SIZES.LEGAL,
    };
    const paginationConfig = pageSizeMap[ps.pageSize] || PAGE_SIZES.LETTER;

    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5] },
        }),
        Underline,
        TextStyle,
        FontFamily,
        FontSize,
        Link.configure({
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          isAllowedUri: (url: string, ctx: { defaultValidate: (url: string) => boolean }) => {
            if (url.startsWith('#')) return true;
            return ctx.defaultValidate(url);
          },
          HTMLAttributes: {
            class: 'text-blue-600 underline cursor-pointer',
            rel: 'noopener noreferrer nofollow',
          },
        }),
        TextAlign.configure({
          types: ['heading', 'paragraph'],
        }),
        Highlight.configure({
          multicolor: false,
        }),
        Table.configure({
          resizable: true,
        }),
        Image.configure({
          inline: false,
          allowBase64: false,
          HTMLAttributes: {
            class: 'max-w-full rounded border border-gray-200 my-2',
          },
        }),
        TableRow,
        TableCell,
        TableHeader,
        TableOfContents,
        PaginationPlus.configure({
          ...paginationConfig,
          pageGap: 40,
          pageGapBorderColor: '#d1d5db',
          pageBreakBackground: '#e5e7eb',
          footerRight: 'Page {page}',
        }),
      ],
      content,
      onUpdate: ({ editor: ed }) => {
        onUpdate(JSON.stringify(ed.getJSON()));
      },
      onSelectionUpdate: ({ editor: ed }) => {
        if (onSelectionChange) {
          const { from, to } = ed.state.selection;
          const selectedText = ed.state.doc.textBetween(from, to, ' ');
          onSelectionChange({
            selectedText,
            hasSelection: from !== to,
          });
        }
      },
      editorProps: {
        attributes: {
          class: 'prose prose-sm max-w-none focus:outline-none min-h-full px-4 py-3',
        },
        // Strip font-family from pasted HTML so the editor's set font is used
        transformPastedHTML(html: string) {
          return html.replace(/font-family\s*:\s*[^;"]+;?/gi, '');
        },
      },
    });

    // Sync content only on external changes (draft switch, version preview).
    // Track whether the editor itself triggered the update to avoid fighting user input.
    const isInternalUpdate = useRef(false);
    const lastExternalContent = useRef(content);

    // Wrap onUpdate to flag internal edits
    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      const handler = () => { isInternalUpdate.current = true; };
      editor.on('update', handler);
      return () => { editor.off('update', handler); };
    }, [editor]);

    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      // Skip if this change came from the editor's own typing
      if (isInternalUpdate.current) {
        isInternalUpdate.current = false;
        lastExternalContent.current = content;
        return;
      }
      // Skip if content hasn't actually changed
      const contentStr = typeof content === 'object' ? JSON.stringify(content) : content;
      const lastStr = typeof lastExternalContent.current === 'object' ? JSON.stringify(lastExternalContent.current) : lastExternalContent.current;
      if (contentStr === lastStr) return;
      lastExternalContent.current = content;

      // Parse JSON string if needed
      let parsed = content;
      if (typeof parsed === 'string' && parsed.startsWith('{')) {
        try { parsed = JSON.parse(parsed); } catch {}
      }

      editor.commands.setContent(parsed);
    }, [editor, content]);

    // Toggle pagination on/off by changing page height
    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      try {
        if (pageView) {
          (editor.commands as any).setPaginationOptions?.({
            ...paginationConfig,
            pageGap: 40,
            pageGapBorderColor: '#d1d5db',
            pageBreakBackground: '#e5e7eb',
            footerRight: 'Page {page}',
          });
        } else {
          (editor.commands as any).setPaginationOptions?.({
            pageHeight: 99999,
            pageWidth: 99999,
            pageGap: 0,
            marginTop: 0,
            marginBottom: 0,
            marginLeft: 0,
            marginRight: 0,
            footerRight: '',
            footerLeft: '',
            headerRight: '',
            headerLeft: '',
          });
        }
      } catch {}
    }, [editor, pageView, paginationConfig]);

    // Context menu listener
    useEffect(() => {
      if (!editor || !onContextMenu) return;
      const el = editor.view.dom;
      const handler = (e: MouseEvent) => onContextMenu(e);
      el.addEventListener('contextmenu', handler);
      return () => el.removeEventListener('contextmenu', handler);
    }, [editor, onContextMenu]);

    // Internal anchor link click handler — scroll to matching heading
    useEffect(() => {
      if (!editor) return;
      const el = editor.view.dom;
      const handler = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        const link = target.closest('a');
        if (!link) return;
        const href = link.getAttribute('href');
        if (!href || !href.startsWith('#')) return;

        e.preventDefault();
        e.stopPropagation();
        const slug = href.slice(1);

        // Find heading whose text slugifies to match
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'heading') {
            const headingSlug = node.textContent
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 80);
            if (headingSlug === slug) {
              editor.chain().setTextSelection(pos).scrollIntoView().run();
              return false; // stop traversal
            }
          }
        });
      };
      el.addEventListener('click', handler);
      return () => el.removeEventListener('click', handler);
    }, [editor]);

    const getSelection = useCallback((): SelectionInfo => {
      if (!editor) {
        return { selectedText: '', from: 0, to: 0, hasSelection: false };
      }
      const { from, to } = editor.state.selection;
      const selectedText = editor.state.doc.textBetween(from, to, ' ');
      return { selectedText, from, to, hasSelection: from !== to };
    }, [editor]);

    useImperativeHandle(ref, () => ({
      editor,
      getSelection,
      replaceSelection: (text: string) => {
        if (!editor) return;
        const { from, to } = editor.state.selection;
        editor.chain().focus().deleteRange({ from, to }).insertContentAt(from, text).run();
      },
      insertAtCursor: (text: string) => {
        if (!editor) return;
        editor.chain().focus().insertContent(text).run();
      },
      getHTML: () => editor?.getHTML() ?? '',
      getJSON: () => (editor?.getJSON() as Record<string, unknown>) ?? {},
      getMarkdown: () => editor?.getText() ?? '',
    }), [editor, getSelection]);

    // Zoom wrapper ref + Ctrl+scroll handler (must be before early returns)
    const wrapperRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const el = wrapperRef.current;
      if (!el || !onZoomChange) return;
      const handler = (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -0.05 : 0.05;
          onZoomChange(Math.min(2, Math.max(0.5, zoom + delta)));
        }
      };
      el.addEventListener('wheel', handler, { passive: false });
      return () => el.removeEventListener('wheel', handler);
    }, [zoom, onZoomChange]);

    if (!editor) {
      return (
        <div className={`bg-white flex-1 flex items-center justify-center text-gray-400 ${className ?? ''}`}>
          Loading editor...
        </div>
      );
    }

    const wrapperClasses = [
      'draft-editor-wrapper',
      'overflow-auto flex-1',
      showMarks ? 'show-marks' : '',
      pageView ? 'page-view' : 'bg-white',
      className ?? '',
    ].filter(Boolean).join(' ');

    return (
      <div ref={wrapperRef} className={wrapperClasses}>
        <style>{`
          /* --- Page breaks (continuous mode) --- */
          .draft-editor-wrapper hr {
            border: none;
            border-top: 2px dashed #d1d5db;
            margin: 1.5rem 0;
            position: relative;
          }
          .draft-editor-wrapper hr::after {
            content: 'Page Break';
            position: absolute;
            top: -0.7em;
            left: 50%;
            transform: translateX(-50%);
            background: white;
            padding: 0 0.5rem;
            font-size: 10px;
            color: #9ca3af;
            white-space: nowrap;
          }

          /* --- TOC overflow fix --- */
          .draft-editor-wrapper [data-type="table-of-contents"] {
            max-width: 100%;
            overflow: hidden;
          }

          /* --- Formatting marks (¶ ↵) --- */
          .draft-editor-wrapper.show-marks .ProseMirror p::after,
          .draft-editor-wrapper.show-marks .ProseMirror h1::after,
          .draft-editor-wrapper.show-marks .ProseMirror h2::after,
          .draft-editor-wrapper.show-marks .ProseMirror h3::after,
          .draft-editor-wrapper.show-marks .ProseMirror li > p::after {
            content: '¶';
            color: #93c5fd;
            font-size: 0.75em;
            margin-left: 2px;
            font-family: sans-serif;
            user-select: none;
            pointer-events: none;
          }
          .draft-editor-wrapper.show-marks .ProseMirror br::before {
            content: '↵';
            color: #93c5fd;
            font-size: 0.75em;
            font-family: sans-serif;
            user-select: none;
            pointer-events: none;
          }
          .draft-editor-wrapper.show-marks .ProseMirror {
            word-spacing: 0.15em;
          }

          /* --- Page view background --- */
          .draft-editor-wrapper.page-view {
            background: #e5e7eb;
          }
        `}</style>
        <div
          className="draft-zoom-inner"
          style={zoom !== 1 ? {
            transform: `scale(${zoom})`,
            transformOrigin: 'top center',
            width: `${100 / zoom}%`,
          } : undefined}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
    );
  }
);

DraftEditor.displayName = 'DraftEditor';

export default DraftEditor;
