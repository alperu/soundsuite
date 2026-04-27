/**
 * Soft "OCR can't run right now" signal. The parsing worker should
 * leave the document QUEUED (no attempts++), back off, and retry.
 * Distinct from hard OCR failures (corrupt image, model crash, etc.).
 */
export class OcrNotReadyError extends Error {
  readonly role = 'ocr' as const;
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'OcrNotReadyError';
    this.cause = cause;
  }
}

export function isOcrNotReady(err: unknown): err is OcrNotReadyError {
  return err instanceof Error && err.name === 'OcrNotReadyError';
}
