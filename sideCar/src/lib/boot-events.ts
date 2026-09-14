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
import { processGlobal } from './process-global';

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
const G = processGlobal('boot-events', () => ({
  buffer: [] as BootEvent[],
  nextSeq: 1,
  bootEpoch: Date.now(),
}));

/**
 * Stable per-process boot epoch (ms). Frozen at module init; survives the life
 * of the Node process. Consumers (UI / master) reset their seq high-water-mark
 * when this changes to re-render the fresh boot trace after a restart.
 */
export function getBootEpoch(): number { return G.bootEpoch; }

/** Emit a boot event: append to the ring buffer + log via standard logger. */
export function emitBootEvent(message: string, meta?: Record<string, unknown>): void {
  const ev: BootEvent = {
    seq: G.nextSeq++,
    ts: Date.now(),
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  G.buffer.push(ev);
  if (G.buffer.length > RING_CAP) G.buffer.splice(0, G.buffer.length - RING_CAP);
  // Mirror to logger so it also reaches stdout / sidecar logs.
  if (meta && Object.keys(meta).length > 0) log.info(message, meta);
  else log.info(message);
}

/** Return all boot events currently buffered (newest last). */
export function getBootEvents(): BootEvent[] {
  return G.buffer.slice();
}

/** Latest emitted seq (0 when no events yet). Lets pollers detect "no new events". */
export function getLatestBootSeq(): number {
  return G.nextSeq - 1;
}
