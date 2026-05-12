/**
 * Boot-event ring buffer for the sidecar.
 *
 * Surfaces the otherwise-silent boot flow (IP acquisition, OS detection,
 * master discovery, registry resolution, master connection) on the Activity
 * Log of the sidecar's local dashboard and any master that consumes
 * `bootLog` from `/api/status`.
 *
 * Constraints:
 *  - Events fire ONCE per boot, not on every heartbeat (use `bootSeq` as a
 *    monotonic ordering key; consumers can dedupe by `seq`).
 *  - Mirror to `logger.info()` so every event also lands in sidecar logs.
 *  - In-memory only — ring buffer caps at 100 entries; older boots are
 *    overwritten on container restart (which is fine: the master polls
 *    /api/status every few seconds and captures the fresh trace immediately).
 */
import { createLogger } from './logger';

const log = createLogger('boot');

export interface BootEvent {
  /** Monotonic sequence number (1-based) for ordering across polls. */
  seq: number;
  /** Epoch ms — master uses this to render the timestamp on its Activity Log. */
  ts: number;
  /** Human-readable message (single line, no newlines). */
  message: string;
  /** Optional structured payload — kept small. */
  meta?: Record<string, unknown>;
}

const RING_CAP = 100;
const buffer: BootEvent[] = [];
let nextSeq = 1;

/**
 * Stable per-process boot epoch (ms). Frozen at module init; survives the life
 * of the Node process. Consumers (UI / master) reset their seq high-water-mark
 * when this changes to re-render the fresh boot trace after a restart.
 */
const bootEpoch = Date.now();
export function getBootEpoch(): number { return bootEpoch; }

/** Emit a boot event: append to the ring buffer + log via standard logger. */
export function emitBootEvent(message: string, meta?: Record<string, unknown>): void {
  const ev: BootEvent = {
    seq: nextSeq++,
    ts: Date.now(),
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  buffer.push(ev);
  if (buffer.length > RING_CAP) buffer.splice(0, buffer.length - RING_CAP);
  // Mirror to logger so it also reaches stdout / sidecar logs.
  if (meta && Object.keys(meta).length > 0) log.info(message, meta);
  else log.info(message);
}

/** Return all boot events currently buffered (newest last). */
export function getBootEvents(): BootEvent[] {
  return buffer.slice();
}

/** Latest emitted seq (0 when no events yet). Lets pollers detect "no new events". */
export function getLatestBootSeq(): number {
  return nextSeq - 1;
}
