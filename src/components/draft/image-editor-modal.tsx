'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ImageEditorModalProps {
  imageSrc: string;
  onSave: (dataUrl: string) => void;
  onClose: () => void;
}

type Tab = 'crop' | 'annotate' | 'redact';
type AnnotateTool = 'rect' | 'arrow' | 'text' | 'freehand';

// ---------------------------------------------------------------------------
// Crop helpers
// ---------------------------------------------------------------------------

function getCroppedCanvas(image: HTMLImageElement, crop: PixelCrop): string {
  const canvas = document.createElement('canvas');
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  canvas.width = crop.width * scaleX;
  canvas.height = crop.height * scaleY;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(
    image,
    crop.x * scaleX, crop.y * scaleY,
    crop.width * scaleX, crop.height * scaleY,
    0, 0,
    canvas.width, canvas.height,
  );
  return canvas.toDataURL('image/png');
}

// ---------------------------------------------------------------------------
// Aspect presets
// ---------------------------------------------------------------------------

const ASPECTS = [
  { label: 'Free', value: undefined },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
  { label: '1:1', value: 1 },
] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ImageEditorModal({ imageSrc, onSave, onClose }: ImageEditorModalProps) {
  const [tab, setTab] = useState<Tab>('crop');
  const [workingImage, setWorkingImage] = useState(imageSrc);

  // -- Crop state --
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [aspect, setAspect] = useState<number | undefined>(undefined);
  const cropImgRef = useRef<HTMLImageElement>(null);

  // -- Annotate/Redact state (canvas-based) --
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [annotateTool, setAnnotateTool] = useState<AnnotateTool>('rect');
  const [annotateColor, setAnnotateColor] = useState('#facc15'); // yellow
  const [annotations, setAnnotations] = useState<Array<{ type: string; x: number; y: number; w: number; h: number; color: string }>>([]);
  const [redactions, setRedactions] = useState<Array<{ x: number; y: number; w: number; h: number }>>([]);
  const bgImageRef = useRef<HTMLImageElement | null>(null);

  // Load background image for canvas tabs
  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      bgImageRef.current = img;
      drawCanvas();
    };
    img.src = workingImage;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingImage, tab]);

  // -- Canvas drawing --
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const img = bgImageRef.current;
    if (!canvas || !img) return;

    // Size canvas to fit modal (max 620px wide)
    const maxW = 620;
    const scale = Math.min(1, maxW / img.naturalWidth);
    canvas.width = img.naturalWidth * scale;
    canvas.height = img.naturalHeight * scale;

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // Draw annotations
    for (const a of annotations) {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      ctx.globalAlpha = 1;
      ctx.strokeRect(a.x, a.y, a.w, a.h);
    }

    // Draw redactions
    for (const r of redactions) {
      ctx.fillStyle = '#000000';
      ctx.globalAlpha = 1;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }, [annotations, redactions]);

  useEffect(() => {
    if (tab === 'annotate' || tab === 'redact') drawCanvas();
  }, [tab, annotations, redactions, drawCanvas]);

  // -- Canvas mouse handlers --
  const getCanvasPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasPos(e);
    setIsDrawing(true);
    setDrawStart(pos);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;
    const pos = getCanvasPos(e);

    // Live preview
    drawCanvas();
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const w = pos.x - drawStart.x;
    const h = pos.y - drawStart.y;

    if (tab === 'redact') {
      ctx.fillStyle = '#000000';
      ctx.globalAlpha = 0.7;
      ctx.fillRect(drawStart.x, drawStart.y, w, h);
      ctx.globalAlpha = 1;
    } else {
      ctx.strokeStyle = annotateColor;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = annotateColor;
      ctx.fillRect(drawStart.x, drawStart.y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeRect(drawStart.x, drawStart.y, w, h);
    }
  };

  const handleCanvasMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || !drawStart) return;
    const pos = getCanvasPos(e);
    const w = pos.x - drawStart.x;
    const h = pos.y - drawStart.y;

    // Only add if dragged a meaningful area
    if (Math.abs(w) > 5 && Math.abs(h) > 5) {
      if (tab === 'redact') {
        setRedactions(prev => [...prev, { x: drawStart.x, y: drawStart.y, w, h }]);
      } else {
        setAnnotations(prev => [...prev, { type: annotateTool, x: drawStart.x, y: drawStart.y, w, h, color: annotateColor }]);
      }
    }

    setIsDrawing(false);
    setDrawStart(null);
  };

  // -- Actions --
  const handleApplyCrop = () => {
    if (!completedCrop || !cropImgRef.current) return;
    const cropped = getCroppedCanvas(cropImgRef.current, completedCrop);
    setWorkingImage(cropped);
    setCrop(undefined);
    setCompletedCrop(undefined);
    // Reset annotations/redactions since image changed
    setAnnotations([]);
    setRedactions([]);
  };

  const handleUndo = () => {
    if (tab === 'redact') {
      setRedactions(prev => prev.slice(0, -1));
    } else {
      setAnnotations(prev => prev.slice(0, -1));
    }
  };

  const handleClearAll = () => {
    if (tab === 'redact') setRedactions([]);
    else setAnnotations([]);
  };

  const handleSave = () => {
    // If on annotate/redact tab, flatten canvas to image
    if ((tab === 'annotate' || tab === 'redact') && canvasRef.current) {
      drawCanvas(); // ensure latest state
      const dataUrl = canvasRef.current.toDataURL('image/png');
      onSave(dataUrl);
    } else {
      onSave(workingImage);
    }
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 w-[700px] max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 shrink-0">
          <h2 className="text-sm font-semibold text-gray-800">Edit Image</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 shrink-0">
          {(['crop', 'annotate', 'redact'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                tab === t
                  ? 'text-blue-700 border-b-2 border-blue-600 bg-blue-50/50'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'crop' ? 'Crop & Resize' : t === 'annotate' ? 'Annotate' : 'Redact'}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {/* ---- Crop Tab ---- */}
          {tab === 'crop' && (
            <div className="p-4">
              {/* Aspect presets */}
              <div className="flex gap-2 mb-3">
                {ASPECTS.map(a => (
                  <button
                    key={a.label}
                    onClick={() => setAspect(a.value)}
                    className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                      aspect === a.value
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-blue-400'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>

              {/* Crop area */}
              <div className="flex justify-center bg-gray-100 rounded-lg p-2">
                <ReactCrop
                  crop={crop}
                  onChange={c => setCrop(c)}
                  onComplete={c => setCompletedCrop(c)}
                  aspect={aspect}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={cropImgRef}
                    src={workingImage}
                    alt="Crop preview"
                    style={{ maxHeight: 400, maxWidth: '100%' }}
                  />
                </ReactCrop>
              </div>

              {completedCrop && completedCrop.width > 0 && (
                <div className="flex justify-center mt-3">
                  <button
                    onClick={handleApplyCrop}
                    className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                  >
                    Apply Crop
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ---- Annotate Tab ---- */}
          {tab === 'annotate' && (
            <div className="p-4">
              {/* Tool bar */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-gray-500">Tool:</span>
                <button
                  onClick={() => setAnnotateTool('rect')}
                  className={`px-2.5 py-1 text-xs rounded border ${annotateTool === 'rect' ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 hover:border-blue-400'}`}
                >
                  Rectangle
                </button>
                <span className="text-xs text-gray-500 ml-2">Color:</span>
                {['#facc15', '#f87171', '#34d399', '#60a5fa', '#c084fc'].map(c => (
                  <button
                    key={c}
                    onClick={() => setAnnotateColor(c)}
                    className={`w-6 h-6 rounded-full border-2 ${annotateColor === c ? 'border-gray-800 scale-110' : 'border-gray-300'}`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <div className="flex-1" />
                <button onClick={handleUndo} disabled={annotations.length === 0} className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-30">
                  Undo
                </button>
                <button onClick={handleClearAll} disabled={annotations.length === 0} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-30">
                  Clear All
                </button>
              </div>

              <div className="flex justify-center bg-gray-100 rounded-lg p-2">
                <canvas
                  ref={canvasRef}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={() => { setIsDrawing(false); setDrawStart(null); }}
                  className="cursor-crosshair rounded"
                  style={{ maxWidth: '100%' }}
                />
              </div>
            </div>
          )}

          {/* ---- Redact Tab ---- */}
          {tab === 'redact' && (
            <div className="p-4">
              {/* Warning */}
              <div className="flex items-center gap-2 px-3 py-2 mb-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                Redactions are permanent — black areas are burned into the image on save.
              </div>

              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-gray-500">Draw black rectangles to redact sensitive areas</span>
                <div className="flex-1" />
                <button onClick={handleUndo} disabled={redactions.length === 0} className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-30">
                  Undo
                </button>
                <button onClick={handleClearAll} disabled={redactions.length === 0} className="text-xs text-red-500 hover:text-red-700 disabled:opacity-30">
                  Clear All
                </button>
              </div>

              <div className="flex justify-center bg-gray-100 rounded-lg p-2">
                <canvas
                  ref={canvasRef}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={() => { setIsDrawing(false); setDrawStart(null); }}
                  className="cursor-crosshair rounded"
                  style={{ maxWidth: '100%' }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-200 shrink-0 bg-gray-50">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
