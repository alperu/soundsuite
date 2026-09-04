/**
 * Lazily materialise the saved preset named `default` for the routed profile
 * (report item M-3).
 *
 * On first use, if no saved preset named `default` exists and at least one
 * cloud provider is configured, the code defaults from `getDefaultRoutingInfo()`
 * are persisted under a fixed row id so operators can see and edit what the
 * routed profile actually does. Idempotent: an existing `default` (any id) is
 * never overwritten, the result is memoised per process, and the fixed id
 * makes concurrent first calls across processes converge on one row.
 */

import { createLogger } from '../../logger';
import { getDefaultRoutingInfo } from '../routing-defaults';
import { getPreset, savePreset, type StoredPreset } from '../presets/preset-store';
import { DEFAULT_PRESET_NAME } from '../presets/preset-session';
import type { PresetV2 } from '../research-types';

const logger = createLogger('McpDefaultPreset');

/** Fixed row id so concurrent creators upsert the same row instead of racing to two. */
export const DEFAULT_PRESET_ID = 'preset-default';

let known: StoredPreset | null = null;
let inFlight: Promise<StoredPreset | null> | null = null;

/**
 * Returns the saved `default` preset, creating it from the code defaults when
 * missing and a cloud provider is configured. Returns null when nothing was
 * created (Ollama-only host) — callers then keep using `getDefaultRouting()`.
 */
export async function ensureDefaultPreset(): Promise<StoredPreset | null> {
  if (known) return known;
  if (inFlight) return inFlight;
  inFlight = ensure().finally(() => { inFlight = null; });
  return inFlight;
}

/** Fire-and-forget variant for hot paths: never throws, logs failures. */
export function ensureDefaultPresetInBackground(): void {
  void ensureDefaultPreset().catch((err) => {
    logger.warn('ensureDefaultPreset failed', { error: err instanceof Error ? err.message : String(err) });
  });
}

async function ensure(): Promise<StoredPreset | null> {
  const existing = await getPreset(DEFAULT_PRESET_NAME);
  if (existing) {
    known = existing;
    return existing;
  }

  const info = await getDefaultRoutingInfo();
  if (info.source !== 'code:cloud') {
    logger.debug('no cloud provider configured; not creating a "default" preset');
    return null;
  }

  const preset: PresetV2 = { version: 2, name: DEFAULT_PRESET_NAME, routing: info.routing };
  try {
    const saved = await savePreset(preset, DEFAULT_PRESET_ID);
    known = saved;
    logger.info('created "default" preset from cloud-first routing defaults', {
      id: saved.id,
      deep: `${info.routing.deep.provider}/${info.routing.deep.model ?? ''}`,
    });
    return saved;
  } catch (err) {
    // Lost a create race with another process: the row now exists — use it.
    const again = await getPreset(DEFAULT_PRESET_NAME);
    if (again) {
      known = again;
      return again;
    }
    throw err;
  }
}

export function _resetDefaultPresetForTests(): void {
  known = null;
  inFlight = null;
}
