'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface HeadingItem {
  level: number;
  text: string;
  pos: number;
}

interface HeadingNavProps {
  editor: any; // TipTap Editor instance
  scrollContainer: HTMLElement | null;
}

const INDENT_BY_LEVEL: Record<number, string> = {
  1: 'pl-0',
  2: 'pl-3',
  3: 'pl-6',
  4: 'pl-9',
  5: 'pl-12',
};

const STYLE_BY_LEVEL: Record<number, string> = {
  1: 'text-xs font-semibold',
  2: 'text-xs font-medium',
};

function getHeadingStyle(level: number): string {
  return STYLE_BY_LEVEL[level] || 'text-xs';
}

const DraftHeadingNav: React.FC<HeadingNavProps> = ({ editor, scrollContainer }) => {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const navRef = useRef<HTMLDivElement>(null);

  const extractHeadings = useCallback(() => {
    if (!editor?.state?.doc) return;

    const items: HeadingItem[] = [];
    editor.state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === 'heading') {
        items.push({
          level: node.attrs.level ?? 1,
          text: node.textContent,
          pos,
        });
      }
    });
    setHeadings(items);
  }, [editor]);

  // Extract headings on editor updates
  useEffect(() => {
    if (!editor) return;

    extractHeadings();
    editor.on('update', extractHeadings);

    return () => {
      editor.off('update', extractHeadings);
    };
  }, [editor, extractHeadings]);

  // Track active heading based on scroll position
  const updateActiveHeading = useCallback(() => {
    if (!editor?.view || !scrollContainer || headings.length === 0) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const viewportTop = containerRect.top;

    let closestIndex = 0;
    let closestDistance = Infinity;

    for (let i = 0; i < headings.length; i++) {
      try {
        const coords = editor.view.coordsAtPos(headings[i].pos);
        const distance = coords.top - viewportTop;

        // Find the last heading that is above or at the viewport top
        if (distance <= 20) {
          closestIndex = i;
          closestDistance = Math.abs(distance);
        } else if (distance > 20 && distance < closestDistance && closestIndex === 0 && i === 0) {
          // If no heading is above viewport, use the first one that's closest
          closestIndex = i;
          closestDistance = distance;
        }
      } catch {
        // coordsAtPos can throw if pos is out of range
      }
    }

    setActiveIndex(closestIndex);
  }, [editor, scrollContainer, headings]);

  useEffect(() => {
    if (!scrollContainer) return;

    updateActiveHeading();
    scrollContainer.addEventListener('scroll', updateActiveHeading, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', updateActiveHeading);
    };
  }, [scrollContainer, updateActiveHeading]);

  const handleHeadingClick = useCallback(
    (pos: number) => {
      if (!editor) return;
      editor.chain().focus().setTextSelection(pos).run();

      // Find the scroll container dynamically (the overflow-y-auto parent of the editor)
      const sc = scrollContainer || editor.view.dom.closest('.overflow-y-auto');
      try {
        const domAtPos = editor.view.domAtPos(pos);
        const domNode = domAtPos.node instanceof HTMLElement
          ? domAtPos.node
          : domAtPos.node.parentElement;
        if (domNode && sc) {
          const nodeRect = domNode.getBoundingClientRect();
          const containerRect = sc.getBoundingClientRect();
          const offset = nodeRect.top - containerRect.top - 20;
          sc.scrollBy({ top: offset, behavior: 'smooth' });
        } else {
          // Last resort fallback
          editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
        }
      } catch {
        editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
      }
    },
    [editor, scrollContainer]
  );

  return (
    <div ref={navRef} className="flex flex-col h-full overflow-hidden">
      {/* Title */}
      <div className="px-3 py-2 text-xs font-semibold text-gray-500 border-b border-gray-100">
        Outline
      </div>

      {/* Heading list */}
      <div className="flex-1 overflow-y-auto py-1">
        {headings.length === 0 ? (
          <div className="px-3 py-2 text-xs text-gray-400 italic">No headings</div>
        ) : (
          headings.map((heading, index) => {
            const isActive = index === activeIndex;
            const indent = INDENT_BY_LEVEL[heading.level] || 'pl-12';
            const style = getHeadingStyle(heading.level);

            return (
              <button
                key={`${heading.pos}-${index}`}
                onClick={() => handleHeadingClick(heading.pos)}
                className={`
                  block w-full text-left px-3 py-1 truncate transition-colors
                  ${indent} ${style}
                  ${
                    isActive
                      ? 'text-blue-600 border-l-2 border-blue-500'
                      : 'text-gray-600 hover:text-gray-800 hover:bg-gray-50 border-l-2 border-transparent'
                  }
                `}
                title={heading.text}
              >
                {heading.text || '\u00A0'}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};

export default React.memo(DraftHeadingNav);
