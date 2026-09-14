/**
 * Process-wide singletons for the sidecar.
 *
 * Next.js compiles `instrumentation.ts` and the App Router route handlers as
 * separate webpack layers. A module imported from both sides is bundled TWICE
 * (`.next/server/chunks/<a>.js` for instrumentation, `<b>.js` for routes), so a
 * plain module-level `const state = {...}` becomes two independent objects in
 * the same Node process.
 *
 * That is exactly what took the fleet dashboard dark: the gossip client started
 * from `instrumentation.ts` held the live WebSocket in ITS copy of `state`, while
 * `/api/masters` and `/api/status` read the routes' copy — `connectionMode:
 * 'disconnected'`, `lastHeartbeatAt: null` — and reported a host offline that the
 * master could see heartbeating. Worse, anything that dialled from the routes'
 * copy (`POST /api/masters` from the master's reverse-poll, `/api/ws-connect`)
 * opened a SECOND socket under the same agentUrl; the master supersedes per
 * agentUrl, so the two copies evicted each other every ~25 s and the host never
 * got a heartbeat through.
 *
 * `processGlobal` keys the singleton on `globalThis`, which both layers share.
 * The master already relies on the same trick for its relay (see
 * `src/lib/gpu/ws-relay.ts` in the dashboard). Use it for anything that must be
 * one-per-process: connection state, timers, ring buffers, caches that gate
 * side effects.
 */
export function processGlobal<T>(key: string, init: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>;
  const k = `__ss_sidecar__${key}`;
  if (g[k] === undefined) g[k] = init();
  return g[k] as T;
}
