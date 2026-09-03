/**
 * Session-scoped preset state (REPORT-v2.1 Part C.2, work item 7).
 *
 * Two stores, both on `globalThis` so they survive Next.js HMR like the
 * research job store:
 *
 * - temp presets: `preset_define` validates an inline preset and returns a
 *   handle `tmp_<id>` that lives 1 h and is never persisted. This is "set on
 *   the fly".
 * - active preset per MCP session (`mcp-session-id` header, `'anonymous'`
 *   when absent): `preset_apply` sets it from a saved id/name or a temp
 *   handle. Idle expiry 1 h — every `getActive` refreshes the timer.
 *
 * Timers are unref'd so they never keep a test process alive.
 */

import { randomUUID } from 'crypto';
import type { PresetV2 } from '../research-types';
import { McpError } from '../llm-policy';
import { getPreset } from './preset-store';

export const TEMP_PRESET_TTL_MS = 60 * 60 * 1000;
export const ACTIVE_PRESET_IDLE_MS = 60 * 60 * 1000;
export const ANONYMOUS_SESSION = 'anonymous';
export const DEFAULT_PRESET_NAME = 'default';

export type ActivePresetSource = 'temp' | 'saved' | 'default';

export interface ActivePreset {
  preset: PresetV2;
  source: ActivePresetSource;
  /** Saved row id (saved / default) or temp handle (temp). */
  ref: string;
}

interface TempEntry { preset: PresetV2; expiresAt: number; timer: ReturnType<typeof setTimeout> }
interface ActiveEntry extends ActivePreset { lastUsed: number; timer: ReturnType<typeof setTimeout> }

const g = globalThis as unknown as {
  __mcpTempPresets: Map<string, TempEntry> | undefined;
  __mcpActivePresets: Map<string, ActiveEntry> | undefined;
};
const temps: Map<string, TempEntry> = g.__mcpTempPresets ?? (g.__mcpTempPresets = new Map());
const actives: Map<string, ActiveEntry> = g.__mcpActivePresets ?? (g.__mcpActivePresets = new Map());

function unref(t: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (t as { unref?: () => void }).unref?.();
  return t;
}

export function normaliseSessionId(sessionId?: string | null): string {
  const s = sessionId?.trim();
  return s ? s : ANONYMOUS_SESSION;
}

export function isTempHandle(v: string): boolean {
  return v.startsWith('tmp_');
}

// ---------------------------------------------------------------------------
// Temp presets
// ---------------------------------------------------------------------------

/** Store an already-validated preset; returns its `tmp_…` handle. */
export function defineTemp(preset: PresetV2): string {
  const handle = `tmp_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const timer = unref(setTimeout(() => { temps.delete(handle); }, TEMP_PRESET_TTL_MS));
  temps.set(handle, { preset, expiresAt: Date.now() + TEMP_PRESET_TTL_MS, timer });
  return handle;
}

export function getTemp(handle: string): PresetV2 | null {
  const entry = temps.get(handle);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    clearTimeout(entry.timer);
    temps.delete(handle);
    return null;
  }
  return entry.preset;
}

export function deleteTemp(handle: string): boolean {
  const entry = temps.get(handle);
  if (!entry) return false;
  clearTimeout(entry.timer);
  temps.delete(handle);
  return true;
}

// ---------------------------------------------------------------------------
// Active preset per session
// ---------------------------------------------------------------------------

function touch(sessionId: string, entry: ActiveEntry): void {
  clearTimeout(entry.timer);
  entry.lastUsed = Date.now();
  entry.timer = unref(setTimeout(() => {
    if (actives.get(sessionId) === entry) actives.delete(sessionId);
  }, ACTIVE_PRESET_IDLE_MS));
}

/**
 * Make `idOrHandle` the session's active preset. A `tmp_…` handle resolves
 * from the temp store; anything else is a saved preset id or name. Throws
 * `McpError('NOT_FOUND')` when neither resolves.
 */
export async function setActive(sessionId: string | undefined, idOrHandle: string): Promise<ActivePreset> {
  const sid = normaliseSessionId(sessionId);
  const key = idOrHandle.trim();
  let resolved: ActivePreset | null = null;

  if (isTempHandle(key)) {
    const preset = getTemp(key);
    if (preset) resolved = { preset, source: 'temp', ref: key };
  } else {
    const stored = await getPreset(key);
    if (stored) {
      resolved = {
        preset: stored.preset,
        source: stored.name === DEFAULT_PRESET_NAME ? 'default' : 'saved',
        ref: stored.id,
      };
    }
  }
  if (!resolved) {
    throw new McpError('NOT_FOUND', `preset "${key}" not found (expected a saved preset id/name or a tmp_ handle from preset_define)`);
  }

  const prev = actives.get(sid);
  if (prev) clearTimeout(prev.timer);
  const entry: ActiveEntry = { ...resolved, lastUsed: Date.now(), timer: unref(setTimeout(() => {}, 0)) };
  actives.set(sid, entry);
  touch(sid, entry);
  return resolved;
}

/** The session's active preset, refreshing its idle timer. Null when none. */
export function getActive(sessionId?: string): ActivePreset | null {
  const sid = normaliseSessionId(sessionId);
  const entry = actives.get(sid);
  if (!entry) return null;
  if (entry.source === 'temp' && !getTemp(entry.ref)) {
    // The temp preset expired underneath the session.
    clearTimeout(entry.timer);
    actives.delete(sid);
    return null;
  }
  touch(sid, entry);
  const { preset, source, ref } = entry;
  return { preset, source, ref };
}

export function clearActive(sessionId?: string): boolean {
  const sid = normaliseSessionId(sessionId);
  const entry = actives.get(sid);
  if (!entry) return false;
  clearTimeout(entry.timer);
  actives.delete(sid);
  return true;
}

/**
 * Active preset for the session, else the saved preset named `default`
 * (operators override the code defaults by saving one), else null.
 */
export async function getActiveOrDefault(sessionId?: string): Promise<ActivePreset | null> {
  const active = getActive(sessionId);
  if (active) return active;
  const stored = await getPreset(DEFAULT_PRESET_NAME).catch(() => null);
  return stored ? { preset: stored.preset, source: 'default', ref: stored.id } : null;
}

/** Test hook — drop every temp preset, active preset and timer. */
export function _resetForTests(): void {
  for (const e of temps.values()) clearTimeout(e.timer);
  for (const e of actives.values()) clearTimeout(e.timer);
  temps.clear();
  actives.clear();
}
