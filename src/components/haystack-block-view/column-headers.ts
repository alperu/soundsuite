import { COL_PITCH, FILING_W, KIND_COLUMNS, columnX } from './scope-graph';
import { subscribeTransform, type CanvasTransform } from './zoom-state';

/**
 * Column headers and guide lines, drawn as plain DOM over the canvas.
 *
 * Not rete nodes: those would need fake blocks in the editor's node model,
 * would scale away to nothing at fit zoom, and would scroll off the top the
 * moment the user panned down. A header has to stay readable and stay put,
 * which makes it chrome rather than content.
 *
 * Positioned imperatively from the transform subscription — no React render per
 * frame of a pan.
 */

/** Below this a header is narrower than its own word; drawing it is noise. */
const MIN_HEADER_WIDTH = 60;

export function mountColumnHeaders(layer: HTMLElement): () => void {
  const headers = KIND_COLUMNS.map(name => {
    const el = document.createElement('div');
    el.textContent = name;
    el.dataset.columnHeader = name;
    el.className =
      'absolute top-0 truncate rounded-b bg-white/85 px-2 py-1 text-[11px] font-semibold ' +
      'uppercase tracking-wide text-gray-500 shadow-sm backdrop-blur-sm';
    layer.appendChild(el);
    return el;
  });

  // One rule per boundary between columns, plus the left edge of the first.
  const guides = KIND_COLUMNS.map((_, index) => {
    const el = document.createElement('div');
    el.dataset.columnGuide = String(index);
    el.className = 'absolute top-0 bottom-0 w-px bg-gray-200/70';
    layer.appendChild(el);
    return el;
  });

  const apply = (t: CanvasTransform) => {
    const width = FILING_W * t.k;
    const visible = width >= MIN_HEADER_WIDTH;
    headers.forEach((el, index) => {
      const left = t.x + columnX(index) * t.k;
      el.style.display = visible ? 'block' : 'none';
      if (!visible) return;
      // Clamped so a column scrolled half off-screen still names itself.
      el.style.left = `${Math.max(0, left)}px`;
      el.style.width = `${Math.max(0, Math.min(width, width + Math.min(0, left)))}px`;
    });
    guides.forEach((el, index) => {
      const left = t.x + (columnX(index) - (COL_PITCH - FILING_W) / 2) * t.k;
      el.style.display = visible ? 'block' : 'none';
      el.style.left = `${left}px`;
    });
  };

  const unsubscribe = subscribeTransform(apply);
  return () => {
    unsubscribe();
    for (const el of [...headers, ...guides]) el.remove();
  };
}
