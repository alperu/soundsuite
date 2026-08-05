/**
 * Mode catalog — server-only async resolvers.
 *
 * These functions read the Config table (Prisma) and therefore CANNOT be
 * imported from client components — webpack will try to bundle better-sqlite3
 * into the client chunk and fail (`Module not found: Can't resolve 'fs'`).
 *
 * Client code uses the pure metadata in `./mode-catalog` plus
 * `/api/admin/mode-catalog` for live default-model values.
 */

import 'server-only';

import { getConfig } from '@/lib/db/config';
import {
  MODE_METADATA,
  resolveModelFromConfig,
  type HostOs,
  type ModeCatalogEntry,
  type ModeName,
} from './mode-catalog';
import { ocrModelCaps } from './ocr-model-caps';

function buildDefaultModelMap(
  m: { availableOn: HostOs[] },
  model: string,
): Partial<Record<HostOs, string>> {
  const out: Partial<Record<HostOs, string>> = {};
  for (const os of m.availableOn) out[os] = model;
  return out;
}

/**
 * Model-aware availableOn. ss-ocr runs as a Docker image (docker-ollama);
 * Docker on Mac has no GPU passthrough, so models flagged !macCompatible
 * (e.g. PaddleOCR-VL) exclude mac-docker-ollama hosts. /admin/roleassign
 * filters its assignment chips from this list, so Mac rows lose the ss-ocr
 * chip whenever such a model is the configured OCR model.
 */
function effectiveAvailableOn(
  m: { name: ModeName; availableOn: HostOs[] },
  model: string,
): HostOs[] {
  if (m.name === 'ss-ocr' && !ocrModelCaps(model).macCompatible) {
    return m.availableOn.filter((os) => os !== 'mac-docker-ollama');
  }
  return m.availableOn;
}

/**
 * Async catalog view. Reads Config once and folds the operator-set model
 * into every entry's `defaultModel` map. Single DB round-trip.
 */
export async function getModeCatalog(): Promise<ModeCatalogEntry[]> {
  const cfg = await getConfig();
  return MODE_METADATA.map((m) => {
    const model = resolveModelFromConfig(m.name, cfg);
    const availableOn = effectiveAvailableOn(m, model);
    return {
      ...m,
      availableOn,
      defaultModel: buildDefaultModelMap({ availableOn }, model),
    };
  });
}

/**
 * Async single-mode resolver — what the master should push as the
 * effective model for a given mode+OS when no per-host modelOverride is set.
 * Returns null when the mode is unavailable on this OS.
 */
export async function defaultModelForAsync(
  mode: ModeName,
  hostOs: HostOs,
): Promise<string | null> {
  const entry = MODE_METADATA.find((m) => m.name === mode);
  if (!entry) return null;
  const cfg = await getConfig();
  const model = resolveModelFromConfig(mode, cfg);
  if (!effectiveAvailableOn(entry, model).includes(hostOs)) return null;
  return model;
}
