/**
 * Worker pool settings for direct OpenRouter calls.
 *
 * Stored in Config as `openrouter.workers` (see src/lib/db/config.ts) and
 * edited on /admin/openrouter. Max 8: more parallel bulk requests than that
 * mostly buy 429s.
 */

export interface SettingRange {
  min: number;
  max: number;
  def: number;
}

export const POOL_LIMITS = {
  workerCount: { min: 1, max: 8, def: 6 },
  interactiveSlots: { min: 1, max: 8, def: 2 },
} as const satisfies Record<string, SettingRange>;

export interface PoolSettings {
  /** One worker = one bulk OpenRouter request in flight. */
  workerCount: number;
  /** Own lane for searches, chat and answers; never waits behind bulk. */
  interactiveSlots: number;
}

/** Any input → a whole number inside the range; junk → the default. */
export function clampSetting(raw: unknown, r: SettingRange): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return r.def;
  return Math.min(r.max, Math.max(r.min, Math.round(n)));
}

export function clampWorkerCount(raw: unknown): number {
  return clampSetting(raw, POOL_LIMITS.workerCount);
}

/** Range problem in a user-supplied workers value, or null when it is fine
 *  (or absent — absent means "leave it alone"). */
export function validateWorkerCount(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  const r = POOL_LIMITS.workerCount;
  if (!Number.isInteger(n) || n < r.min || n > r.max) {
    return `workers must be a whole number from ${r.min} to ${r.max}`;
  }
  return null;
}

export function defaultPoolSettings(): PoolSettings {
  return {
    workerCount: POOL_LIMITS.workerCount.def,
    interactiveSlots: POOL_LIMITS.interactiveSlots.def,
  };
}
