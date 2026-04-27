/**
 * OllamaOCREngine — OCR via Ollama vision models (e.g. olmOCR-2).
 *
 * Sends page images as base64 to a remote Ollama server running a vision
 * model and extracts text. Designed for GPU-accelerated OCR on machines
 * with NVIDIA GPUs (e.g. A6000 48 GB).
 */

import { IOCREngine, OCRResult } from './ocr-engine';
import { createLogger } from '../logger';
import { OcrNotReadyError } from './errors';
import { NoGpuReadyEndpointError } from '@/lib/gpu/errors';

const logger = createLogger('OllamaOCR');

export interface OllamaOCRConfig {
  host: string;   // e.g. http://10.10.20.5:11434
  model: string;  // e.g. richardyoung/olmocr2:7b-q8
  useOrchestrator?: boolean; // resolve host per-request via fleet-router
}

const OCR_PROMPT = `OCR this document page. Output only the raw text. No commentary. Preserve paragraph breaks. For tables use | delimiters. Stop when all text is extracted.`;

const MAX_RETRIES = 3;
const TIMEOUT_MS = 120_000; // 2 min per attempt
const BASE_DELAY_MS = 3_000;

export class OllamaOCREngine implements IOCREngine {
  private host: string;
  private model: string;
  private useOrchestrator: boolean;
  private lastResolvedHost: string | null = null;

  constructor(config: OllamaOCRConfig) {
    this.host = config.host.replace(/\/+$/, '');
    this.model = config.model;
    this.useOrchestrator = config.useOrchestrator ?? false;
    logger.info('OllamaOCREngine initialized', { host: this.host, model: this.model, orchestrator: this.useOrchestrator });
  }

  /**
   * Resolve the OCR host — fleet-router per-request if orchestrator enabled,
   * otherwise static config. When orchestrator mode is on, a routing failure
   * (typically NoGpuReadyEndpointError) is propagated as OcrNotReadyError so
   * the worker pauses instead of degrading silently to the static host.
   */
  private async resolveHost(): Promise<string> {
    if (!this.useOrchestrator) return this.host;
    try {
      const { resolveEndpoint } = await import('@/lib/gpu/fleet-router');
      const ep = await resolveEndpoint('ocr');
      if (this.lastResolvedHost !== ep.host) {
        logger.info('OCR host resolved via fleet-router', { host: ep.host, sidecar: ep.sidecarUrl });
        this.lastResolvedHost = ep.host;
      }
      return ep.host;
    } catch (err) {
      if (err instanceof NoGpuReadyEndpointError) {
        logger.warn('OCR not GPU-ready — pausing', { reason: err.reason });
        throw new OcrNotReadyError(err.message, err);
      }
      // Other routing errors (no sidecar reachable at all) are also pause-worthy
      // when orchestrator mode is enabled — silently falling back to a static
      // host would just put OCR onto the local CPU, which is the bug we're fixing.
      logger.warn('Fleet router OCR resolve failed', { error: (err as Error).message });
      throw new OcrNotReadyError(`Fleet router resolve failed: ${(err as Error).message}`, err as Error);
    }
  }

  async recognizeImage(imageBuffer: Buffer): Promise<OCRResult> {
    const base64Image = imageBuffer.toString('base64');
    const imageSizeKB = Math.round(imageBuffer.length / 1024);
    let lastError: Error | undefined;
    const host = await this.resolveHost();

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const startTime = Date.now();

      logger.info('Sending image to Ollama for OCR', {
        host,
        model: this.model,
        imageSizeKB,
        attempt,
      });

      try {
        const response = await fetch(`${host}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({
            model: this.model,
            prompt: OCR_PROMPT,
            images: [base64Image],
            stream: false,
            options: {
              temperature: 0,
              num_predict: 2048,
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama returned ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        const text = (result.response || '').trim();
        const durationMs = Date.now() - startTime;

        logger.info('Ollama OCR completed', {
          model: this.model,
          textLength: text.length,
          durationMs,
          attempt,
          totalDuration: result.total_duration ? `${(result.total_duration / 1e9).toFixed(1)}s` : undefined,
        });

        return {
          text,
          confidence: text.length > 0 ? 1.0 : 0,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const durationMs = Date.now() - startTime;

        logger.warn(`Ollama OCR attempt ${attempt}/${MAX_RETRIES} failed`, {
          host,
          model: this.model,
          durationMs,
          errorMessage: lastError.message,
        });

        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 3s, 6s, 12s
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`OllamaOCR failed after ${MAX_RETRIES} attempts (${host}, model=${this.model}): ${lastError!.message}`);
  }

  async terminate(): Promise<void> {
    // No persistent resources to clean up
  }
}
