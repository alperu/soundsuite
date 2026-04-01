'use client';

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import React, { useCallback, useEffect, useState } from 'react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type TOCStyle = 'default' | 'formal' | 'minimal' | 'dotted' | 'boxed';

interface HeadingEntry {
  level: number;
  text: string;
  pos: number;
}

interface TOCAttrs {
  tocStyle: TOCStyle;
  showNumbers: boolean;
  maxDepth: number;
}

/* ------------------------------------------------------------------ */
/*  TypeScript module augmentation                                      */
/* ------------------------------------------------------------------ */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableOfContents: {
      insertTableOfContents: () => ReturnType;
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Numbering helper                                                    */
/* ------------------------------------------------------------------ */

function computeNumbering(headings: HeadingEntry[]): string[] {
  const counters = [0, 0, 0]; // H1, H2, H3
  return headings.map((h) => {
    const idx = h.level - 1; // 0-based
    counters[idx]++;
    // Reset all deeper counters
    for (let i = idx + 1; i < counters.length; i++) {
      counters[i] = 0;
    }
    return counters.slice(0, idx + 1).join('.') + '.';
  });
}

/* ------------------------------------------------------------------ */
/*  Style helpers                                                       */
/* ------------------------------------------------------------------ */

function wrapperClass(style: TOCStyle): string {
  switch (style) {
    case 'default':
      return 'border-l-4 border-blue-500 pl-4 py-2';
    case 'formal':
      return 'py-3';
    case 'minimal':
      return 'py-1';
    case 'dotted':
      return 'py-2';
    case 'boxed':
      return 'bg-gray-50 border border-gray-200 rounded-lg p-4';
    default:
      return '';
  }
}

function headerText(style: TOCStyle): string {
  return style === 'formal' ? 'TABLE OF CONTENTS' : 'Table of Contents';
}

function headerClass(style: TOCStyle): string {
  const base = 'mb-2 font-semibold select-none';
  switch (style) {
    case 'formal':
      return `${base} text-center text-sm tracking-widest text-gray-600 uppercase`;
    case 'minimal':
      return `${base} text-xs text-gray-400`;
    default:
      return `${base} text-sm text-gray-500`;
  }
}

function entryClass(style: TOCStyle, level: number): string {
  const indent = `pl-${(level - 1) * 4}`;
  switch (style) {
    case 'default':
      return `${indent} py-0.5 text-blue-600 hover:text-blue-800 cursor-pointer`;
    case 'formal':
      return `${indent} py-0.5 text-gray-700 cursor-pointer hover:text-gray-900`;
    case 'minimal':
      return `${indent} py-px text-xs text-gray-500 cursor-pointer hover:text-gray-700`;
    case 'dotted':
      return `${indent} py-0.5 cursor-pointer text-gray-700 hover:text-gray-900 flex items-baseline`;
    case 'boxed':
      return `${indent} py-0.5 text-gray-700 cursor-pointer hover:text-blue-600`;
    default:
      return `${indent} py-0.5 cursor-pointer`;
  }
}

/* ------------------------------------------------------------------ */
/*  React NodeView                                                      */
/* ------------------------------------------------------------------ */

function TOCNodeView({ editor, node }: any) {
  const { tocStyle, showNumbers, maxDepth, fontFamily } = node.attrs;

  // Inherit font from editor if not explicitly set on TOC
  const effectiveFont = fontFamily || editor?.getAttributes?.('textStyle')?.fontFamily || '';

  const extractHeadings = useCallback((): HeadingEntry[] => {
    const entries: HeadingEntry[] = [];
    if (!editor || !editor.state) return entries;
    editor.state.doc.descendants((n: any, pos: number) => {
      if (n.type.name === 'heading') {
        const level: number = n.attrs.level ?? 1;
        if (level <= maxDepth) {
          entries.push({ level, text: n.textContent, pos });
        }
      }
    });
    return entries;
  }, [editor, maxDepth]);

  const [headings, setHeadings] = useState<HeadingEntry[]>(() => extractHeadings());

  useEffect(() => {
    if (!editor) return;
    const handler = () => setHeadings(extractHeadings());
    editor.on('update', handler);
    // Initial sync
    handler();
    return () => {
      editor.off('update', handler);
    };
  }, [editor, extractHeadings]);

  const numbers = showNumbers ? computeNumbering(headings) : null;

  const handleClick = (pos: number) => {
    editor.chain().setTextSelection(pos).scrollIntoView().run();
  };

  return (
    <NodeViewWrapper
      data-type="table-of-contents"
      style={effectiveFont ? { fontFamily: effectiveFont } : undefined}
      onContextMenu={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const event = new CustomEvent('toc-contextmenu', {
          detail: { x: e.clientX, y: e.clientY, attrs: node.attrs },
          bubbles: true,
        });
        e.currentTarget.dispatchEvent(event);
      }}
    >
      <div
        className={`${wrapperClass(tocStyle)} my-4 select-none`}
        contentEditable={false}
      >
        {/* Header */}
        <div className={headerClass(tocStyle)}>{headerText(tocStyle)}</div>

        {/* Empty state */}
        {headings.length === 0 && (
          <p className="text-sm italic text-gray-400">
            No headings found. Add H1, H2, or H3 headings to generate the table of contents.
          </p>
        )}

        {/* Entries */}
        {headings.map((h, i) => (
          <div
            key={`${h.pos}-${i}`}
            className={entryClass(tocStyle, h.level)}
            onClick={() => handleClick(h.pos)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleClick(h.pos);
            }}
          >
            {tocStyle === 'dotted' ? (
              <>
                <span className="whitespace-nowrap">
                  {numbers ? `${numbers[i]} ` : ''}
                  {h.text}
                </span>
                <span className="flex-1 mx-2 border-b border-dotted border-gray-400" />
              </>
            ) : (
              <span>
                {numbers ? `${numbers[i]} ` : ''}
                {h.text}
              </span>
            )}
          </div>
        ))}
      </div>
    </NodeViewWrapper>
  );
}

/* ------------------------------------------------------------------ */
/*  TipTap Node Extension                                               */
/* ------------------------------------------------------------------ */

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      tocStyle: {
        default: 'default',
      },
      showNumbers: {
        default: true,
      },
      maxDepth: {
        default: 3,
      },
      fontFamily: {
        default: null,
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="table-of-contents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'table-of-contents' }),
    ];
  },

  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {},
          });
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(TOCNodeView);
  },
});

export default TableOfContents;
