/**
 * OCR model capabilities — pure metadata, safe to import from both server
 * code (mode-catalog-server) and client components (admin-dashboard).
 *
 * Two capability axes matter for the OCR role:
 *
 *   promptStyle — general instruction-following VLMs (minicpm-v, olmOCR,
 *     llama3.2-vision) take a free-form instruction prompt. PaddleOCR-VL is
 *     a fixed-task recognizer: it accepts exactly one of "OCR:",
 *     "Table Recognition:", "Formula Recognition:", "Chart Recognition:",
 *     "Seal Recognition:", "Spotting:" — a free-form instruction is
 *     meaningless input to it.
 *
 *   macCompatible — ss-ocr is deployed as a Docker image (docker-ollama
 *     runtime). Docker on Mac has no GPU passthrough for plain containers,
 *     so models that require the Docker runtime cannot be served on
 *     mac-docker-ollama sidecars. getModeCatalog() strips
 *     'mac-docker-ollama' from ss-ocr's availableOn when the configured
 *     model is not macCompatible, which removes the Mac assignment chips
 *     on /admin/roleassign automatically.
 *
 * Detection is by pattern, not exact id, so community tags
 * (AuditAid/PaddleOCR-VL-1.6-0.9B), locally `ollama create`d names, and
 * future versions all resolve correctly.
 */

export interface OcrModelCaps {
  promptStyle: 'instruction' | 'fixed-task';
  /** Task prompt for fixed-task models. */
  fixedTaskPrompt?: string;
  /** false ⇒ ss-ocr is not assignable on mac-docker-ollama hosts. */
  macCompatible: boolean;
  /** Ollama num_predict. Fixed-task document parsers need headroom on dense
   * pages — output truncation is a documented PaddleOCR-VL failure mode. */
  numPredict: number;
  /** Minimum Ollama server version able to load this model. PaddleOCR-VL
   * needs the llama.cpp backend from Ollama 0.30 (llama.cpp #18825) plus
   * the 0.30.4 multimodal fix — floor 0.31.2 per
   * docs/TODO-paddleocr-vl-and-readiness-score.md §A.5. Undefined ⇒ any. */
  minOllamaVersion?: string;
}

const DEFAULT_CAPS: OcrModelCaps = {
  promptStyle: 'instruction',
  macCompatible: true,
  numPredict: 2048,
};

export function ocrModelCaps(model: string | undefined | null): OcrModelCaps {
  if (model && /paddleocr/i.test(model)) {
    return {
      promptStyle: 'fixed-task',
      fixedTaskPrompt: 'OCR:',
      macCompatible: false,
      numPredict: 8192,
      minOllamaVersion: '0.31.2',
    };
  }
  return DEFAULT_CAPS;
}
