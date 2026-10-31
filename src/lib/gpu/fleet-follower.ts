/**
 * Fleet follower loop (fleet.source = follow, task 57 / 3.6).
 *
 * Keeps Sound Suite's copy of the sidecarmaster fleet fresh while follow mode is on:
 *   - polls GET {master}/api/v1/apps/soundsuite/fleet every 30 s (fleet-source.ts caches and
 *     writes the system.db snapshot);
 *   - holds one SSE connection to GET {master}/api/v1/events?app=soundsuite and refreshes the
 *     copy on role.* / control.* / app.* events, so an edit in sidecarmaster shows here within
 *     seconds, not at the next poll.
 *
 * Started from worker-init in every mode. When follow mode is off the tick does nothing and
 * the SSE connection is closed. Switching follow on in the admin UI is picked up at the next
 * tick (10 s), no restart needed.
 */
import { createLogger } from '@/lib/logger';
import {
  APP_ID, getFleetSourceSettings, invalidateFollowedFleet, markSse, refreshFollowedFleet, FLEET_TTL_MS,
} from '@/lib/db/fleet-source';

const logger = createLogger('FleetFollower');

const TICK_MS = 10_000;
const SSE_RETRY_MIN_MS = 5_000;
const SSE_RETRY_MAX_MS = 60_000;
/** Event types that change the desired fleet. Anything else only moves the live view. */
const REFRESH_ON = /^(role\.|control\.|app\.|mode\.|reconcile\.)/;

interface FollowerState {
  timer: ReturnType<typeof setInterval> | null;
  sse: { abort: AbortController; masterUrl: string } | null;
  sseRetryMs: number;
  sseRetryAt: number;
  ticking: boolean;
}

function st(): FollowerState {
  const g = globalThis as unknown as { __ssFleetFollower?: FollowerState };
  if (!g.__ssFleetFollower) g.__ssFleetFollower = { timer: null, sse: null, sseRetryMs: SSE_RETRY_MIN_MS, sseRetryAt: 0, ticking: false };
  return g.__ssFleetFollower;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Parse one SSE frame ("event: x\ndata: y"). Returns the event name and the data text. */
export function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length && event === 'message') return null;
  return { event, data: data.join('\n') };
}

export function shouldRefreshOn(eventType: string): boolean {
  return REFRESH_ON.test(eventType);
}

async function closeSse(reason: string): Promise<void> {
  const s = st();
  if (!s.sse) return;
  const { abort } = s.sse;
  s.sse = null;
  abort.abort();
  markSse('off');
  logger.info('SSE feed closed', { reason });
}

async function openSse(masterUrl: string, token: string): Promise<void> {
  const s = st();
  if (s.sse) return;
  if (Date.now() < s.sseRetryAt) return;
  const abort = new AbortController();
  s.sse = { abort, masterUrl };
  markSse('connecting');
  const url = `${masterUrl}/api/v1/events?app=${encodeURIComponent(APP_ID)}`;
  (async () => {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        cache: 'no-store',
        signal: abort.signal,
      });
      if (!r.ok || !r.body) {
        throw new Error(r.status === 401 ? 'SSE: token refused' : r.status === 403 ? 'SSE: token lacks fleet:read' : `SSE: HTTP ${r.status}`);
      }
      markSse('connected');
      s.sseRetryMs = SSE_RETRY_MIN_MS;
      logger.info('SSE feed connected', { masterUrl });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = parseSseFrame(frame);
          if (!ev || ev.event === 'hello') continue;
          if (shouldRefreshOn(ev.event)) {
            invalidateFollowedFleet();
            void refreshFollowedFleet().catch((err) => logger.warn('Refresh after SSE event failed', { event: ev.event, error: errMsg(err) }));
          }
        }
      }
      throw new Error('SSE: stream ended');
    } catch (err) {
      if (abort.signal.aborted) return;
      const msg = errMsg(err);
      markSse('disconnected', msg);
      s.sseRetryAt = Date.now() + s.sseRetryMs;
      logger.warn('SSE feed dropped; will retry', { masterUrl, error: msg, retryInMs: s.sseRetryMs });
      s.sseRetryMs = Math.min(s.sseRetryMs * 2, SSE_RETRY_MAX_MS);
    } finally {
      if (s.sse?.abort === abort) s.sse = null;
    }
  })();
}

/** One loop step. Exported for tests. */
export async function followerTick(): Promise<void> {
  const s = st();
  if (s.ticking) return;
  s.ticking = true;
  try {
    const settings = await getFleetSourceSettings();
    if (settings.source !== 'follow' || !settings.masterUrl || !settings.token) {
      await closeSse(settings.source !== 'follow' ? 'follow mode off' : 'master URL or token missing');
      return;
    }
    if (s.sse && s.sse.masterUrl !== settings.masterUrl) await closeSse('master URL changed');
    await refreshFollowedFleet({ ifOlderThanMs: FLEET_TTL_MS });
    await openSse(settings.masterUrl, settings.token);
  } catch (err) {
    logger.warn('Follower tick failed', { error: errMsg(err) });
  } finally {
    s.ticking = false;
  }
}

export function startFleetFollower(): void {
  const s = st();
  if (s.timer) return;
  s.timer = setInterval(() => { void followerTick(); }, TICK_MS);
  if (typeof s.timer === 'object' && s.timer && 'unref' in s.timer) (s.timer as { unref(): void }).unref();
  void followerTick();
  logger.info('Fleet follower started', { tickMs: TICK_MS });
}

export function stopFleetFollower(): void {
  const s = st();
  if (s.timer) { clearInterval(s.timer); s.timer = null; }
  void closeSse('stopped');
}
