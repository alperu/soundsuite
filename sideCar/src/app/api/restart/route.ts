import { NextResponse } from 'next/server';
import { resolveSelfContainer, restartContainer } from '@/lib/docker';
import { createLogger } from '@/lib/logger';

const log = createLogger('restart');

const cors = { 'Access-Control-Allow-Origin': '*' };

/**
 * Restarts the SIDECAR'S OWN CONTAINER. Not the Docker engine — a container
 * cannot restart the daemon it runs on, and on macOS/Windows that daemon lives
 * in a VM the container has no authority over. Engine start/stop/restart is an
 * operator action elsewhere (OliveTin `build/docker/docker-ctl.sh`, over SSH).
 *
 * Operator-initiated only. Nothing in the sidecar may call this on a condition:
 * a self-restart loop on a remote host is very hard to break.
 *
 * GET  → feasibility, so the UI can disable the control and show why.
 * POST → 202 with the resolved target, then the restart on a short delay.
 */

/** Seconds Docker waits after SIGTERM before SIGKILL. */
const STOP_GRACE_SECONDS = 10;

/**
 * Delay before issuing the restart. The response must flush first: once the
 * daemon kills this container the socket is gone and nothing can be sent.
 * Mirrors the same trick in `src/app/api/update/route.ts`, which schedules
 * performUpdate() (it calls process.exit) 100 ms after responding.
 */
const RESTART_DELAY_MS = 250;

const NOT_THE_ENGINE =
  'This restarts the sidecar container only. It does not restart the Docker engine, ' +
  'and it does not restart the model containers — host-Ollama and Docker Model Runner ' +
  'roles are unaffected by design.';

const COUNTER_NOTE =
  'A restart discards in-memory activeRequests accounting; the master\'s view of it does not ' +
  'reset. POST /api/reset-counters is the remedy.';

export async function GET() {
  const self = await resolveSelfContainer();
  if (!self.ok) {
    return NextResponse.json(
      { canRestart: false, reason: self.reason, detail: self.detail, note: NOT_THE_ENGINE },
      { headers: cors },
    );
  }
  return NextResponse.json(
    {
      canRestart: true,
      target: {
        id: self.id,
        shortId: self.shortId,
        name: self.name,
        identifiedBy: self.source,
        corroborated: self.corroborated,
      },
      note: NOT_THE_ENGINE,
      counters: COUNTER_NOTE,
    },
    { headers: cors },
  );
}

export async function POST() {
  let self;
  try {
    self = await resolveSelfContainer();
  } catch (err) {
    // resolveSelfContainer is written not to throw; if it does, say so rather
    // than emitting a bare 500 with no reason.
    return NextResponse.json(
      {
        restarting: false,
        reason: 'self-unresolvable',
        detail: `Resolving own container threw: ${(err as Error).message}`,
      },
      { status: 500, headers: cors },
    );
  }

  if (!self.ok) {
    log.warn(`Restart refused: ${self.reason} — ${self.detail}`);
    return NextResponse.json(
      { restarting: false, reason: self.reason, detail: self.detail, note: NOT_THE_ENGINE },
      { status: 409, headers: cors },
    );
  }

  log.info(`Self-restart requested — target ${self.name} (${self.shortId}), in ${RESTART_DELAY_MS}ms`);

  setTimeout(() => {
    restartContainer(self.id, STOP_GRACE_SECONDS).catch((err) => {
      // Once the daemon starts killing this container the socket dies, so a
      // transport error here is indistinguishable from a request that never
      // landed. Record it and let the container's return (or failure to
      // return) be the actual outcome — the 202 already said as much.
      log.warn(`Restart call returned an error (expected if the kill already landed): ${(err as Error).message}`);
    });
  }, RESTART_DELAY_MS);

  // 202, not 200: this reports that the request was accepted, NOT that the
  // restart succeeded. The outcome can only be observed by the sidecar coming
  // back — the caller must poll until it answers again.
  return NextResponse.json(
    {
      restarting: true,
      accepted: true,
      target: {
        id: self.id,
        shortId: self.shortId,
        name: self.name,
        identifiedBy: self.source,
        corroborated: self.corroborated,
      },
      delayMs: RESTART_DELAY_MS,
      stopGraceSeconds: STOP_GRACE_SECONDS,
      outcome: 'unknown — poll until the sidecar answers again; this response is not a success signal',
      note: NOT_THE_ENGINE,
      counters: COUNTER_NOTE,
    },
    { status: 202, headers: cors },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' },
  });
}
