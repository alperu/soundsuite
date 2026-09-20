/**
 * Developer mode marker.
 *
 * `isDevMode()` is true only while the file `config/dev-mode` exists on this
 * host. The file is gitignored, so a fresh checkout, a sidecar tarball or a
 * public snapshot never carries it, and nothing in `.env` can switch it on
 * by accident in a shared deployment.
 *
 * Today it gates exactly one thing: the `#auth=` URL fragment on
 * `/admin/login`, which lets a local browser agent (see docs/jev-browser.md)
 * start signed in. `/api/health` reports the flag as `devMode`.
 *
 *   touch config/dev-mode   # enable on this machine
 *   rm config/dev-mode      # disable
 */
import { existsSync } from 'fs';
import path from 'path';

export const DEV_MODE_MARKER = path.join('config', 'dev-mode');

export function devModeMarkerPath(root: string = process.cwd()): string {
  return path.join(root, DEV_MODE_MARKER);
}

export function isDevMode(root: string = process.cwd()): boolean {
  try {
    return existsSync(devModeMarkerPath(root));
  } catch {
    return false;
  }
}
