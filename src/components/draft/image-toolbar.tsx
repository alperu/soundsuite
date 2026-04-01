'use client';

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import type { Editor } from '@tiptap/react';

const ImageEditorModal = lazy(() => import('./image-editor-modal'));

interface ImageToolbarProps {
  editor: Editor;
  imageEl: HTMLImageElement;
  onClose: () => void;
}

/**
 * Floating toolbar that appears when an image is clicked in the editor.
 * Provides: width resize, edit (crop/annotate/redact), and delete.
 */
export default function ImageToolbar({ editor, imageEl, onClose }: ImageToolbarProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [width, setWidth] = useState(() => {
    // Get current width from the image's style or natural size
    return imageEl.getAttribute('width')
      ? parseInt(imageEl.getAttribute('width')!, 10)
      : imageEl.naturalWidth || imageEl.offsetWidth;
  });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  // Position toolbar above the image
  useEffect(() => {
    const rect = imageEl.getBoundingClientRect();
    setPos({
      top: rect.top - 44,
      left: rect.left + rect.width / 2,
    });
  }, [imageEl, width]);

  // Close on click outside — but NOT when editor modal is open
  useEffect(() => {
    if (editorOpen) return; // Don't register close handlers while modal is open

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't close if clicking inside toolbar, the image itself, or any modal overlay
      if (toolbarRef.current?.contains(target)) return;
      if (target === imageEl) return;
      if (target.closest('[data-image-editor-modal]')) return;
      onClose();
    };
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Delay to avoid the initial click that opened this
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
      document.addEventListener('keydown', handleEsc);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose, imageEl, editorOpen]);

  // Add visual selection to image
  useEffect(() => {
    imageEl.style.outline = '2px solid #3b82f6';
    imageEl.style.outlineOffset = '2px';
    return () => {
      imageEl.style.outline = '';
      imageEl.style.outlineOffset = '';
    };
  }, [imageEl]);

  const handleResize = (newWidth: number) => {
    const clamped = Math.max(50, Math.min(1200, newWidth));
    setWidth(clamped);
    // Update the image in TipTap by finding its position and updating attrs
    const { state } = editor;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && node.attrs.src === imageEl.getAttribute('src')) {
        editor.chain().setNodeSelection(pos).updateAttributes('image', { width: clamped }).run();
        return false;
      }
    });
  };

  const handleDelete = () => {
    const { state } = editor;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && node.attrs.src === imageEl.getAttribute('src')) {
        editor.chain().setNodeSelection(pos).deleteSelection().run();
        return false;
      }
    });
    onClose();
  };

  const handleEditSave = (dataUrl: string) => {
    // Replace the image src with the edited version
    const { state } = editor;
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && node.attrs.src === imageEl.getAttribute('src')) {
        editor.chain().setNodeSelection(pos).updateAttributes('image', { src: dataUrl }).run();
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
        className="fixed z-[120] bg-white border border-gray-200 rounded-lg shadow-lg px-2 py-1.5 flex items-center gap-1.5 -translate-x-1/2"
        style={{ top: Math.max(8, pos.top), left: pos.left }}
      >
        {/* Resize controls */}
        <button
          onClick={() => handleResize(width - 50)}
          className="w-7 h-7 flex items-center justify-center rounded text-gray-600 hover:bg-gray-100 text-xs font-bold"
          title="Shrink"
        >
          &minus;
        </button>
        <input
          type="number"
          value={width}
          onChange={e => handleResize(parseInt(e.target.value, 10) || width)}
          className="w-16 px-1.5 py-0.5 text-xs text-center border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-400"
          title="Width (px)"
        />
        <button
          onClick={() => handleResize(width + 50)}
          className="w-7 h-7 flex items-center justify-center rounded text-gray-600 hover:bg-gray-100 text-xs font-bold"
          title="Grow"
        >
          +
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
