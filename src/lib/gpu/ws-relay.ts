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

const sidecars: Map<string, SidecarConnection> = g.__ss_ws_sidecars__;
const pendingCommands: Map<string, PendingCommand> = g.__ss_ws_pending__;
const cmdCounter: { value: number } = g.__ss_ws_cmdCounter__;
let wss: WebSocketServer | null = g.__ss_wss__ || null;

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
export function startWsRelay(): WebSocketServer {
  if (wss) return wss;
  if (g.__ss_wss__) { wss = g.__ss_wss__; return wss!; }

  wss = new WebSocketServer({ port: WS_PORT, path: '/sidecar' });
  g.__ss_wss__ = wss;
  logger.info(`WebSocket relay server listening on port ${WS_PORT}`);

  wss.on('connection', (ws: WebSocket) => {
    let registeredUrl: string | null = null;

    ws.on('message', async (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        logger.warn('Invalid JSON from sidecar WebSocket');
        return;
      }

      if (msg.type === 'register') {
        registeredUrl = msg.agentUrl;
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
            vram: msg.statusData?.vram,
          });
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
      if (registeredUrl) {
        logger.info('Sidecar WebSocket disconnected', { agentUrl: registeredUrl });
        sidecars.delete(registeredUrl);
        markSidecarDisconnected(registeredUrl);
        await persistSidecarList();
      }
    });

    ws.on('error', (err) => {
      logger.warn('Sidecar WebSocket error', { error: err.message });
    });
  });

  wss.on('error', (err) => {
    logger.error('WebSocket relay server error', err);
  });

  return wss;
}

/** Stop the WebSocket relay server */
export function stopWsRelay(): void {
  if (wss) {
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
