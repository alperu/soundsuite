/**
 * WebSocket Relay Server for GPU Sidecar Communication
 *
 * Runs on port 3002 (configurable via GPU_WS_PORT). Sidecars behind NAT/firewall
 * initiate WebSocket connections to this server. The server can then route commands
 * to sidecars through the WS tunnel when direct HTTP is not reachable.
 *
 * Protocol:
 *   Sidecar → Server:
 *     { type: "register", agentUrl, hostname, containers }
 *     { type: "heartbeat", containers, activeRequests }
 *     { type: "result", id, ... }
 *
 *   Server → Sidecar:
 *     { type: "command", id, action, role, ... }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createLogger } from '@/lib/logger';
import { setConfigValue } from '@/lib/db/config';
import { updateSidecarStatus, markSidecarDisconnected } from '@/lib/gpu/status-cache';
import { SidecarError } from '@/lib/gpu/sidecar-error';

const logger = createLogger('WsRelay');

const WS_PORT = parseInt(process.env.GPU_WS_PORT || '3002', 10);

interface SidecarConnection {
  ws: WebSocket;
  agentUrl: string;
  hostname: string;
  containers: string[];
  lastSeen: number;
  activeRequests: number;
}

interface PendingCommand {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Use globalThis to survive Next.js module isolation between worker-init and API route contexts.
// Without this, sendCommand() in API routes can't find the WS connections established in worker-init.
const g = globalThis as any;
if (!g.__ss_ws_sidecars__) g.__ss_ws_sidecars__ = new Map<string, SidecarConnection>();
if (!g.__ss_ws_pending__) g.__ss_ws_pending__ = new Map<string, PendingCommand>();
if (!g.__ss_ws_cmdCounter__) g.__ss_ws_cmdCounter__ = { value: 0 };
// Transient block-list — when an operator deletes a sidecar from /admin/gpu,
// add its agentUrl here with an expiry timestamp. Incoming register/heartbeat
// messages from a blocked agentUrl are refused (and the WS closed with a
// reason) so a still-running sidecar can't immediately reconnect and undo the
// deletion. Operators get ~60 s to stop the sidecar process or unconfigure
// its master URL before the block expires.
if (!g.__ss_ws_blocked__) g.__ss_ws_blocked__ = new Map<string, number>();
// Liveness sweep timer. Held on globalThis for the same reason the maps are:
// Next.js re-evaluates this module per context, and a second interval would
// double-ping every socket.
if (!g.__ss_ws_sweep__) g.__ss_ws_sweep__ = { timer: null as ReturnType<typeof setInterval> | null };

/**
 * How often the relay pings each sidecar socket. A socket that has not answered
 * a ping since the previous sweep is terminated.
 *
 * Why this must exist: `ws` only emits 'close' when the peer sends a TCP FIN.
 * A sidecar that dies, or whose VPN path drops, sends nothing — the socket stays
 * ESTABLISHED on this side forever and its file descriptor is never released.
 * Measured in production: ~10,200 ESTABLISHED sockets from a single sidecar host
 * accumulated over ~3.7 days, exhausting the process file-descriptor table, after
 * which every child_process spawn (the OCR worker, pdfimages, pdftoppm) failed
 * with `spawn EBADF`. Nothing in the relay was wrong about the sidecars it knew
 * about; it simply never learned the others were gone.
 */
const LIVENESS_SWEEP_MS = 30_000;

/**
 * How long a socket may stay connected without sending `register`.
 *
 * Supersede-and-close only fires from the `register` branch, so a socket that
 * connects and never registers is never superseded. The liveness sweep will not
 * reap it either, as long as it answers pings — leaving a live, unowned socket
 * holding a descriptor indefinitely. Observed as more open sockets on the relay
 * port than there are registered sidecars.
 *
 * A sidecar registers immediately after the handshake, so this only ever fires
 * on something that is not completing the protocol.
 */
const REGISTER_TIMEOUT_MS = Number(process.env.GPU_WS_REGISTER_TIMEOUT_MS || 30_000);

const sidecars: Map<string, SidecarConnection> = g.__ss_ws_sidecars__;
const pendingCommands: Map<string, PendingCommand> = g.__ss_ws_pending__;
const cmdCounter: { value: number } = g.__ss_ws_cmdCounter__;
const blockedAgents: Map<string, number> = g.__ss_ws_blocked__;
let wss: WebSocketServer | null = g.__ss_wss__ || null;

const BLOCK_DURATION_MS = 60_000;

function normalizeUrl(u: string): string { return u.replace(/\/+$/, ''); }

function isBlocked(agentUrl: string): boolean {
  const expiry = blockedAgents.get(normalizeUrl(agentUrl));
  if (!expiry) return false;
  if (Date.now() >= expiry) { blockedAgents.delete(normalizeUrl(agentUrl)); return false; }
  return true;
}

/** Block an agent from re-registering for BLOCK_DURATION_MS. Idempotent. */
export function blockAgent(agentUrl: string, ttlMs: number = BLOCK_DURATION_MS): void {
  blockedAgents.set(normalizeUrl(agentUrl), Date.now() + ttlMs);
}

/** Close any live WS for this agent and drop it from the in-memory map.
 *  Called by removeSidecar to make /admin/gpu deletes actually stick. */
export function closeSidecarConnection(agentUrl: string): boolean {
  const url = normalizeUrl(agentUrl);
  const conn = sidecars.get(agentUrl) || sidecars.get(url);
  if (!conn) return false;
  try {
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(1000, 'evicted-by-master');
    }
  } catch { /* ignore */ }
  sidecars.delete(conn.agentUrl);
  logger.info('Sidecar connection closed by master', { agentUrl: conn.agentUrl });
  return true;
}

/** Generate unique command ID */
function nextCommandId(): string {
  return `cmd-${Date.now()}-${++cmdCounter.value}`;
}

/** Update gpu.sidecars config in DB with current connections */
async function persistSidecarList(): Promise<void> {
  try {
    const list = Array.from(sidecars.values()).map(s => ({
      url: s.agentUrl,
      hostname: s.hostname,
      mode: 'websocket' as const,
      lastSeen: new Date(s.lastSeen).toISOString(),
      status: s.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
      containers: s.containers,
    }));
    await setConfigValue('gpu.sidecars', JSON.stringify(list));
  } catch (err) {
    logger.warn('Failed to persist sidecar list', { error: (err as Error).message });
  }
}

/** Start the WebSocket relay server */
/** Symbol key for per-socket liveness, so it cannot collide with `ws` internals. */
const ALIVE = Symbol.for('ss.wsRelay.alive');

function markAlive(ws: WebSocket): void {
  (ws as any)[ALIVE] = true;
}

/**
 * Close a socket and guarantee the descriptor is released.
 *
 * `ws.close()` is a graceful handshake: it waits for the peer's close frame. A
 * peer that is already gone never sends one, so the socket would sit in CLOSING
 * indefinitely — the same leak by another name. Terminate after a short grace
 * period if it has not finished closing on its own.
 */
function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closing or destroyed */
  }
  setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }, 5_000).unref?.();
}

/**
 * Ping every connected sidecar; terminate any that did not answer the previous
 * ping. This is what makes a silently-dead peer observable — see
 * `LIVENESS_SWEEP_MS` for why the relay cannot rely on 'close' alone.
 */
function runLivenessSweep(): void {
  if (!wss) return;
  for (const client of wss.clients) {
    if ((client as any)[ALIVE] !== true) {
      // Terminate, not close: it has already failed to answer a ping, so a
      // graceful handshake would wait for a peer that is not listening.
      logger.warn('Terminating unresponsive sidecar socket (no pong since last sweep)');
      try { client.terminate(); } catch { /* ignore */ }
      continue;
    }
    (client as any)[ALIVE] = false;
    try { client.ping(); } catch { /* ignore */ }
  }
}

function startLivenessSweep(): void {
  if (g.__ss_ws_sweep__.timer) return;
  g.__ss_ws_sweep__.timer = setInterval(runLivenessSweep, LIVENESS_SWEEP_MS);
  g.__ss_ws_sweep__.timer.unref?.();
}

/** Drive one sweep pass. Exported for tests only — production uses the interval. */
export function __sweepForTests(): void {
  runLivenessSweep();
}

function stopLivenessSweep(): void {
  if (g.__ss_ws_sweep__.timer) {
    clearInterval(g.__ss_ws_sweep__.timer);
    g.__ss_ws_sweep__.timer = null;
  }
}

/** Number of open sockets the relay is holding — for tests and diagnostics. */
export function getRelaySocketCount(): number {
  return wss ? wss.clients.size : 0;
}

export function startWsRelay(): WebSocketServer {
  if (wss) return wss;
  if (g.__ss_wss__) { wss = g.__ss_wss__; return wss!; }

  wss = new WebSocketServer({ port: WS_PORT, path: '/sidecar' });
  g.__ss_wss__ = wss;
  logger.info(`WebSocket relay server listening on port ${WS_PORT}`);

  wss.on('connection', (ws: WebSocket) => {
    let registeredUrl: string | null = null;

    // Liveness is tracked on the socket itself so the sweep needs no side table
    // to keep in sync (and nothing to leak if a socket dies unobserved).
    markAlive(ws);
    ws.on('pong', () => markAlive(ws));

    // Close a socket that never identifies itself. Cleared on register, and on
    // close so a short-lived connection leaves no timer behind.
    let registerTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      registerTimer = null;
      if (registeredUrl) return;
      logger.warn(
        `Closing WebSocket that did not register within ${REGISTER_TIMEOUT_MS}ms`,
      );
      closeSocket(ws, 1002, 'register-timeout');
    }, REGISTER_TIMEOUT_MS);
    registerTimer.unref?.();

    const clearRegisterTimer = () => {
      if (registerTimer) { clearTimeout(registerTimer); registerTimer = null; }
    };

    ws.on('message', async (raw: Buffer | string) => {
      // Any traffic proves the peer is alive, not just a pong.
      markAlive(ws);
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        logger.warn('Invalid JSON from sidecar WebSocket');
        return;
      }

      if (msg.type === 'register') {
        // Refuse register from a recently-deleted agent so /admin/gpu deletes
        // actually stick. The sidecar will see the close reason and back off.
        if (isBlocked(msg.agentUrl)) {
          logger.warn('Sidecar register refused — agent is in cooldown block-list', {
            agentUrl: msg.agentUrl,
            hostname: msg.hostname,
          });
          try { ws.close(1008, 'agent-blocked-by-master'); } catch { /* ignore */ }
          return;
        }
        registeredUrl = msg.agentUrl;
        clearRegisterTimer();
        // A sidecar that reconnects (its own watchdog forces one after three
        // failed heartbeats — sideCar/src/lib/ws-client.ts) arrives on a NEW
        // socket while the previous one may still be open. Overwriting the map
        // entry alone drops the only reference to that socket without closing
        // it, leaking one file descriptor per reconnect. Close it explicitly.
        const superseded = sidecars.get(msg.agentUrl);
        if (superseded && superseded.ws !== ws) {
          logger.info('Closing superseded sidecar socket', { agentUrl: msg.agentUrl });
          closeSocket(superseded.ws, 1012, 'superseded-by-new-registration');
        }
        sidecars.set(msg.agentUrl, {
          ws,
          agentUrl: msg.agentUrl,
          hostname: msg.hostname || 'unknown',
          containers: msg.containers || [],
          lastSeen: Date.now(),
          activeRequests: 0,
        });
        logger.info('Sidecar registered via WebSocket', {
          agentUrl: msg.agentUrl,
          hostname: msg.hostname,
        });

        // Feed status cache on registration
        updateSidecarStatus(msg.agentUrl, {
          hostname: msg.hostname,
          wsConnected: true,
        });

        await persistSidecarList();

        // Acknowledge registration
        ws.send(JSON.stringify({ type: 'registered', ok: true }));

        // Push canonical master URL so the sidecar persists it and survives
        // container recreation without operator re-config. Fire-and-forget.
        import('@/lib/gpu/master-identity').then(async ({ buildMasterIdentityFrame }) => {
          try {
            const frame = await buildMasterIdentityFrame(msg.agentUrl);
            if (frame && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(frame));
              logger.info('Pushed master-identity frame to sidecar', {
                agentUrl: msg.agentUrl,
                canonicalUrl: frame.canonicalUrl,
              });
            } else if (!frame) {
              logger.warn('Skipped master-identity push: canonical URL unknown', {
                agentUrl: msg.agentUrl,
              });
            }
          } catch (err) {
            logger.warn('Failed to push master-identity frame', {
              agentUrl: msg.agentUrl,
              error: (err as Error).message,
            });
          }
        }).catch(() => {});

        // Auto-push model registry + idle timeouts so the sidecar knows which models to pull.
        // Fire-and-forget — don't block registration on config push.
        import('@/lib/gpu/fleet-router').then(async ({ pushFullConfig }) => {
          try {
            const { getConfig } = await import('@/lib/db/config');
            const config = await getConfig();
            const timeouts = {
              embedding: config.gpuIdleEmbeddingMin,
              completion: config.gpuIdleCompletionMin,
              ocr: config.gpuIdleOcrMin,
              reranker: config.gpuIdleRerankerMin,
            };
            await pushFullConfig(msg.agentUrl, timeouts);
            logger.info('Auto-pushed config to newly registered sidecar', { agentUrl: msg.agentUrl });
          } catch (err) {
            logger.warn('Failed to auto-push config to sidecar', { agentUrl: msg.agentUrl, error: (err as Error).message });
          }
        }).catch(() => {});
      }

      else if (msg.type === 'heartbeat') {
        if (registeredUrl && sidecars.has(registeredUrl)) {
          const entry = sidecars.get(registeredUrl)!;
          entry.lastSeen = Date.now();
          entry.containers = msg.containers || entry.containers;
          entry.activeRequests = msg.activeRequests ?? entry.activeRequests;

          // Feed the status cache with heartbeat data
          updateSidecarStatus(registeredUrl, {
            hostname: entry.hostname,
            containers: msg.statusData?.containers,
            activeRequests: msg.activeRequests,
            mode: msg.statusData?.mode,
            uptime: msg.statusData?.uptime,
            roles: msg.statusData?.roles,
            peakDemand: msg.statusData?.peakDemand,
            gpus: msg.statusData?.gpus,
            idleTimeouts: msg.statusData?.idleTimeouts,
            version: msg.statusData?.version,
            wsConnected: true,
            masters: msg.statusData?.masters,
            lastConfigPushAt: msg.statusData?.lastConfigPushAt,
            vram: msg.statusData?.vram,
            // dockerMode at top level of sidecar /api/status — needed by the
            // enforcer + RerankerLifecycle dockerMode='none' skip guards.
            dockerMode: msg.statusData?.dockerMode,
          });

          // Sidecar reset detection on WS path: empty masters[] means the
          // sidecar lost its config. Fire an immediate reverse-poll on the
          // admin HTTP port (POST /api/masters) so the URL is back in place
          // even if the watchdog tick hasn't run yet.
          const masters = msg.statusData?.masters;
          if (Array.isArray(masters) && masters.length === 0) {
            logger.warn(
              `Sidecar boot detected with empty master list: ${registeredUrl} — reasserting URL`,
              { agentUrl: registeredUrl },
            );
            const url = registeredUrl;
            import('@/lib/gpu/sidecar-reconnect-watchdog').then(
              ({ triggerReassertNow }) => triggerReassertNow(url).catch(() => {}),
            ).catch(() => {});
          }
        }
      }

      else if (msg.type === 'result') {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingCommands.delete(msg.id);
          if (msg.error) {
            pending.reject(new SidecarError(msg.error));
          } else {
            pending.resolve(msg);
          }
        }
      }
    });

    ws.on('close', async () => {
      clearRegisterTimer();
      if (!registeredUrl) return;
      // Only tear down shared state if the map still points at THIS socket. A
      // superseded socket closing later must not delete the replacement that
      // just registered, or the sidecar would be marked disconnected while its
      // live connection is sitting in the map.
      if (sidecars.get(registeredUrl)?.ws !== ws) {
        logger.info('Superseded sidecar socket closed', { agentUrl: registeredUrl });
        return;
      }
      logger.info('Sidecar WebSocket disconnected', { agentUrl: registeredUrl });
      sidecars.delete(registeredUrl);
      markSidecarDisconnected(registeredUrl);
      await persistSidecarList();
    });

    ws.on('error', (err) => {
      logger.warn('Sidecar WebSocket error', { error: err.message });
    });
  });

  wss.on('error', (err) => {
    logger.error('WebSocket relay server error', err);
  });

  startLivenessSweep();

  return wss;
}

/** Stop the WebSocket relay server */
export function stopWsRelay(): void {
  if (wss) {
    stopLivenessSweep();
    // `wss.close()` stops listening but does NOT close established client
    // sockets, so terminate them explicitly or they outlive the relay.
    for (const client of wss.clients) closeSocket(client, 1001, 'relay-shutting-down');
    wss.close();
    wss = null;
    sidecars.clear();
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error('WS relay shutting down'));
      pendingCommands.delete(id);
    }
    logger.info('WebSocket relay server stopped');
  }
}

/**
 * Send a command to a sidecar through the WebSocket tunnel.
 * Returns a promise that resolves with the sidecar's response.
 */
export function sendCommand(agentUrl: string, command: Record<string, any>, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const entry = sidecars.get(agentUrl);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WS sendCommand: no connection', {
        agentUrl,
        action: command.action,
        hasSidecar: sidecars.has(agentUrl),
        readyState: entry?.ws.readyState,
        connectedCount: sidecars.size,
      });
      return reject(new Error(`No active WebSocket connection for ${agentUrl}`));
    }

    const id = nextCommandId();
    const startTime = Date.now();

    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      logger.warn('WS command timed out', { id, action: command.action, agentUrl, timeoutMs });
      reject(new Error(`Command ${id} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCommands.set(id, {
      resolve: (result: any) => {
        const elapsed = Date.now() - startTime;
        logger.info('WS command completed', { id, action: command.action, elapsed: `${elapsed}ms`, agentUrl: entry.hostname });
        resolve(result);
      },
      reject: (error: Error) => {
        const elapsed = Date.now() - startTime;
        logger.warn('WS command failed', { id, action: command.action, elapsed: `${elapsed}ms`, error: error.message });
        reject(error);
      },
      timer,
    });

    logger.info('WS command sent', { id, action: command.action, agentUrl: entry.hostname });
    entry.ws.send(JSON.stringify({
      type: 'command',
      id,
      ...command,
    }));
  });
}

/** Check if a sidecar has an active WebSocket connection */
export function hasSidecarConnection(agentUrl: string): boolean {
  const entry = sidecars.get(agentUrl);
  const connected = !!entry && entry.ws.readyState === WebSocket.OPEN;
  // Debug: log connection check with Map state for diagnosing module isolation
  if (!connected && sidecars.size > 0) {
    logger.info('WS connection check: miss', {
      requestedUrl: agentUrl,
      connectedUrls: Array.from(sidecars.keys()),
      mapSize: sidecars.size,
    });
  }
  return connected;
}

/** Get list of connected sidecars */
export function getConnectedSidecars(): Array<{
  agentUrl: string;
  hostname: string;
  containers: string[];
  lastSeen: number;
  activeRequests: number;
}> {
  return Array.from(sidecars.values())
    .filter(s => s.ws.readyState === WebSocket.OPEN)
    .map(({ agentUrl, hostname, containers, lastSeen, activeRequests }) => ({
      agentUrl, hostname, containers, lastSeen, activeRequests,
    }));
}
