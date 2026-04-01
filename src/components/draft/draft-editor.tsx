'use client';

import React, { forwardRef, useImperativeHandle, useEffect, useCallback, useRef, useMemo, useState, lazy, Suspense } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

const ImageToolbar = lazy(() => import('./image-toolbar'));
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import BaseImage from '@tiptap/extension-image';

// Extend Image to support width and wrapping (alignment) attributes.
const Image = BaseImage.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute('width') || el.style.width?.replace('px', '') || null,
        renderHTML: () => ({}), // rendered in renderHTML below
      },
      wrapping: {
        default: 'inline', // 'inline' | 'float-left' | 'float-right' | 'block'
        parseHTML: (el) => el.getAttribute('data-wrapping') || 'inline',
        renderHTML: () => ({}), // rendered in renderHTML below
      },
    };
  },
  renderHTML({ HTMLAttributes, node }) {
    const styleParts: string[] = [];
    if (node.attrs.width) styleParts.push(`width: ${node.attrs.width}px`);

    const wrap = node.attrs.wrapping || 'inline';
    if (wrap === 'float-left') {
      styleParts.push('float: left', 'margin-right: 16px', 'margin-bottom: 8px', 'clear: left');
    } else if (wrap === 'float-right') {
      styleParts.push('float: right', 'margin-left: 16px', 'margin-bottom: 8px', 'clear: right');
    } else if (wrap === 'block') {
      styleParts.push('display: block', 'margin-left: auto', 'margin-right: auto');
    }

    return ['img', {
      ...HTMLAttributes,
      'data-wrapping': wrap,
      ...(styleParts.length ? { style: styleParts.join('; ') + ';' } : {}),
    }];
  },
  // Make image inline when float modes are used so it can sit alongside text
  group: 'block',
  atom: true,
  draggable: true,
});
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { FontSize } from '@/lib/draft/font-size-extension';
import { TableOfContents } from '@/lib/draft/toc-extension';
import { Extension } from '@tiptap/core';
// No custom HardBreak — use StarterKit default. Markers are CSS-only.

// Cmd+Enter / Ctrl+Enter → insert page break (horizontal rule)
const PageBreakShortcut = Extension.create({
  name: 'pageBreakShortcut',
  priority: 1000, // high priority to override other Enter handlers
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': ({ editor }) => {
        return editor.chain().focus().setHorizontalRule().run();
      },
    };
  },
});

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
  styleDefaults?: {
    defaultFont: string;
    defaultFontSize: string;
    h1Size: string; h2Size: string; h3Size: string; h4Size: string; h5Size: string;
    lineSpacing: string;
    paragraphSpacing: string;
  };
}

const DraftEditor = forwardRef<DraftEditorHandle, DraftEditorProps>(
  ({ content, onUpdate, onSelectionChange, onContextMenu, className, showMarks, pageView, pageSettings, zoom = 1, onZoomChange, styleDefaults }, ref) => {
    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5] },
        }),
        PageBreakShortcut,
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
          allowBase64: true,
          HTMLAttributes: {
            class: 'max-w-full rounded border border-gray-200 my-2',
          },
        }),
        TableRow,
        TableCell,
        TableHeader,
        TableOfContents,
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
        transformPastedHTML(html: string) {
          return html.replace(/font-family\s*:\s*[^;"]+;?/gi, '');
        },
        // Intercept anchor link clicks at ProseMirror level — before TipTap Link plugin and browser
        handleClick(view, _pos, event) {
          const target = event.target as HTMLElement;
          const link = target.closest('a');
          if (!link) return false;
          const href = link.getAttribute('href');
          if (!href || !href.startsWith('#')) return false;

          event.preventDefault();
          event.stopPropagation();

          const slug = href.slice(1);
          const { doc } = view.state;

          doc.descendants((node, nodePos) => {
            if (node.type.name === 'heading') {
              const headingSlug = node.textContent
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 80);
              if (headingSlug === slug) {
                view.dispatch(view.state.tr.setSelection(
                  (view.state.selection.constructor as any).near(doc.resolve(nodePos))
                ));
                // Scroll heading to top of viewport
                try {
                  const domAtPos = view.domAtPos(nodePos);
                  const domNode = domAtPos.node instanceof HTMLElement
                    ? domAtPos.node : domAtPos.node.parentElement;
                  if (domNode) {
                    const scrollContainer = view.dom.closest('.overflow-auto, .overflow-y-auto') || view.dom.parentElement;
                    if (scrollContainer) {
                      const nodeRect = domNode.getBoundingClientRect();
                      const containerRect = scrollContainer.getBoundingClientRect();
                      scrollContainer.scrollBy({ top: nodeRect.top - containerRect.top - 20, behavior: 'smooth' });
                    }
                  }
                } catch {
                  // fallback
                }
                return false;
              }
            }
          });
          return true; // handled — prevent TipTap/browser from opening new tab
        },
      },
    });

    // Image click → floating toolbar
    const [selectedImage, setSelectedImage] = useState<HTMLImageElement | null>(null);

    useEffect(() => {
      if (!editor) return;
      const el = editor.view.dom;
      const handleImageClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'IMG' && target.closest('.ProseMirror')) {
          e.stopPropagation();
          setSelectedImage(target as HTMLImageElement);
        } else if (!target.closest('[data-image-toolbar]')) {
          setSelectedImage(null);
        }
      };
      el.addEventListener('click', handleImageClick);
      return () => el.removeEventListener('click', handleImageClick);
    }, [editor]);

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

    // Page view is CSS-only (no pagination plugin) until Tiptap Pages Pro is available

    // Context menu listener
    useEffect(() => {
      if (!editor || !onContextMenu) return;
      const el = editor.view.dom;
      const handler = (e: MouseEvent) => onContextMenu(e);
      el.addEventListener('contextmenu', handler);
      return () => el.removeEventListener('contextmenu', handler);
    }, [editor, onContextMenu]);

    // Anchor link handling is done in editorProps.handleClick above (ProseMirror level)

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
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const onZoomChangeRef = useRef(onZoomChange);
    onZoomChangeRef.current = onZoomChange;

    useEffect(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const handler = (e: WheelEvent) => {
        if ((e.ctrlKey || e.metaKey) && onZoomChangeRef.current) {
          e.preventDefault();
          const delta = e.deltaY > 0 ? -0.05 : 0.05;
          onZoomChangeRef.current(Math.min(2, Math.max(0.5, zoomRef.current + delta)));
        }
      };
      el.addEventListener('wheel', handler, { passive: false });
      return () => el.removeEventListener('wheel', handler);
    }, []); // stable — no deps, uses refs

    if (!editor) {
      return (
        <div className={`bg-white flex-1 flex items-center justify-center text-gray-400 ${className ?? ''}`}>
          Loading editor...
        </div>
      );
    }

    // Page dimensions for CSS page view
    const ps = pageSettings || { pageSize: 'letter', marginTop: 96, marginBottom: 96, marginLeft: 96, marginRight: 96 };
    const PAGE_DIMS: Record<string, { w: number; h: number }> = {
      letter: { w: 816, h: 1056 },
      a4: { w: 794, h: 1123 },
      legal: { w: 816, h: 1344 },
    };
    const dims = PAGE_DIMS[ps.pageSize] || PAGE_DIMS.letter;

    const wrapperClasses = [
      'draft-editor-wrapper',
      'overflow-auto flex-1',
      showMarks ? 'show-marks' : '',
      pageView ? 'page-view' : 'bg-white',
      className ?? '',
    ].filter(Boolean).join(' ');

    return (
      <div ref={wrapperRef} className={wrapperClasses} data-page-size={ps.pageSize}>
        <style>{`
          /* --- Image styling --- */
          .draft-editor-wrapper .ProseMirror img {
            cursor: pointer;
            transition: outline 0.1s;
          }
          .draft-editor-wrapper .ProseMirror img:hover {
            outline: 2px solid #93c5fd;
            outline-offset: 2px;
          }
          .draft-editor-wrapper .ProseMirror img.ProseMirror-selectednode {
            outline: 2px solid #3b82f6;
          }
          /* Float images: text in subsequent paragraphs wraps around them */
          .draft-editor-wrapper .ProseMirror img[data-wrapping="float-left"] {
            float: left !important;
            margin-right: 16px !important;
            margin-bottom: 8px !important;
            clear: left;
          }
          .draft-editor-wrapper .ProseMirror img[data-wrapping="float-right"] {
            float: right !important;
            margin-left: 16px !important;
            margin-bottom: 8px !important;
            clear: right;
          }
          .draft-editor-wrapper .ProseMirror img[data-wrapping="block"] {
            display: block !important;
            margin-left: auto !important;
            margin-right: auto !important;
          }
          /* Clearfix: ensure floated images don't overflow their container */
          .draft-editor-wrapper .ProseMirror::after {
            content: '';
            display: table;
            clear: both;
            outline-offset: 2px;
          }

          /* --- Style defaults from admin config --- */
          .draft-editor-wrapper .ProseMirror {
            font-family: ${styleDefaults?.defaultFont || 'Times New Roman'}, serif;
            font-size: ${styleDefaults?.defaultFontSize || '12px'};
            line-height: ${styleDefaults?.lineSpacing || '1.5'};
          }
          .draft-editor-wrapper .ProseMirror p {
            margin-bottom: ${styleDefaults?.paragraphSpacing || '12px'};
          }
          .draft-editor-wrapper .ProseMirror h1 { font-size: ${styleDefaults?.h1Size || '24px'}; margin-bottom: ${styleDefaults?.paragraphSpacing || '12px'}; }
          .draft-editor-wrapper .ProseMirror h2 { font-size: ${styleDefaults?.h2Size || '20px'}; margin-bottom: ${styleDefaults?.paragraphSpacing || '12px'}; }
          .draft-editor-wrapper .ProseMirror h3 { font-size: ${styleDefaults?.h3Size || '16px'}; margin-bottom: ${styleDefaults?.paragraphSpacing || '12px'}; }
          .draft-editor-wrapper .ProseMirror h4 { font-size: ${styleDefaults?.h4Size || '14px'}; margin-bottom: ${styleDefaults?.paragraphSpacing || '12px'}; }
          .draft-editor-wrapper .ProseMirror h5 { font-size: ${styleDefaults?.h5Size || '12px'}; margin-bottom: ${styleDefaults?.paragraphSpacing || '12px'}; }

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
          .draft-editor-wrapper.show-marks .ProseMirror h4::after,
          .draft-editor-wrapper.show-marks .ProseMirror h5::after,
          .draft-editor-wrapper.show-marks .ProseMirror li > p::after {
            content: '¶';
            color: #93c5fd;
            font-size: 0.75em;
            margin-left: 2px;
            font-family: sans-serif;
            pointer-events: none;
          }
          /* Hard break (Shift+Enter) marker — show ↵ before line breaks in Chromium */
          .draft-editor-wrapper.show-marks .ProseMirror br:not(.ProseMirror-trailingBreak) {
            position: relative;
            display: inline;
          }
          .draft-editor-wrapper.show-marks .ProseMirror br:not(.ProseMirror-trailingBreak)::before {
            content: '↵';
            color: #93c5fd;
            font-size: 0.75em;
            font-family: sans-serif;
            pointer-events: none;
          }
          /* Empty paragraphs: ensure ¶ is visible and paragraph is selectable */
          .draft-editor-wrapper.show-marks .ProseMirror p:empty::after,
          .draft-editor-wrapper.show-marks .ProseMirror p:has(> br:only-child)::after {
            display: inline;
          }
          .draft-editor-wrapper.show-marks .ProseMirror p:has(> br:only-child) {
            min-height: 1em;
          }
          .draft-editor-wrapper.show-marks .ProseMirror {
            word-spacing: 0.15em;
          }

          /* --- Page view --- */
          .draft-editor-wrapper.page-view {
            background-color: #e5e7eb;
            background-image:
              linear-gradient(to bottom, transparent calc(100% - 1px), #bfdbfe calc(100% - 1px), #bfdbfe 100%);
            background-size: 100% ${dims.h}px;
            background-position: 0 32px;
            padding: 32px 0;
          }
          .draft-editor-wrapper.page-view .ProseMirror {
            width: ${dims.w}px;
            min-height: ${dims.h}px;
            padding: ${ps.marginTop}px ${ps.marginRight}px ${ps.marginBottom}px ${ps.marginLeft}px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1), 0 0 1px rgba(0,0,0,0.08);
            border: 1px solid #d1d5db;
            margin: 0 auto;
            background: white;
          }
          .draft-editor-wrapper.page-view .ProseMirror > * {
            max-width: 100%;
            overflow-wrap: break-word;
          }
          .draft-editor-wrapper.page-view hr {
            border: none;
            margin: ${ps.marginBottom}px -${ps.marginRight}px ${ps.marginTop}px -${ps.marginLeft}px;
            height: 40px;
            background: #e5e7eb;
            position: relative;
          }
          .draft-editor-wrapper.page-view hr::after {
            content: 'Page Break';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: #e5e7eb;
            padding: 0 0.75rem;
            font-size: 11px;
            color: #9ca3af;
          }
        `}</style>
        <div
          className="draft-zoom-inner"
          style={zoom !== 1 ? { zoom } : undefined}
        >
          <EditorContent editor={editor} />
        </div>

        {/* Image floating toolbar */}
        {selectedImage && editor && (
          <Suspense fallback={null}>
            <ImageToolbar
              editor={editor}
              imageEl={selectedImage}
              onClose={() => setSelectedImage(null)}
            />
          </Suspense>
        )}
      </div>
    );
  }
);

DraftEditor.displayName = 'DraftEditor';

export default DraftEditor;
