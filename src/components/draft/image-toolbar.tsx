'use client';

import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import type { Editor } from '@tiptap/react';

const ImageEditorModal = lazy(() => import('./image-editor-modal'));

interface ImageToolbarProps {
  editor: Editor;
  imageEl: HTMLImageElement;
  onClose: () => void;
}

const MIN_WIDTH = 50;
const MAX_WIDTH = 1200;

type WrapMode = 'inline' | 'float-left' | 'float-right' | 'block';

const WRAP_OPTIONS: { value: WrapMode; label: string; icon: React.ReactNode }[] = [
  {
    value: 'inline',
    label: 'In line',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.7">
        <rect x="1" y="2" width="4" height="4" rx="0.5" />
        <rect x="6" y="3" width="9" height="1.5" rx="0.5" />
        <rect x="1" y="8" width="14" height="1.5" rx="0.5" />
        <rect x="1" y="12" width="10" height="1.5" rx="0.5" />
      </svg>
    ),
  },
  {
    value: 'float-left',
    label: 'Left',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.7">
        <rect x="1" y="1" width="5" height="5" rx="0.5" />
        <rect x="7" y="2" width="8" height="1.5" rx="0.5" />
        <rect x="7" y="5" width="8" height="1.5" rx="0.5" />
        <rect x="1" y="8" width="14" height="1.5" rx="0.5" />
        <rect x="1" y="12" width="10" height="1.5" rx="0.5" />
      </svg>
    ),
  },
  {
    value: 'float-right',
    label: 'Right',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.7">
        <rect x="10" y="1" width="5" height="5" rx="0.5" />
        <rect x="1" y="2" width="8" height="1.5" rx="0.5" />
        <rect x="1" y="5" width="8" height="1.5" rx="0.5" />
        <rect x="1" y="8" width="14" height="1.5" rx="0.5" />
        <rect x="1" y="12" width="10" height="1.5" rx="0.5" />
      </svg>
    ),
  },
  {
    value: 'block',
    label: 'Center',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.7">
        <rect x="4" y="1" width="8" height="5" rx="0.5" />
        <rect x="1" y="8" width="14" height="1.5" rx="0.5" />
        <rect x="1" y="12" width="10" height="1.5" rx="0.5" />
      </svg>
    ),
  },
];

/**
 * Floating toolbar that appears when an image is clicked in the editor.
 * Provides: slider resize, edit (crop/annotate/redact), and delete.
 */
export default function ImageToolbar({ editor, imageEl, onClose }: ImageToolbarProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [sliderValue, setSliderValue] = useState(() => {
    const w = imageEl.getAttribute('width');
    return w ? parseInt(w, 10) : (imageEl.naturalWidth || imageEl.offsetWidth || 400);
  });
  const [inputValue, setInputValue] = useState(String(sliderValue));
  const [wrapMode, setWrapMode] = useState<WrapMode>(() => {
    // Read current wrapping from the image's TipTap node attrs
    let current: WrapMode = 'inline';
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image' && node.attrs.src === imageEl.getAttribute('src')) {
        current = node.attrs.wrapping || 'inline';
        return false;
      }
    });
    return current;
  });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Helper: find image node position using FRESH editor state
  const findImagePos = useCallback((): number => {
    const src = imageEl.getAttribute('src');
    let found = -1;
    editor.view.state.doc.descendants((node, nodePos) => {
      if (node.type.name === 'image' && node.attrs.src === src) {
        found = nodePos;
        return false;
      }
    });
    return found;
  }, [editor, imageEl]);

  // Update any image attribute using fresh state
  const updateImageAttr = useCallback((attrs: Record<string, any>) => {
    const pos = findImagePos();
    if (pos < 0) return;
    const state = editor.view.state;
    const node = state.doc.nodeAt(pos);
    if (!node) return;
    editor.view.dispatch(
      state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
    );
  }, [editor, findImagePos]);

  // Commit width to TipTap
  const commitWidth = useCallback((newWidth: number) => {
    updateImageAttr({ width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth)) });
  }, [updateImageAttr]);

  // Update wrapping mode
  const handleWrapChange = useCallback((mode: WrapMode) => {
    setWrapMode(mode);
    updateImageAttr({ wrapping: mode });
  }, [updateImageAttr]);

  // Move image up or down
  const handleMoveImage = useCallback((direction: 'up' | 'down') => {
    const pos = findImagePos();
    if (pos < 0) return;
    const state = editor.view.state;
    const resolved = state.doc.resolve(pos);
    const parentDepth = resolved.depth;
    const blockStart = resolved.before(parentDepth);
    const blockEnd = resolved.after(parentDepth);

    if (direction === 'up' && blockStart > 0) {
      const prevResolved = state.doc.resolve(blockStart - 1);
      const prevStart = prevResolved.before(prevResolved.depth);
      const tr = state.tr;
      const block = tr.doc.slice(blockStart, blockEnd);
      tr.delete(blockStart, blockEnd);
      tr.insert(prevStart, block.content);
      editor.view.dispatch(tr);
    } else if (direction === 'down' && blockEnd < state.doc.content.size) {
      const nextNode = state.doc.nodeAt(blockEnd);
      if (nextNode) {
        const nextEnd = blockEnd + nextNode.nodeSize;
        const tr = state.tr;
        const nextBlock = tr.doc.slice(blockEnd, nextEnd);
        tr.delete(blockEnd, nextEnd);
        tr.insert(blockStart, nextBlock.content);
        editor.view.dispatch(tr);
      }
    }
  }, [editor, findImagePos]);

  // Position toolbar above the image
  useEffect(() => {
    const updatePos = () => {
      const rect = imageEl.getBoundingClientRect();
      setPos({
        top: rect.top - 48,
        left: rect.left + rect.width / 2,
      });
    };
    updatePos();
    // Reposition when slider changes (image size changes)
    const raf = requestAnimationFrame(updatePos);
    return () => cancelAnimationFrame(raf);
  }, [imageEl, sliderValue]);

  // Close on click outside — but NOT when editor modal is open
  useEffect(() => {
    if (editorOpen) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (toolbarRef.current?.contains(target)) return;
      if (target === imageEl) return;
      if (target.closest('[data-image-editor-modal]')) return;
      onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editorOpen) onClose();
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
      document.addEventListener('keydown', handleEsc);
    }, 150);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose, imageEl, editorOpen]);

  // Visual selection outline + make image draggable
  useEffect(() => {
    imageEl.style.outline = '2px solid #3b82f6';
    imageEl.style.outlineOffset = '2px';
    imageEl.draggable = true;
    imageEl.style.cursor = 'grab';

    const handleDragStart = (e: DragEvent) => {
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', imageEl.getAttribute('src') || '');
        imageEl.style.opacity = '0.5';
      }
    };
    const handleDragEnd = () => {
      imageEl.style.opacity = '1';
    };

    imageEl.addEventListener('dragstart', handleDragStart);
    imageEl.addEventListener('dragend', handleDragEnd);

    // Enable drop on the editor
    const proseMirror = imageEl.closest('.ProseMirror');
    const handleDragOver = (e: Event) => {
      (e as DragEvent).preventDefault();
      if ((e as DragEvent).dataTransfer) {
        (e as DragEvent).dataTransfer!.dropEffect = 'move';
      }
    };
    const handleDrop = (e: Event) => {
      const de = e as DragEvent;
      de.preventDefault();
      const src = de.dataTransfer?.getData('text/plain');
      if (!src || src !== imageEl.getAttribute('src')) return;

      // Find drop position in the document
      const view = editor.view;
      const dropPos = view.posAtCoords({ left: de.clientX, top: de.clientY });
      if (!dropPos) return;

      // Find and remove the image from its current position
      const imgPos = findImagePos();
      if (imgPos < 0) return;

      const state = view.state;
      const node = state.doc.nodeAt(imgPos);
      if (!node) return;

      // Create transaction: delete old, insert at new position
      let tr = state.tr;
      const nodeSize = node.nodeSize;
      tr = tr.delete(imgPos, imgPos + nodeSize);

      // Adjust drop position if it's after the deleted node
      let insertPos = dropPos.pos;
      if (insertPos > imgPos) {
        insertPos -= nodeSize;
      }
      // Clamp to valid range
      insertPos = Math.max(0, Math.min(insertPos, tr.doc.content.size));

      tr = tr.insert(insertPos, node);
      view.dispatch(tr);
      onClose(); // Close toolbar since image moved
    };

    proseMirror?.addEventListener('dragover', handleDragOver);
    proseMirror?.addEventListener('drop', handleDrop);

    return () => {
      imageEl.style.outline = '';
      imageEl.style.outlineOffset = '';
      imageEl.style.cursor = '';
      imageEl.draggable = false;
      imageEl.removeEventListener('dragstart', handleDragStart);
      imageEl.removeEventListener('dragend', handleDragEnd);
      proseMirror?.removeEventListener('dragover', handleDragOver);
      proseMirror?.removeEventListener('drop', handleDrop);
    };
  }, [imageEl, editor, findImagePos, onClose]);

  // Slider change — update preview immediately, debounce TipTap commit
  const handleSliderChange = (val: number) => {
    setSliderValue(val);
    setInputValue(String(val));
    // Live preview: update DOM directly for smooth feel
    imageEl.style.width = `${val}px`;
    imageEl.setAttribute('width', String(val));
    // Debounce TipTap update
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => commitWidth(val), 300);
  };

  // Text input — only commit on Enter or blur
  const handleInputCommit = () => {
    const parsed = parseInt(inputValue, 10);
    if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
      setSliderValue(parsed);
      commitWidth(parsed);
      imageEl.style.width = `${parsed}px`;
      imageEl.setAttribute('width', String(parsed));
    } else {
      setInputValue(String(sliderValue));
    }
  };

  const handleDelete = () => {
    const { state } = editor;
    state.doc.descendants((node, nodePos) => {
      if (node.type.name === 'image' && node.attrs.src === imageEl.getAttribute('src')) {
        editor.chain().setNodeSelection(nodePos).deleteSelection().run();
        return false;
      }
    });
    onClose();
  };

  const handleEditSave = (dataUrl: string) => {
    const { state } = editor;
    state.doc.descendants((node, nodePos) => {
      if (node.type.name === 'image' && node.attrs.src === imageEl.getAttribute('src')) {
        editor.view.dispatch(
          state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, src: dataUrl })
        );
        return false;
      }
    });
    setEditorOpen(false);
    onClose();
  };

  return (
    <>
      <div
        ref={toolbarRef}
        className="fixed z-[120] bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 flex items-center gap-2 -translate-x-1/2"
        style={{ top: Math.max(8, pos.top), left: pos.left }}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Width input — scroll wheel to resize, type to set exact value */}
        <input
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onBlur={handleInputCommit}
          onKeyDown={e => {
            if (e.key === 'Enter') handleInputCommit();
            // Arrow keys for fine control
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.shiftKey ? 10 : 1;
              handleSliderChange(sliderValue + step);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const step = e.shiftKey ? 10 : 1;
              handleSliderChange(sliderValue - step);
            }
          }}
          onWheel={e => {
            e.preventDefault();
            const step = e.shiftKey ? 10 : 2;
            const delta = e.deltaY < 0 ? step : -step;
            handleSliderChange(sliderValue + delta);
          }}
          className="w-14 px-1.5 py-0.5 text-xs text-center border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
          title="Width — scroll to resize, arrows for fine control (Shift=10x)"
        />
        {/* Draggable "px" label — hold and drag left/right to scale */}
        <span
          className="text-[10px] text-gray-400 cursor-ew-resize select-none hover:text-blue-500 font-medium px-0.5"
          title="Drag left/right to resize"
          onMouseDown={e => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = sliderValue;
            const onMove = (ev: MouseEvent) => {
              const dx = ev.clientX - startX;
              handleSliderChange(startWidth + dx);
            };
            const onUp = () => {
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            };
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        >
          px
        </span>

        <div className="w-px h-5 bg-gray-300 mx-0.5" />

        {/* Wrap mode — with text labels */}
        <div className="flex items-center">
          <span className="text-[9px] text-gray-400 mr-1">Wrap:</span>
          <div className="flex items-center gap-0.5">
            {WRAP_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handleWrapChange(opt.value)}
                className={`h-6 px-1.5 flex items-center gap-1 rounded text-[10px] transition-colors ${
                  wrapMode === opt.value
                    ? 'bg-blue-100 text-blue-700 font-medium'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
                title={opt.label}
              >
                {opt.icon}
                <span className="hidden sm:inline">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="w-px h-5 bg-gray-300 mx-0.5" />

        {/* Move up/down */}
        <button
          onClick={() => handleMoveImage('up')}
          className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:bg-gray-100"
          title="Move image up"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        <button
          onClick={() => handleMoveImage('down')}
          className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:bg-gray-100"
          title="Move image down"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <div className="w-px h-5 bg-gray-300 mx-0.5" />

        {/* Edit */}
        <button
          onClick={() => setEditorOpen(true)}
          className="h-7 px-2 flex items-center gap-1 rounded text-xs font-medium text-gray-700 hover:bg-gray-100"
          title="Edit image (crop, annotate, redact)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Edit
        </button>

        {/* Delete */}
        <button
          onClick={handleDelete}
          className="h-7 px-2 flex items-center gap-1 rounded text-xs font-medium text-red-600 hover:bg-red-50"
          title="Delete image"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
          Delete
        </button>
      </div>

      {/* Image Editor Modal */}
      {editorOpen && (
        <Suspense fallback={null}>
          <ImageEditorModal
            imageSrc={imageEl.src}
            onSave={handleEditSave}
            onClose={() => setEditorOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
