/**
 * Where to send a browser that hit a 401 on a dashboard API call, and where
 * to send it back after it signs in.
 *
 * On a remotely-reachable deployment the origin guard (`guardApiRoute`)
 * answers 401 to every `/api/cases*` request until the browser holds a
 * dashboard session. Before this helper the case-management pages read that
 * 401 as "no such case" and rendered "Filing not found" / "Case not found".
 *
 * Client- and server-safe: no React, no `window` at module scope.
 */

export const LOGIN_PATH = '/admin/login';
export const DEFAULT_AFTER_LOGIN = '/admin/general';

/** Origin used only to resolve a candidate path; never dereferenced. */
const PROBE_ORIGIN = 'https://next-path.invalid';

/**
 * Accept only a same-origin path: exactly one leading `/`, no scheme, no
 * protocol-relative `//host`, no backslash, no control characters (URL
 * parsers strip tabs and newlines, so `/\t/host` would resolve to `//host`),
 * and never the login page itself (that would loop). The value is resolved
 * against a probe origin and must stay on it; the normalised
 * `pathname + search` is returned.
 */
export function safeNextPath(raw: string | string[] | null | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || typeof v !== 'string') return null;
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return null;
  let u: URL;
  try {
    u = new URL(v, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (u.origin !== PROBE_ORIGIN) return null;
  const path = u.pathname + u.search;
  if (path === LOGIN_PATH || path.startsWith(`${LOGIN_PATH}?`) || path.startsWith(`${LOGIN_PATH}/`)) return null;
  return path;
}

/** Destination after a successful sign-in. */
export function afterLoginPath(raw: string | string[] | null | undefined): string {
  return safeNextPath(raw) ?? DEFAULT_AFTER_LOGIN;
}

/** Login URL that returns the user to `next` afterwards. */
export function loginUrlFor(next: string | null | undefined): string {
  const safe = safeNextPath(next);
  return safe ? `${LOGIN_PATH}?next=${encodeURIComponent(safe)}` : LOGIN_PATH;
}

/** Login URL for the page the browser is on right now. */
export function loginUrlForCurrentPage(loc: Pick<Location, 'pathname' | 'search'> = window.location): string {
  return loginUrlFor(loc.pathname + loc.search);
}
