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
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { FontSize } from '@/lib/draft/font-size-extension';

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

interface DraftEditorProps {
  content: string | object;
  onUpdate: (json: string) => void;
  onSelectionChange?: (sel: { selectedText: string; hasSelection: boolean }) => void;
  onContextMenu?: (e: MouseEvent) => void;
  className?: string;
}

const DraftEditor = forwardRef<DraftEditorHandle, DraftEditorProps>(
  ({ content, onUpdate, onSelectionChange, onContextMenu, className }, ref) => {
    const editor = useEditor({
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
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
        TableRow,
        TableCell,
        TableHeader,
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

    // Context menu listener
    useEffect(() => {
      if (!editor || !onContextMenu) return;
      const el = editor.view.dom;
      const handler = (e: MouseEvent) => onContextMenu(e);
      el.addEventListener('contextmenu', handler);
      return () => el.removeEventListener('contextmenu', handler);
    }, [editor, onContextMenu]);

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

    if (!editor) {
      return (
        <div className={`bg-white flex-1 flex items-center justify-center text-gray-400 ${className ?? ''}`}>
          Loading editor...
        </div>
      );
    }

    return (
      <div className={`bg-white overflow-auto flex-1 ${className ?? ''}`}>
        <EditorContent editor={editor} />
      </div>
    );
  }
);

DraftEditor.displayName = 'DraftEditor';

export default DraftEditor;
