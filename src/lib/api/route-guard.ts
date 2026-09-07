/**
 * One-liner auth for non-MCP API routes (v6 item 2).
 *
 * v6 measured `/api/config`, several `/api/admin/*` routes, `/api/docs/info`
 * and `POST /api/search/deep` answering 200 from a forged non-loopback origin:
 * the `/api/mcp/*` guard was the only gate on the server. This wraps the same
 * shared decision (`guardApiRoute` → `decideExecuteAuth`) in a `NextResponse`,
 * so a handler gates itself in two lines:
 *
 * ```ts
 * const denied = await requireApiAccess(request, { label: 'admin/system-info', allowAdminSession: true });
 * if (denied) return denied;
 * ```
 *
 * The refusal body is `{ error: <string>, code: <string> }` — a *string*
 * `error`, because every admin client in this repo renders `body.error`
 * directly (`e.error || 'HTTP ' + res.status`). `/api/mcp/*` keeps its nested
 * `{ error: { code, message } }` shape via `guardMcpRoute`.
 *
 * Env knobs are unchanged: `MCP_AUTH_MODE`, `MCP_API_KEYS` / `MCP_API_KEY`,
 * the `mcp.apiKeys` config row, `MCP_AUTH_STRICT_LOOPBACK`, `MCP_TRUST_PROXY`.
 */

import { NextResponse } from 'next/server';
import { guardApiRoute, type ApiGuardOptions, type ApiGuardRequest } from '@/lib/mcp/execute-auth';

export type { ApiGuardOptions, ApiGuardRequest };

/**
 * Returns a 401 `NextResponse` when the caller is refused, or `null` when it
 * may proceed. Call it before parsing the body and before touching the
 * database, so a refused caller learns nothing about the request shape.
 */
export async function requireApiAccess(
  request: ApiGuardRequest | null | undefined,
  opts: ApiGuardOptions,
): Promise<NextResponse | null> {
  const result = await guardApiRoute(request, opts);
  if (result.ok) return null;
  return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
}

/**
 * `requireApiAccess` preset for `/api/admin/*`: a live dashboard session is
 * sufficient on its own, otherwise the origin/API-key rule applies.
 *
 * Not applied to the sidecar-facing routes — `/api/admin/gpu/sidecars/*` is
 * called cross-host by sidecars that hold no credential. See
 * `docs/tasks/09-api-surface-guard-v6.md`.
 */
export async function requireAdminApiAccess(
  request: ApiGuardRequest | null | undefined,
  label: string,
): Promise<NextResponse | null> {
  return requireApiAccess(request, { label: `admin ${label}`, allowAdminSession: true });
}
