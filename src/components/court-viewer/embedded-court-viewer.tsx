'use client';

/**
 * EmbeddedCourtViewer
 *
 * A minimal copy of the case-explorer PDF + TOC two-column layout, suitable
 * for embedding inside another page (e.g. the filing-detail page). Wraps the
 * same pdfjs-dist rendering pipeline used by `/case-explorer`:
 *
 *   • client-side render to <canvas> + selectable text layer + annotation layer
 *   • server-side image fallback for JPEG2000 / blank pages
 *   • PDF outline (via getOutline) with heading-extraction fallback
 *   • click a TOC entry → jump the viewer to that page
 *
 * Intentionally dropped from the explorer for the embed (see filing-detail
 * report for rationale): nav back/forward history, ?pageNum= URL sync, zoom
 * toolbar, fit-mode toggle, Doc-Info tab, resizable panes.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import 'pdfjs-dist/web/pdf_viewer.css';

// Lazy-load pdfjs-dist only on the client (SSR has no DOMMatrix)
let pdfjsLib: typeof import('pdfjs-dist') | null = null;
if (typeof window !== 'undefined') {
  import('pdfjs-dist').then(mod => {
    pdfjsLib = mod;
    mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  });
}

interface OutlineItem { title: string; dest: unknown; items: OutlineItem[]; }
interface ExtractedHeading { text: string; page: number; }

export interface EmbeddedCourtViewerProps {
  documentId: string | null;
  /** CSS height for the embedded viewer (default: 60vh). */
  height?: string;
}

const MAX_CONCURRENT_RENDERS = 20;
const PRELOAD_PAGES = 5;

export default function EmbeddedCourtViewer({ documentId, height = '60vh' }: EmbeddedCourtViewerProps) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfOutline, setPdfOutline] = useState<OutlineItem[]>([]);
  const [extractedHeadings, setExtractedHeadings] = useState<ExtractedHeading[]>([]);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [placeholderDims, setPlaceholderDims] = useState<{ w: number; h: number }>({ w: 612, h: 792 });
  const [currentPage, setCurrentPage] = useState(1);

  // The embed defaults to 'width' fit-mode — 'page' would make pages tiny inside
  // a bounded 60vh container.
  const fitMode: 'width' | 'page' | null = 'width';
  const pdfScale = 1.0;
  const computedScaleRef = useRef(1.0);

  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const pageCanvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const pageWrapperRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const textLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const annotationLayerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const renderingRef = useRef<Set<number>>(new Set());
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const renderPageRangeRef = useRef<(centerPage: number) => void>(() => {});

  // ── Load PDF: doc, outline, heading fallback ──────────────────────
  const loadPdf = useCallback(async (docId: string) => {
    setPdfLoading(true); setPdfError(null); setPdfOutline([]); setExtractedHeadings([]); setPdfPageCount(0);
    renderingRef.current.clear(); renderedPagesRef.current.clear();
    pageCanvasRefs.current.clear(); pageWrapperRefs.current.clear();
    textLayerRefs.current.clear(); annotationLayerRefs.current.clear();
    try {
      if (!pdfjsLib) { const mod = await import('pdfjs-dist'); pdfjsLib = mod; mod.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'; }
      const doc = await pdfjsLib.getDocument({
        url: `/api/documents/${docId}/pdf`,
        wasmUrl: '/',
      }).promise;
      setPdfDoc(doc); setPdfPageCount(doc.numPages);

      try {
        const p1 = await doc.getPage(1);
        const vp = p1.getViewport({ scale: 1.0 });
        setPlaceholderDims({ w: Math.floor(vp.width), h: Math.floor(vp.height) });
      } catch {}

      try {
        const outline = await doc.getOutline();
        if (outline?.length) { setPdfOutline(outline as OutlineItem[]); return; }
      } catch {}

      // Heading fallback when no embedded outline
      const headings: ExtractedHeading[] = [];
      for (let i = 1; i <= Math.min(doc.numPages, 100); i++) {
        try {
          const page = await doc.getPage(i);
          const content = await page.getTextContent();
          const items = content.items as Array<{ str?: string; height?: number; transform?: number[] }>;
          if (!items.length) continue;
          const fontSizes: Record<number, number> = {};
          for (const it of items) {
            if (it.str?.trim()) {
              const h = Math.round(it.height || it.transform?.[0] || 12);
              fontSizes[h] = (fontSizes[h] || 0) + it.str.length;
            }
          }
          const bodySizeNum = Number(Object.entries(fontSizes).sort((a, b) => b[1] - a[1])[0]?.[0] || 12);
          const pageLines: { text: string; fontSize: number }[] = [];
          let curLine = '', curSize = 0, curY = -1;
          for (const it of items) {
            if (!it.str) continue;
            const y = Math.round(it.transform?.[5] || 0);
            const h = Math.round(it.height || it.transform?.[0] || 12);
            if (curY === -1 || Math.abs(y - curY) < 3) { curLine += it.str; curSize = Math.max(curSize, h); curY = y; }
            else { if (curLine.trim()) pageLines.push({ text: curLine.trim(), fontSize: curSize }); curLine = it.str; curSize = h; curY = y; }
          }
          if (curLine.trim()) pageLines.push({ text: curLine.trim(), fontSize: curSize });
          for (const ln of pageLines) {
            const t = ln.text.trim();
            if (t.length < 3 || t.length > 120) continue;
            if (/^(?:page\s+\d+|\d+$|\d{1,2}\/\d{1,2}\/\d{2,4})$/i.test(t)) continue;
            if (ln.fontSize > bodySizeNum + 1 ||
                (t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && t.length > 4 && t.length < 80) ||
                /^(?:\d+\.|\([a-z]\)|\([0-9]+\)|[IVXLC]+\.|[A-Z]\.)\s+\S/.test(t)) {
              if (headings.length && headings[headings.length - 1].text === t && headings[headings.length - 1].page === i) continue;
              headings.push({ text: t, page: i });
            }
          }
        } catch {}
      }
      setExtractedHeadings(headings);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : 'Failed to load PDF');
      setPdfDoc(null);
    } finally { setPdfLoading(false); }
  }, []);

  useEffect(() => {
    if (documentId) {
      loadPdf(documentId);
    } else {
      setPdfDoc(null); setPdfOutline([]); setExtractedHeadings([]); setPdfPageCount(0);
      renderingRef.current.clear(); renderedPagesRef.current.clear();
      pageWrapperRefs.current.clear(); textLayerRefs.current.clear();
      annotationLayerRefs.current.clear();
    }
  }, [documentId, loadPdf]);

  // ── Render a single page to canvas (+ text/annotation layers + JPEG2000 fallback) ──
  const renderPageToCanvas = useCallback(async (pageNum: number, canvas: HTMLCanvasElement) => {
    if (!pdfDoc || !pdfjsLib || renderingRef.current.has(pageNum)) return;
    if (renderingRef.current.size >= MAX_CONCURRENT_RENDERS) return;
    renderingRef.current.add(pageNum);
    try {
      const page = await pdfDoc.getPage(pageNum);
      let scale = pdfScale;
      if (fitMode && pdfContainerRef.current) {
        const baseViewport = page.getViewport({ scale: 1.0 });
        const containerW = pdfContainerRef.current.clientWidth - 32;
        if (fitMode === 'width') {
          scale = containerW / baseViewport.width;
        } else {
          const containerH = pdfContainerRef.current.clientHeight - 32;
          scale = Math.min(containerW / baseViewport.width, containerH / baseViewport.height);
        }
        computedScaleRef.current = scale;
      }
      const viewport = page.getViewport({ scale });
      const w = Math.floor(viewport.width);
      const h = Math.floor(viewport.height);

      const wrapper = pageWrapperRefs.current.get(pageNum);
      if (wrapper) {
        wrapper.style.width = `${w}px`; wrapper.style.height = `${h}px`;
        const placeholder = wrapper.querySelector('.page-placeholder') as HTMLElement | null;
        if (placeholder) placeholder.style.display = 'none';
      }

      let clientRenderFailed = false;
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('No 2d context');
        canvas.width = w; canvas.height = h;
        canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
        ctx.clearRect(0, 0, w, h); ctx.resetTransform();
        await page.render({ canvasContext: ctx, viewport } as Parameters<typeof page.render>[0]).promise;

        // Detect JPEG2000/blank-page failure by sampling the center
        const sampleW = Math.min(w, 200);
        const sampleH = Math.min(h, 200);
        const sx = Math.max(0, Math.floor((w - sampleW) / 2));
        const sy = Math.max(0, Math.floor((h - sampleH) / 2));
        const sample = ctx.getImageData(sx, sy, sampleW, sampleH);
        let allWhite = true;
        for (let i = 0; i < sample.data.length; i += 4) {
          if (sample.data[i] < 250 || sample.data[i + 1] < 250 || sample.data[i + 2] < 250) {
            allWhite = false; break;
          }
        }
        const textContent = await page.getTextContent();
        const hasText = textContent.items.some((item) => {
          const it = item as { str?: string };
          return it.str?.trim();
        });
        if (allWhite && !hasText) {
          clientRenderFailed = true;
        } else {
          canvas.style.display = '';
          const textLayerDiv = textLayerRefs.current.get(pageNum);
          if (textLayerDiv) {
            textLayerDiv.innerHTML = '';
            textLayerDiv.style.setProperty('--total-scale-factor', String(scale));
            textLayerDiv.style.setProperty('--scale-round-x', '1px');
            textLayerDiv.style.setProperty('--scale-round-y', '1px');
            textLayerDiv.style.display = '';
            const textLayer = new pdfjsLib.TextLayer({
              textContentSource: textContent,
              container: textLayerDiv,
              viewport,
            });
            await textLayer.render();
          }

          const annotLayerDiv = annotationLayerRefs.current.get(pageNum);
          if (annotLayerDiv && pdfDoc) {
            annotLayerDiv.innerHTML = '';
            annotLayerDiv.style.setProperty('--total-scale-factor', String(scale));
            annotLayerDiv.style.setProperty('--scale-round-x', '1px');
            annotLayerDiv.style.setProperty('--scale-round-y', '1px');
            const annotations = await page.getAnnotations();
            if (annotations.length > 0) {
              const linkService = {
                get pagesCount() { return pdfDoc!.numPages; },
                get page() { return pageNum; },
                set page(_v: number) {},
                get rotation() { return 0; },
                set rotation(_v: number) {},
                get isInPresentationMode() { return false; },
                get externalLinkEnabled() { return true; },
                set externalLinkEnabled(_v: boolean) {},
                async goToDestination(dest: unknown) {
                  try {
                    let explicitDest = dest as unknown;
                    if (typeof dest === 'string') {
                      explicitDest = await pdfDoc!.getDestination(dest);
                    }
                    if (!explicitDest || !Array.isArray(explicitDest)) return;
                    const ref = (explicitDest as unknown[])[0];
                    const pageIndex = await pdfDoc!.getPageIndex(ref as Parameters<typeof pdfDoc.getPageIndex>[0]);
                    const targetPage = pageIndex + 1;
                    setCurrentPage(targetPage);
                    const w2 = pageWrapperRefs.current.get(targetPage);
                    if (w2) w2.scrollIntoView({ block: 'start' });
                    renderPageRangeRef.current(targetPage);
                  } catch {}
                },
                goToPage(val: number) {
                  setCurrentPage(val);
                  const w2 = pageWrapperRefs.current.get(val);
                  if (w2) w2.scrollIntoView({ block: 'start' });
                  renderPageRangeRef.current(val);
                },
                goToXY() {},
                addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean) {
                  link.href = url;
                  link.rel = 'noopener noreferrer nofollow';
                  if (newWindow || !url.startsWith('#')) link.target = '_blank';
                },
                getDestinationHash(dest: unknown) { return typeof dest === 'string' ? `#${dest}` : '#'; },
                getAnchorUrl(hash: string) { return hash; },
                setHash() {},
                executeNamedAction() {},
                executeSetOCGState() {},
              };
              const annotLayer = new pdfjsLib.AnnotationLayer({
                div: annotLayerDiv,
                page,
                viewport,
                accessibilityManager: null,
                annotationCanvasMap: null,
                annotationEditorUIManager: null,
                structTreeLayer: null,
                commentManager: null,
                linkService,
                annotationStorage: null,
              } as ConstructorParameters<typeof pdfjsLib.AnnotationLayer>[0]);
              await annotLayer.render({
                annotations, div: annotLayerDiv, page, viewport, linkService, renderForms: false,
              } as Parameters<typeof annotLayer.render>[0]);
              annotLayerDiv.style.display = '';
            }
          }
        }
      } catch {
        clientRenderFailed = true;
      }

      // Server-side image fallback for JPEG2000 / failed pages
      if (clientRenderFailed && documentId) {
        canvas.style.display = 'none';
        const textLayerDiv = textLayerRefs.current.get(pageNum);
        if (textLayerDiv) textLayerDiv.style.display = 'none';
        const annotDiv = annotationLayerRefs.current.get(pageNum);
        if (annotDiv) annotDiv.style.display = 'none';
        if (wrapper && !wrapper.querySelector('img.server-fallback')) {
          const img = document.createElement('img');
          img.className = 'server-fallback';
          img.style.width = `${w}px`;
          img.style.height = `${h}px`;
          img.style.display = 'block';
          img.alt = `Page ${pageNum}`;
          img.src = `/api/documents/${documentId}/page-image/${pageNum}?scale=${scale}`;
          img.onerror = () => {
            img.style.background = '#f3f4f6';
            img.alt = `Page ${pageNum} - render unavailable`;
          };
          wrapper.appendChild(img);
        }
      }
    } catch (err) {
      console.error(`[EmbeddedCourtViewer] renderPage ${pageNum} failed:`, err);
    } finally {
      renderingRef.current.delete(pageNum);
    }
  }, [pdfDoc, documentId]);

  // ── Cleanup a rendered page (free memory) ───────────────────────────
  const cleanupPage = useCallback((pageNum: number) => {
    if (!renderedPagesRef.current.has(pageNum)) return;
    renderedPagesRef.current.delete(pageNum);
    const canvas = pageCanvasRefs.current.get(pageNum);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = 0; canvas.height = 0;
      canvas.style.display = 'none';
    }
    const textLayerDiv = textLayerRefs.current.get(pageNum);
    if (textLayerDiv) { textLayerDiv.innerHTML = ''; textLayerDiv.style.display = 'none'; }
    const annotLayerDiv = annotationLayerRefs.current.get(pageNum);
    if (annotLayerDiv) { annotLayerDiv.innerHTML = ''; annotLayerDiv.style.display = 'none'; }
    const wrapper = pageWrapperRefs.current.get(pageNum);
    if (wrapper) {
      const oldImg = wrapper.querySelector('img.server-fallback');
      if (oldImg) oldImg.remove();
      const placeholder = wrapper.querySelector('.page-placeholder') as HTMLElement | null;
      if (placeholder) placeholder.style.display = '';
    }
  }, []);

  // ── Render the center page + neighbors, cleanup far-away pages ────
  const renderPageRange = useCallback((centerPage: number) => {
    if (!pdfPageCount) return;
    const start = Math.max(1, centerPage - PRELOAD_PAGES);
    const end = Math.min(pdfPageCount, centerPage + PRELOAD_PAGES);
    const renderOrder: number[] = [centerPage];
    for (let d = 1; d <= PRELOAD_PAGES; d++) {
      if (centerPage - d >= start) renderOrder.push(centerPage - d);
      if (centerPage + d <= end) renderOrder.push(centerPage + d);
    }
    for (const p of renderOrder) {
      if (!renderedPagesRef.current.has(p)) {
        const canvas = pageCanvasRefs.current.get(p);
        if (canvas) {
          canvas.style.display = '';
          renderedPagesRef.current.add(p);
          renderPageToCanvas(p, canvas);
        }
      }
    }
    const cleanStart = Math.max(1, centerPage - PRELOAD_PAGES * 2);
    const cleanEnd = Math.min(pdfPageCount, centerPage + PRELOAD_PAGES * 2);
    for (const pageNum of [...renderedPagesRef.current]) {
      if (pageNum < cleanStart || pageNum > cleanEnd) {
        cleanupPage(pageNum);
      }
    }
  }, [pdfPageCount, renderPageToCanvas, cleanupPage]);
  renderPageRangeRef.current = renderPageRange;

  // Which page is currently visible (scroll-ratio approximation)
  const getPageAtScroll = useCallback((container: HTMLDivElement): number => {
    if (!pdfPageCount) return 1;
    const scrollH = container.scrollHeight - container.clientHeight;
    if (scrollH <= 0) return 1;
    const ratio = container.scrollTop / scrollH;
    return Math.max(1, Math.min(pdfPageCount, Math.round(ratio * (pdfPageCount - 1)) + 1));
  }, [pdfPageCount]);

  // Scroll-driven rendering loop
  const scrollRafRef = useRef(0);
  useEffect(() => {
    if (!pdfDoc || !pdfPageCount || !pdfContainerRef.current) return;
    for (const pageNum of [...renderedPagesRef.current]) cleanupPage(pageNum);
    renderingRef.current.clear();

    const container = pdfContainerRef.current;
    const doRender = () => {
      const page = getPageAtScroll(container);
      setCurrentPage(page);
      renderPageRange(page);
    };
    const handleScroll = () => {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = requestAnimationFrame(doRender);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    const t = setTimeout(doRender, 50);
    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(scrollRafRef.current);
      clearTimeout(t);
    };
  }, [pdfDoc, pdfPageCount, pdfLoading, getPageAtScroll, renderPageRange, cleanupPage]);

  const setCanvasRef = useCallback((pageNum: number) => (el: HTMLCanvasElement | null) => { if (el) pageCanvasRefs.current.set(pageNum, el); }, []);
  const setWrapperRef = useCallback((pageNum: number) => (el: HTMLDivElement | null) => { if (el) pageWrapperRefs.current.set(pageNum, el); }, []);
  const setTextLayerRef = useCallback((pageNum: number) => (el: HTMLDivElement | null) => { if (el) textLayerRefs.current.set(pageNum, el); }, []);
  const setAnnotationLayerRef = useCallback((pageNum: number) => (el: HTMLDivElement | null) => { if (el) annotationLayerRefs.current.set(pageNum, el); }, []);

  // ── Navigation (TOC click → jump) ───────────────────────────────────
  const navigateToPage = useCallback((pageNum: number) => {
    setCurrentPage(pageNum);
    const wrapper = pageWrapperRefs.current.get(pageNum);
    if (wrapper) wrapper.scrollIntoView({ block: 'start' });
    renderPageRange(pageNum);
  }, [renderPageRange]);

  const goToPage = useCallback(async (dest: unknown) => {
    if (!pdfDoc) return;
    try {
      let idx: number;
      if (typeof dest === 'string') {
        const ref = await pdfDoc.getDestination(dest);
        if (!ref) return;
        idx = await pdfDoc.getPageIndex(ref[0] as Parameters<typeof pdfDoc.getPageIndex>[0]);
      } else if (Array.isArray(dest)) {
        idx = await pdfDoc.getPageIndex(dest[0] as Parameters<typeof pdfDoc.getPageIndex>[0]);
      } else return;
      navigateToPage(idx + 1);
    } catch {}
  }, [pdfDoc, navigateToPage]);

  const renderOutline = (items: OutlineItem[], depth = 0): React.ReactNode => (
    <ul className={depth > 0 ? 'ml-3 border-l border-gray-200' : ''}>
      {items.map((item, i) => (
        <li key={`${depth}-${i}`}>
          <button
            onClick={() => goToPage(item.dest)}
            className="w-full text-left px-2 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded truncate block"
            title={item.title}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >{item.title}</button>
          {item.items?.length > 0 && renderOutline(item.items, depth + 1)}
        </li>
      ))}
    </ul>
  );

  // ── Render ──────────────────────────────────────────────────────────
  if (!documentId) {
    return (
      <div
        className="flex items-center justify-center border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-400"
        style={{ height }}
      >
        No PDF attached
      </div>
    );
  }

  return (
    <div
      className="flex border border-gray-200 rounded-lg overflow-hidden bg-white"
      style={{ height }}
    >
      {/* PDF Viewer column */}
      <div className="flex-1 flex flex-col min-w-0 bg-gray-100">
        {pdfLoading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
          </div>
        ) : pdfError ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center px-4">
              <p className="text-sm text-red-500">{pdfError}</p>
              <button onClick={() => loadPdf(documentId)} className="mt-2 text-xs text-blue-500 hover:underline">Retry</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-1 border-b border-gray-200 bg-white flex-shrink-0 text-xs text-gray-500">
              <span className="font-medium">Page {currentPage}</span>
              <span className="text-gray-400">/ {pdfPageCount}</span>
            </div>
            <div ref={pdfContainerRef} className="flex-1 overflow-auto p-4 space-y-2">
              {Array.from({ length: pdfPageCount }, (_, i) => i + 1).map(pageNum => {
                const effScale = fitMode ? computedScaleRef.current || 1 : pdfScale;
                const phW = Math.floor(placeholderDims.w * effScale);
                const phH = Math.floor(placeholderDims.h * effScale);
                return (
                  <div key={pageNum} className="flex flex-col items-center">
                    <div
                      ref={setWrapperRef(pageNum)}
                      data-page={pageNum}
                      className="relative shadow-md bg-white"
                      style={{ width: phW, minHeight: phH }}
                    >
                      <div className="page-placeholder absolute inset-0 flex items-center justify-center">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-400" />
                      </div>
                      <canvas ref={setCanvasRef(pageNum)} style={{ display: 'none' }} />
                      <div ref={setTextLayerRef(pageNum)} className="textLayer" style={{ display: 'none' }} />
                      <div ref={setAnnotationLayerRef(pageNum)} className="annotationLayer" style={{ display: 'none' }} />
                    </div>
                    <span className="text-[10px] text-gray-400 mt-1">Page {pageNum}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* TOC column (inside the embed — not the global right rail) */}
      <div className="flex flex-col flex-shrink-0 bg-white border-l border-gray-200" style={{ width: 280 }}>
        <div className="px-3 py-2 border-b border-gray-200 text-xs font-medium text-gray-600">TOC</div>
        <div className="flex-1 overflow-y-auto">
          {pdfLoading ? (
            <p className="text-xs text-gray-400 text-center py-8">Loading…</p>
          ) : pdfOutline.length > 0 ? (
            <div className="py-1">{renderOutline(pdfOutline)}</div>
          ) : extractedHeadings.length > 0 ? (
            <ul className="py-1">
              {extractedHeadings.map((h, i) => (
                <li key={i}>
                  <button
                    onClick={() => navigateToPage(h.page)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 truncate"
                    title={`${h.text} (p.${h.page})`}
                  >
                    <span className="text-gray-400 mr-1">{h.page}</span> {h.text}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-gray-400 text-center py-8">No headings found</p>
          )}
        </div>
      </div>
    </div>
  );
}
