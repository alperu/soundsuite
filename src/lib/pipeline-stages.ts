/**
 * Shared pipeline stage constants for the ingestion pipeline.
 * Used by both the backend (ingestion-pipeline.ts) and frontend (pipeline-stage-indicator.tsx).
 */

/** Raw pipeline stage names in processing order */
export const PIPELINE_STAGES = [
  'preflight',
  'filing-detection',
  'text-extraction',
  'document-summarization',
  'image-scan',
  'exhibit-boundary-detection',
  'toc-extraction',
  'exhibit-extraction',
  'ocr-fallback',
  'annotation-extraction',
  'structure',
  'text-chunking',
  'embedding-generation',
  'vector-indexing',
  'verification',
  'complete',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Visual stage groups (6 stages shown in the UI) */
export const VISUAL_STAGES = [
  { label: 'Setup', stages: ['preflight', 'filing-detection'] },
  { label: 'Parse', stages: ['text-extraction', 'document-summarization'] },
  { label: 'Scan', stages: ['image-scan', 'exhibit-boundary-detection', 'toc-extraction'] },
  { label: 'Exhibits', stages: ['exhibit-extraction'] },
  { label: 'OCR', stages: ['ocr-fallback', 'annotation-extraction'] },
  { label: 'Embed', stages: ['structure', 'text-chunking', 'embedding-generation', 'vector-indexing', 'verification', 'complete'] },
] as const;

/**
 * Map a raw pipeline stage name to its visual stage index (0-based).
 * Returns -1 if the stage name is not recognized.
 */
export function getVisualStageIndex(stage: string): number {
  for (let i = 0; i < VISUAL_STAGES.length; i++) {
    if ((VISUAL_STAGES[i].stages as readonly string[]).includes(stage)) {
      return i;
    }
  }
  return -1;
}

/**
 * Get the raw stage index (0-based) within the full 10-stage pipeline.
 */
export function getRawStageIndex(stage: string): number {
  return PIPELINE_STAGES.indexOf(stage as PipelineStage);
}
