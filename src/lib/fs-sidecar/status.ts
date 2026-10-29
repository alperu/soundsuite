/**
 * Live state of the file-system sidecars linked to this master.
 *
 * Kept on globalThis (like `gpu/ws-relay.ts`) so the API routes see the state
 * the link server writes from the worker-init context. No heavy imports here:
 * the admin fleet route reads it.
 */

export type FsConnectionMode = 'websocket' | 'http' | 'disconnected';

export interface FsSidecarStatus {
  sidecarId: string;
  username: string;
  version?: string;
  os?: string;
  profiles: string[];
  connectionMode: FsConnectionMode;
  /** Last `Ping` from the sidecar (Unix ms). */
  lastHeartbeatAt?: number;
  /** Last message of any kind (Unix ms). */
  lastSeenAt: number;
  connectedAt: number;
  peer?: string;
  /** Highest `FolderStatBatch.seq` this master acknowledged. */
  confirmedSeq: number;
  /** From the last `Status` message, when the sidecar sent one. */
  queueLen?: number;
}

const g = globalThis as unknown as { __ss_fs_sidecars__?: Map<string, FsSidecarStatus> };
if (!g.__ss_fs_sidecars__) g.__ss_fs_sidecars__ = new Map();
const registry = g.__ss_fs_sidecars__;

/** After this long with no message an HTTP-mode sidecar shows as disconnected. */
export const DEAD_AFTER_MS = 90_000;

export function upsertFsSidecar(id: string, patch: Partial<FsSidecarStatus> & { username: string }): FsSidecarStatus {
  const now = Date.now();
  const cur = registry.get(id) ?? {
    sidecarId: id,
    username: patch.username,
    profiles: [],
    connectionMode: 'disconnected' as FsConnectionMode,
    lastSeenAt: now,
    connectedAt: now,
    confirmedSeq: 0,
  };
  const next = { ...cur, ...patch };
  registry.set(id, next);
  return next;
}

export function getFsSidecar(id: string): FsSidecarStatus | undefined {
  return registry.get(id);
}

/** Snapshot for the UI. An HTTP link with no message for DEAD_AFTER_MS counts as down. */
export function getFsSidecarStatuses(now = Date.now(), deadAfterMs = DEAD_AFTER_MS): FsSidecarStatus[] {
  return [...registry.values()]
    .map((s) =>
      s.connectionMode === 'http' && now - s.lastSeenAt > deadAfterMs ? { ...s, connectionMode: 'disconnected' as FsConnectionMode } : { ...s },
    )
    .sort((a, b) => a.sidecarId.localeCompare(b.sidecarId));
}

/** Tests only. */
export function __resetFsSidecarsForTests(): void {
  registry.clear();
}
