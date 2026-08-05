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
import { ocrModelCaps, type OcrModelCaps } from '@/lib/gpu/ocr-model-caps';
import { assessOcrOutput } from './ocr-quality-gate';

const logger = createLogger('OllamaOCR');

export interface OllamaOCRConfig {
  host: string;   // e.g. http://10.10.20.5:11434
  model: string;  // e.g. richardyoung/olmocr2:7b-q8
  useOrchestrator?: boolean; // resolve host per-request via fleet-router
  /**
   * Per-attempt request timeout in ms. Default 90 000 — measured latencies
   * (docs/TODO-ocr-speedups.md): median 30–40 s, cold model loads 30–60 s.
   * Do not lower below cold-load range unless a host-health watchdog
   * guarantees the model is resident.
   */
  timeoutMs?: number;
}

/**
 * Instruction prompt for general vision models (minicpm-v, olmOCR,
 * llama3.2-vision). Fixed-task recognizers (PaddleOCR-VL) instead get their
 * task prompt (e.g. "OCR:") from ocrModelCaps — a free-form instruction is
 * meaningless input to them.
 */
const OCR_PROMPT = `OCR this document page. Output only the raw text. No commentary. Preserve paragraph breaks. For tables use | delimiters. Stop when all text is extracted.`;

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 90_000;
const BASE_DELAY_MS = 3_000;
const MAX_JITTER_MS = 1_000; // random jitter added to each retry delay

export class OllamaOCREngine implements IOCREngine {
  private host: string;
  private model: string;
  private caps: OcrModelCaps;
  private useOrchestrator: boolean;
  private timeoutMs: number;
  private lastResolvedHost: string | null = null;
  private lastPreflight: { host: string; ok: boolean; at: number; error?: string } | null = null;
  private static PREFLIGHT_OK_TTL_MS = 5_000;
  private static PREFLIGHT_FAIL_TTL_MS = 2_000;
  private static PREFLIGHT_TIMEOUT_MS = 1_500;

  private async preflight(host: string): Promise<{ ok: boolean; error?: string }> {
    const now = Date.now();
    const cached = this.lastPreflight;
    if (cached && cached.host === host) {
      const ttl = cached.ok
        ? OllamaOCREngine.PREFLIGHT_OK_TTL_MS
        : OllamaOCREngine.PREFLIGHT_FAIL_TTL_MS;
      if (now - cached.at < ttl) return { ok: cached.ok, error: cached.error };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OllamaOCREngine.PREFLIGHT_TIMEOUT_MS);
    try {
      const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) {
        const result = { ok: false, error: `HTTP ${res.status}` };
        this.lastPreflight = { host, at: now, ...result };
        return result;
      }
      const data: any = await res.json().catch(() => ({ models: [] }));
      // Ollama's /api/tags returns names with an explicit tag suffix
      // (e.g. "minicpm-v:latest"). Configured model often omits the tag.
      // Treat bare "name" as equivalent to "name:latest" and accept any
      // tag of the requested model.
      const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
      const wantedBase = this.model.split(':')[0];
      const matches = (s: unknown): boolean => {
        if (typeof s !== 'string') return false;
        if (s === this.model || s === wanted) return true;
        // Accept any tag of the requested base name.
        return s.split(':')[0] === wantedBase;
      };
      const has = Array.isArray(data?.models)
        && data.models.some((m: any) => matches(m?.name) || matches(m?.model));
      if (!has) {
        const result = { ok: false, error: `model "${this.model}" not pulled on ${host}` };
        this.lastPreflight = { host, at: now, ...result };
        return result;
      }
      this.lastPreflight = { host, at: now, ok: true };
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).name === 'AbortError'
        ? `preflight timeout after ${OllamaOCREngine.PREFLIGHT_TIMEOUT_MS}ms`
        : (err as Error).message;
      this.lastPreflight = { host, at: now, ok: false, error: msg };
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  constructor(config: OllamaOCRConfig) {
    this.host = config.host.replace(/\/+$/, '');
    this.model = config.model;
    this.caps = ocrModelCaps(config.model);
    this.useOrchestrator = config.useOrchestrator ?? false;
    this.timeoutMs = (typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0)
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    logger.info('OllamaOCREngine initialized', { host: this.host, model: this.model, orchestrator: this.useOrchestrator, timeoutMs: this.timeoutMs });
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

    const pf = await this.preflight(host);
    if (!pf.ok) {
      logger.warn('Ollama OCR preflight failed — skipping request', {
        host,
        model: this.model,
        error: pf.error,
      });
      throw new OcrNotReadyError(`Ollama OCR unavailable (${host}, model=${this.model}): ${pf.error}. Ensure Ollama is running and the model is pulled.`);
    }

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
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify({
            model: this.model,
            prompt: this.caps.promptStyle === 'fixed-task'
              ? (this.caps.fixedTaskPrompt ?? 'OCR:')
              : OCR_PROMPT,
            images: [base64Image],
            stream: false,
            options: {
              temperature: 0,
              num_predict: this.caps.numPredict,
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

        // Quality gate: reject hallucinated garbage (repetition loops,
        // unexpected script, LaTeX recitation, letter soup) instead of
        // indexing it as page text. Empty text downstream = "no OCR text"
        // (page marked empty / ocrFailedCount), which is recoverable;
        // garbage in the vector index is silent search poisoning.
        const quality = assessOcrOutput(text);
        if (!quality.ok) {
          logger.warn('Ollama OCR output failed quality gate — discarding', {
            model: this.model,
            textLength: text.length,
            durationMs,
            reasons: quality.reasons,
            preview: text.slice(0, 120),
          });
          return { text: '', confidence: 0 };
        }

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

        // AbortSignal.timeout() aborts with a DOMException named 'TimeoutError'.
        // Distinguish "our client-side limit fired" from a host-side error (5xx,
        // connection refused) — they need opposite operator responses (raise
        // timeoutMs / check model residency vs. fix the Ollama host).
        const timedOut = lastError.name === 'TimeoutError' || lastError.name === 'AbortError';
        if (timedOut) {
          lastError = new Error(`client-side timeout after ${this.timeoutMs}ms (host may be cold-loading the model or overloaded)`);
        }

        logger.warn(`Ollama OCR attempt ${attempt}/${MAX_RETRIES} failed`, {
          host,
          model: this.model,
          durationMs,
          timedOut,
          timeoutMs: this.timeoutMs,
          errorMessage: lastError.message,
        });

        if (attempt < MAX_RETRIES) {
          // Delays fire after attempts 1 and 2 only (MAX_RETRIES=3): 3–4s, 6–7s
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * MAX_JITTER_MS;
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
