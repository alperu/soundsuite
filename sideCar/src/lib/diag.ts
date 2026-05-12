/**
 * Container-environment diagnostics for the sidecar setup UI.
 *
 * Currently surfaces what kind of mount backs /app/config — the only path
 * the sidecar writes to in production. Operators who run the container
 * without an explicit named volume can lose their master list on
 * `docker rm`; the UI uses this to warn them.
 */

import fs from 'fs';
import path from 'path';

export type VolumeKind =
  | 'named' // docker named volume (-v ss-sidecar-config:/app/config)
  | 'anonymous' // anonymous volume (no name, lost on container recreate)
  | 'tmpfs' // ephemeral, lost on restart
  | 'host-bind' // bind mount from host filesystem
  | 'not-mounted' // no separate mount — same fs as rootfs (dev mode, host run)
  | 'unknown'; // could not determine

export interface VolumeMountInfo {
  path: string;
  kind: VolumeKind;
  source?: string;
  fsType?: string;
  /** True if persistence across container-recreate is guaranteed. */
  durable: boolean;
  /** Human-readable note appropriate to show in the setup UI. */
  note: string;
}

/**
 * Inspect /proc/self/mountinfo to figure out how /app/config is mounted.
 *
 * mountinfo line format (kernel docs, 36):
 *   mountID parentID major:minor root mountpoint mountOpts - fsType source superOpts
 *
 * The "source" for docker volumes looks like
 *   /var/lib/docker/volumes/<volume-name>/_data
 * for named volumes, or
 *   /var/lib/docker/volumes/<64-hex-char-id>/_data
 * for anonymous volumes.
 */
export function getConfigVolumeKind(configPath = '/app/config'): VolumeMountInfo {
  const fallback = (note: string, kind: VolumeKind = 'unknown'): VolumeMountInfo => ({
    path: configPath,
    kind,
    durable: kind === 'named' || kind === 'host-bind',
    note,
  });

  // Outside Linux containers /proc/self/mountinfo doesn't exist (or is empty
  // of useful entries). Treat that as "not in a container" rather than a
  // warning condition.
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return fallback('Not running in a Linux container — persistence handled by the host filesystem.', 'not-mounted');
  }

  const normTarget = path.resolve(configPath);

  // Pick the most-specific mount whose mountpoint is an ancestor of (or equals)
  // the config path. mountinfo is in mount order — later entries can shadow
  // earlier ones, so we walk all lines and keep the longest match.
  let bestMountpoint = '';
  let bestSource = '';
  let bestFsType = '';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const dash = line.indexOf(' - ');
    if (dash < 0) continue;
    const left = line.slice(0, dash).split(' ');
    const right = line.slice(dash + 3).split(' ');
    const mountpoint = left[4];
    const fsType = right[0];
    const source = right[1];
    if (!mountpoint) continue;
    if (normTarget === mountpoint || normTarget.startsWith(mountpoint + '/')) {
      if (mountpoint.length > bestMountpoint.length) {
        bestMountpoint = mountpoint;
        bestSource = source ?? '';
        bestFsType = fsType ?? '';
      }
    }
  }

  if (!bestMountpoint) {
    return fallback(`No mount entry covers ${configPath}.`, 'unknown');
  }

  // If the matched mount is the root filesystem itself, /app/config has no
  // dedicated volume — it lives on the container's writable layer and will
  // disappear on `docker rm`.
  if (bestMountpoint === '/' && (normTarget !== '/')) {
    return {
      path: configPath,
      kind: 'anonymous',
      source: bestSource,
      fsType: bestFsType,
      durable: false,
      note: `${configPath} is on the container's writable layer (no volume mounted). The master list will be lost when the container is recreated. Re-run docker with -v ss-sidecar-config:${configPath} to fix.`,
    };
  }

  if (bestFsType === 'tmpfs') {
    return {
      path: configPath,
      kind: 'tmpfs',
      source: bestSource,
      fsType: bestFsType,
      durable: false,
      note: `${configPath} is a tmpfs — data is lost on container restart.`,
    };
  }

  // Docker volume source paths.
  // Named:     /var/lib/docker/volumes/<name>/_data       (name may contain hyphens/underscores)
  // Anonymous: /var/lib/docker/volumes/<64-hex>/_data
  const volMatch = /\/var\/lib\/docker\/volumes\/([^/]+)\/_data/.exec(bestSource);
  if (volMatch) {
    const volName = volMatch[1];
    const isAnonymous = /^[0-9a-f]{64}$/.test(volName);
    if (isAnonymous) {
      return {
        path: configPath,
        kind: 'anonymous',
        source: bestSource,
        fsType: bestFsType,
        durable: false,
        note: `${configPath} is on an anonymous Docker volume (${volName.slice(0, 12)}…). The master list will be lost if the container is recreated. Re-run docker with -v ss-sidecar-config:${configPath} to fix.`,
      };
    }
    return {
      path: configPath,
      kind: 'named',
      source: bestSource,
      fsType: bestFsType,
      durable: true,
      note: `Persisted on Docker named volume "${volName}".`,
    };
  }

  // Anything else under the host filesystem is treated as a bind mount.
  return {
    path: configPath,
    kind: 'host-bind',
    source: bestSource,
    fsType: bestFsType,
    durable: true,
    note: `Bind-mounted from host: ${bestSource}`,
  };
}
