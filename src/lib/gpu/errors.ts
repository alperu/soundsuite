/**
 * Routing error thrown by fleet-router.resolveEndpoint when a gpuOnly role
 * has no fully GPU-loaded sidecar available. Distinct from generic "no sidecar
 * reachable" errors so callers (worker, OCR engine) can pause-and-retry rather
 * than fail the document.
 */
export class NoGpuReadyEndpointError extends Error {
  readonly role: string;
  readonly reason: string;

  constructor(role: string, reason: string) {
    super(`No GPU-ready sidecar available for role "${role}": ${reason}`);
    this.name = 'NoGpuReadyEndpointError';
    this.role = role;
    this.reason = reason;
  }
}
