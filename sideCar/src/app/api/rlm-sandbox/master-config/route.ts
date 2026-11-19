/**
 * GET /api/rlm-sandbox/master-config?master=<master URL>
 *
 * Local hand-off from this sidecar to its ss-rlm-sandbox container
 * (docs/tasks/59). The sandbox calls OpenRouter directly; this tells it which
 * key, model and domain belong to the master that sent the request.
 *
 * Auth: `X-Sandbox-Token` must equal `SS_SANDBOX_TOKEN`, which only this
 * sidecar passes to the container it creates (docker.ts). Missing or wrong →
 * 401. The route answers nothing else to anyone else.
 *
 * Every error carries `handoff: true` and header `X-Sandbox-Handoff: 1`. The
 * sandbox treats a 404 WITHOUT that marker as "older sidecar, no such route"
 * and falls back to the old chat route; with the marker it is a real "this
 * master has no slot".
 *
 * Never logs the key; the response is `no-store`.
 */
import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { resolveSandboxSlot, sandboxToken } from '@/lib/sandbox-slot';
import { createLogger } from '@/lib/logger';

const log = createLogger('rlm-sandbox-handoff');

const HEADERS = { 'X-Sandbox-Handoff': '1', 'Cache-Control': 'no-store' };

function err(status: number, message: string) {
  return NextResponse.json(
    { error: { message, code: status }, handoff: true },
    { status, headers: HEADERS },
  );
}

function tokenOk(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(sandboxToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!tokenOk(req.headers.get('x-sandbox-token'))) {
    log.warn('refused master-config: missing or wrong sandbox token');
    return err(401, 'sandbox token missing or wrong');
  }
  const master = req.nextUrl.searchParams.get('master')?.trim() || undefined;
  const r = resolveSandboxSlot(master);
  if (!r.ok) {
    log.warn(`master-config refused (${r.status}): ${r.error}`);
    return err(r.status, r.error);
  }
  return NextResponse.json(
    { master: r.serverUrl, apiKey: r.apiKey, model: r.model, domain: r.domain },
    { headers: HEADERS },
  );
}
