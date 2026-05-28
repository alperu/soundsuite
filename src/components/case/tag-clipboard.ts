/**
 * Tag value clipboard helpers.
 *
 * `canonicalizeTagValue` produces the string that the copy icon writes to the
 * clipboard. The contract:
 *   - ref payloads → bare UUID (NOT the display name). Lets the user paste
 *     the value into another ref tag's edit field and have it commit as a
 *     `{_kind:'ref',val:<uuid>}` Hayson payload.
 *   - dates / dateTimes (Hayson `{_kind:'date',val:'…'}`) → ISO-8601 string.
 *   - strings → the string itself (no JSON-quotes — paste is meant to flow
 *     into another text input).
 *   - numbers / booleans → JSON.stringify (`"1.5"`, `"true"`).
 *   - arrays → comma-joined canonical form of each element.
 *
 * `parseClipboardForSpec` is the inverse: given a tag spec + raw clipboard
 * string, return the value to commit. Refs wrap into Hayson ref payloads;
 * dates normalize to ISO-8601 (YYYY-MM-DD) Hayson; numbers parse to Number;
 * bools parse "true"/"false"/"1"/"0". Returns `{ value }` on success or
 * `{ error }` on failure.
 */

import type { TagSpec } from './tag-spec';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function unwrapHayson(v: unknown): { kind?: string; val?: string } | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { _kind?: unknown; val?: unknown };
    if (typeof o._kind === 'string') {
      return {
        kind: o._kind,
        val: typeof o.val === 'string' ? o.val : undefined,
      };
    }
  }
  return null;
}

/**
 * Produce a clipboard-bound string for a tag value. Returns '' when there
 * is nothing copy-worthy (null/undefined/empty).
 */
export function canonicalizeTagValue(spec: TagSpec, value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map(v => canonicalizeTagValue(spec, v))
      .filter(Boolean)
      .join(', ');
  }

  const hayson = unwrapHayson(value);
  if (hayson) {
    // Ref Hayson: copy the UUID, never the display name.
    if (hayson.kind === 'ref') return hayson.val ?? '';
    // Date/dateTime: copy the ISO string verbatim.
    if (hayson.kind === 'date' || hayson.kind === 'dateTime') return hayson.val ?? '';
    // Number/Bool Hayson (rare) — fall through to JSON.stringify of val.
    if (hayson.val != null) return hayson.val;
  }

  if (spec.valueType === 'ref') {
    // Raw string ref (no Hayson wrapper) — strip leading "@" if present.
    if (typeof value === 'string') return value.replace(/^@/, '');
  }

  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  // Last-resort fallback for unknown object shapes.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type ParseResult =
  | { value: unknown; error?: undefined }
  | { value?: undefined; error: string };

/**
 * Parse a clipboard string into a value suitable for commitEntity.
 * Light validation only — the picker / input the value flows through is
 * still responsible for its own validation.
 */
export function parseClipboardForSpec(spec: TagSpec, raw: string): ParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Clipboard is empty' };

  if (spec.valueType === 'ref') {
    const uuid = trimmed.replace(/^@/, '');
    if (!UUID_RE.test(uuid)) {
      return { error: 'Clipboard value is not a valid ref UUID' };
    }
    return { value: { _kind: 'ref', val: uuid } };
  }

  if (spec.valueType === 'date') {
    // Accept ISO date (YYYY-MM-DD) or ISO dateTime (we take the date portion).
    let iso = trimmed;
    if (ISO_DATETIME_RE.test(iso)) iso = iso.slice(0, 10);
    if (!ISO_DATE_RE.test(iso)) {
      // Try Date parse as a last resort.
      const d = new Date(trimmed);
      if (Number.isNaN(d.getTime())) {
        return { error: 'Clipboard value is not an ISO-8601 date' };
      }
      iso = d.toISOString().slice(0, 10);
    }
    return { value: { _kind: 'date', val: iso } };
  }

  if (spec.valueType === 'number') {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { error: 'Clipboard value is not a number' };
    return { value: n };
  }

  if (spec.valueType === 'bool') {
    const low = trimmed.toLowerCase();
    if (low === 'true' || low === '1') return { value: true };
    if (low === 'false' || low === '0') return { value: false };
    return { error: 'Clipboard value is not a boolean' };
  }

  // text / unspecified → use the raw string.
  return { value: trimmed };
}

/**
 * Should we render copy/paste affordances for this spec?
 * Skips: markers (booleans presented as on/off chips have no copy-paste
 * meaning), internal tags, and read-only/computed values flagged via
 * `spec.info?.mapsTo` containing "computed (" — those can be COPIED but
 * pasting is ignored by the resolver, so we render copy-only there.
 */
export function clipboardSupport(spec: TagSpec): { copy: boolean; paste: boolean } {
  if (spec.internal) return { copy: false, paste: false };
  if (spec.tier === 'marker') return { copy: false, paste: false };
  const computed = typeof spec.info?.mapsTo === 'string' && /computed\s*\(/.test(spec.info.mapsTo);
  return { copy: true, paste: !computed };
}
