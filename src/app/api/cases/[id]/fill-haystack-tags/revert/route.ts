/**
 * POST /api/cases/[id]/fill-haystack-tags/revert
 *
 * Reverts a previously-applied tag-fill change recorded by Agent E.
 *
 * Phase-2 contract — the AI extractor route writes an `ActionLog` row for
 * every applied (filing, field) pair when `dryRun:false, accept:[...]`. The
 * schema's `ActionLog` model has no JSON column, so the pre-fill snapshot
 * lives JSON-encoded inside the `detail` String column. Shape:
 *
 *   detail: JSON.stringify({
 *     filingId:  string,
 *     filingTitle?: string,
 *     kind:      string,              // commitEntity kind: 'notice' | 'brief' | …
 *     field:     string,              // e.g. 'filedOn', 'judgeRef'
 *     beforeValue: unknown,           // ISO date / Hayson ref / null
 *     afterValue:  unknown,
 *     reverted?:   boolean,           // flipped to true after a successful revert
 *   })
 *
 * The `logType` column is set to 'tag-fill'. The action / target columns
 * are free-form ('Tag fill' / `${filingTitle} · ${field}` is the suggested
 * shape) — only `logType` is contractually significant.
 *
 * Body:   { actionLogId: string }
 * 200:    { ok: true, row: <updated entity row> }
 * 400:    { ok: false, error: 'missing_action_log_id' | 'wrong_log_type'
 *                          | 'case_id_mismatch' | 'invalid_detail'
 *                          | 'already_reverted' | 'commit_failed' }
 * 404:    { ok: false, error: 'action_log_not_found' }
 * 500:    { ok: false, error: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { commitEntity } from '@/app/api/haystack/[op]/route';

export const dynamic = 'force-dynamic';

interface RevertRequest {
  actionLogId?: string;
}

interface TagFillDetail {
  filingId: string;
  filingTitle?: string;
  kind: string;
  field: string;
  beforeValue: unknown;
  afterValue?: unknown;
  reverted?: boolean;
}

function parseDetail(raw: string | null | undefined): TagFillDetail | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.filingId === 'string' &&
      typeof parsed.kind === 'string' &&
      typeof parsed.field === 'string' &&
      'beforeValue' in parsed
    ) {
      return parsed as TagFillDetail;
    }
    return null;
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: caseId } = await params;

    let body: RevertRequest = {};
    try {
      const raw = await request.json();
      if (raw && typeof raw === 'object') body = raw as RevertRequest;
    } catch {
      /* tolerate empty body — will fall through to the missing_action_log_id branch */
    }

    const actionLogId = body.actionLogId;
    if (!actionLogId || typeof actionLogId !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'missing_action_log_id' },
        { status: 400 },
      );
    }

    // `prisma` is exported as `unknown` from the extended client wrapper —
    // every existing caller (see admin/action-logs/route.ts) accesses
    // `prisma.actionLog` directly and the codebase has the same TS2339
    // warning today. We cast to keep our touched files clean.
    const log = await (prisma as any).actionLog.findUnique({
      where: { id: actionLogId },
    });

    if (!log) {
      return NextResponse.json(
        { ok: false, error: 'action_log_not_found' },
        { status: 404 },
      );
    }

    if (log.logType !== 'tag-fill') {
      return NextResponse.json(
        { ok: false, error: 'wrong_log_type' },
        { status: 400 },
      );
    }

    if (log.caseId && log.caseId !== caseId) {
      return NextResponse.json(
        { ok: false, error: 'case_id_mismatch' },
        { status: 400 },
      );
    }

    const detail = parseDetail(log.detail);
    if (!detail) {
      return NextResponse.json(
        { ok: false, error: 'invalid_detail' },
        { status: 400 },
      );
    }

    if (detail.reverted === true) {
      return NextResponse.json(
        { ok: false, error: 'already_reverted' },
        { status: 400 },
      );
    }

    // Write the pre-fill value back onto the filing row via the same
    // commit path the rest of the panel uses. Bypasses any extractor logic
    // — we trust the snapshot captured at apply time.
    const result = await commitEntity({
      id: detail.filingId,
      kind: detail.kind,
      patch: { [detail.field]: detail.beforeValue },
    });

    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: 'commit_failed', detail: result.errGridJson },
        { status: 400 },
      );
    }

    // Mark the ActionLog so a second click can't double-revert. We re-stringify
    // the same JSON with the `reverted` flag flipped.
    const updatedDetail: TagFillDetail = { ...detail, reverted: true };
    await (prisma as any).actionLog.update({
      where: { id: actionLogId },
      data: {
        detail: JSON.stringify(updatedDetail),
        status: 'reverted',
      },
    });

    return NextResponse.json({ ok: true, row: result.row });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'fill_haystack_tags_revert_failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
