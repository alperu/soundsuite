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

/** Per-host load detail carried on a saturation refusal, for the caller's log. */
export interface SaturatedHost {
  hostname: string;
  /** activeRequests the router used to decide, AFTER the stale-acquire discount. */
  load: number;
  /** The cap this host was measured against. */
  cap: number;
}

/**
 * Thrown by fleet-router.resolveEndpoint when admission control is ENABLED
 * (opt-in — see readAdmissionCaps in fleet-router.ts) and every candidate host
 * for the role is at or over its configured cap.
 *
 * Task 40 item 5: a refusal must be legible. A bare 503 recreates the
 * `notReady` defect — a signal that says nothing actionable. This error names
 * the saturated ROLE, the per-host loads that produced the decision, and the
 * cap they were measured against, so the caller can retry, downgrade, or tell
 * the operator which role needs more capacity.
 *
 * `retryAfterMs` is ADVISORY, not a promise. Nothing in the fleet predicts when
 * an in-flight request will finish; the value is a polling hint sized to the
 * sidecar heartbeat cadence, which bounds how fast the router's view of load
 * can change at all.
 */
export class FleetSaturatedError extends Error {
  readonly role: string;
  readonly hosts: SaturatedHost[];
  readonly cap: number;
  readonly retryAfterMs: number;

  constructor(role: string, hosts: SaturatedHost[], cap: number, retryAfterMs: number) {
    const detail = hosts.map(h => `${h.hostname}=${h.load}/${h.cap}`).join(', ');
    super(
      `Fleet saturated for role "${role}": all ${hosts.length} candidate host(s) at or over cap ` +
      `(${detail}). Advisory retry after ~${Math.round(retryAfterMs / 1000)}s.`,
    );
    this.name = 'FleetSaturatedError';
    this.role = role;
    this.hosts = hosts;
    this.cap = cap;
    this.retryAfterMs = retryAfterMs;
  }
}
