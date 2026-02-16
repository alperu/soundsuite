/**
 * Error subclass for errors where the sidecar responded successfully
 * via WebSocket but reported a business-level failure (e.g., port conflict,
 * container not found). The WS transport itself worked fine — no HTTP
 * fallback should be attempted.
 */
export class SidecarError extends Error {
  readonly sidecarResponded = true;
  constructor(message: string) {
    super(message);
    this.name = 'SidecarError';
  }
}
