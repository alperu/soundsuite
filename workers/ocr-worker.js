/**
 * OCR Worker Process — runs in a forked child process via child_process.fork().
 *
 * Loads @gutenye/ocr-node (PaddleOCR v4 via ONNX) once on startup, then
 * listens for IPC messages containing file paths to OCR. Results are sent
 * back via IPC. The process stays alive between requests so the model
 * remains loaded in memory.
 *
 * This is a plain JS file (not TypeScript) so it can be forked directly
 * without a TS loader, both in development and production.
 */

'use strict';

let ocr = null;

async function init() {
  const mod = await import('@gutenye/ocr-node');
  const Ocr = mod.default;
  ocr = await Ocr.create();
  process.send({ type: 'ready' });
}

process.on('message', async (msg) => {
  if (msg.type !== 'ocr' || !ocr) return;

  try {
    // detect() returns Array<{ text: string, mean: number, box: number[][] }>
    const detections = await ocr.detect(msg.filePath);
    const fullText = detections.map((d) => d.text).join('\n');
    const avgConfidence =
      detections.length > 0
        ? detections.reduce((sum, d) => sum + d.mean, 0) / detections.length
        : 0;

    process.send({
      type: 'result',
      id: msg.id,
      text: fullText,
      confidence: avgConfidence * 100, // normalize to 0-100
    });
  } catch (err) {
    process.send({
      type: 'error',
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

init().catch((err) => {
  console.error('OCR worker init failed:', err);
  process.exit(1);
});
