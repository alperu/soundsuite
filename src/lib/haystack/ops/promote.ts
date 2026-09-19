/**
 * `ssPromoteDiscovered` / `ssRequeueErrored` — thin adapters over the bulk
 * promotion module (`lib/ingestion/promotion.ts`, docs/tasks/35), which is
 * already plan-then-apply with a required cap. The op adds only the dry-run
 * default and the grid shape.
 */
import type { PrismaClient } from '@prisma/client';
import {
  applyPromotion,
  applyRequeue,
  planPromotion,
  planRequeueErrored,
} from '@/lib/ingestion/promotion';
import { bareId, OpError, type OpContext, type OpResult } from './types';

/** The promotion module is typed on the bare client; the extension adds no
 *  method it uses. */
const bare = (ctx: OpContext) => ctx.prisma as unknown as PrismaClient;

export interface PromoteParams {
  caseId?: string;
  limit: number;
  dryRun?: boolean;
}

function requireLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new OpError('INVALID_PARAMS', 'limit must be a positive integer — there is deliberately no default');
  }
  return raw;
}

export async function ssPromoteDiscovered(ctx: OpContext, params: PromoteParams): Promise<OpResult> {
  const limit = requireLimit(params.limit);
  const caseId = params.caseId ? bareId(params.caseId, 'caseId') : undefined;
  const dryRun = params.dryRun !== false;

  const plan = await planPromotion(bare(ctx), { limit, caseId });
  const base = {
    measuredAt: plan.measuredAt.toISOString(),
    caseId: plan.caseId,
    limit: plan.limit,
    planned: plan.documentIds.length,
    remainingInCase: plan.remainingInCase,
    waveOrder: plan.waveOrder,
  };
  if (dryRun) {
    return {
      meta: { action: 'plan', dryRun: true, ...base },
      rows: plan.documentIds.map((id) => ({ doc: id, from: 'DISCOVERED', to: 'QUEUED' })),
    };
  }
  const result = await applyPromotion(bare(ctx), plan);
  return {
    meta: { action: 'applied', dryRun: false, ...base, promoted: result.promoted, skipped: result.skipped.length },
    rows: plan.documentIds.map((id) => ({
      doc: id,
      from: 'DISCOVERED',
      to: result.skipped.includes(id) ? 'skipped (no longer DISCOVERED)' : 'QUEUED',
    })),
  };
}

export async function ssRequeueErrored(ctx: OpContext, params: PromoteParams): Promise<OpResult> {
  const limit = requireLimit(params.limit);
  const caseId = params.caseId ? bareId(params.caseId, 'caseId') : undefined;
  const dryRun = params.dryRun !== false;

  const plan = await planRequeueErrored(bare(ctx), { limit, caseId });
  const errored = plan.documentIds.length
    ? await ctx.prisma.document.findMany({
        where: { id: { in: plan.documentIds } },
        select: { id: true, fileName: true, errorMessage: true },
      })
    : [];
  const byId = new Map(errored.map((d) => [d.id, d]));
  const base = {
    measuredAt: plan.measuredAt.toISOString(),
    caseId: caseId ?? null,
    limit: plan.limit,
    planned: plan.documentIds.length,
    erroredTotal: plan.erroredTotal,
  };
  if (dryRun) {
    return {
      meta: { action: 'plan', dryRun: true, ...base },
      rows: plan.documentIds.map((id) => ({ doc: id, dis: byId.get(id)?.fileName ?? null, lastError: byId.get(id)?.errorMessage ?? null, from: 'ERROR', to: 'QUEUED' })),
    };
  }
  const result = await applyRequeue(bare(ctx), plan);
  return {
    meta: { action: 'applied', dryRun: false, ...base, requeued: result.promoted, skipped: result.skipped.length },
    rows: plan.documentIds.map((id) => ({
      doc: id,
      dis: byId.get(id)?.fileName ?? null,
      lastError: byId.get(id)?.errorMessage ?? null,
      from: 'ERROR',
      to: result.skipped.includes(id) ? 'skipped (no longer ERROR)' : 'QUEUED',
    })),
  };
}
