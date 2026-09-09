/**
 * Bulk promotion of `DISCOVERED` documents into the parsing queue
 * (docs/tasks/35-bulk-promotion.md).
 *
 * Promotion today exists only inline in two API routes — `api/cases/[id]/parse`
 * and `api/cases/[id]/filing-queue` — both of which promote as a side effect of
 * filing a document through the UI. There is no shared function and no bulk
 * path. (The `ssPromoteDiscovered` named in the planning documents does not
 * exist; every occurrence of that name is prose.) This module is the bulk path,
 * and it is deliberately built as *plan then apply* rather than as one call.
 *
 * Three properties the callers depend on:
 *
 *  1. **Wave order is computed, never stored.** `planPromotion` reads the live
 *     `DISCOVERED` counts on every call and orders cases ascending. A per-case
 *     table written into a document was stale within hours of being written;
 *     the ordering input changes as soon as promotion starts, so it is re-read
 *     rather than remembered.
 *  2. **Every plan is bounded.** `limit` is required, so there is no call shape
 *     that promotes the whole backlog by omission.
 *  3. **Applying is a separate call taking a plan.** A dry run and the run it
 *     describes go through the same selection code, so the preview cannot
 *     drift from the mutation.
 *
 * Promotion here is deliberately *unfiled*: it sets `status` and nothing else.
 * See `PROMOTION_MODE_RATIONALE` below for why.
 */

import type { PrismaClient } from '@prisma/client';

/**
 * Why bulk promotion leaves `filingId` alone (docs/tasks/34 item 5).
 *
 * `parsing-worker.ts` claims on `{ status: 'QUEUED' }` alone — no `filingId`
 * predicate, no join — so a filing is not required to parse. That makes the
 * choice free on the ingestion side and load-bearing on the failure side:
 *
 *  - **Filed** (`filingId` set): `worker-init.ts` re-queues, on every process
 *    init, every filed document whose status is not QUEUED/PROCESSING/INDEXED.
 *    A document that always fails is therefore retried on every restart, with
 *    no counter and no cap. The in-process OCR cap added for task 34 item 4
 *    does not reach this loop — an in-memory count cannot survive the restart
 *    that drives it.
 *  - **Unfiled** (`filingId` NULL): that hook cannot match it, so `ERROR` is
 *    terminal. A failure is lost until someone looks, but it is bounded.
 *
 * A bounded failure that has to be found is preferable to an unbounded one at
 * this scale, because the OCR branch's pause is process-wide: a handful of
 * permanently-unparseable documents cycling through restarts degrades the
 * whole pipeline, not only themselves. Bulk promotion therefore promotes
 * unfiled, and `requeueErrored` below is the deliberate, capped way back in.
 *
 * This reasoning is stated here rather than in a task file because it is the
 * comment a future caller of this module needs.
 */
export const PROMOTION_MODE_RATIONALE = 'unfiled: bounded failure over unbounded restart retry';

/** One case's share of the backlog, measured at plan time. */
export interface CasePromotionCount {
  caseId: string;
  /** Documents at `DISCOVERED` for this case when the plan was built. */
  discovered: number;
}

/** A bounded, previewable promotion. */
export interface PromotionPlan {
  /** When the counts behind this plan were read. */
  measuredAt: Date;
  /** Cases ordered ascending by `DISCOVERED` count at measurement time. */
  waveOrder: CasePromotionCount[];
  /** The case this plan promotes from, or null when the backlog is empty. */
  caseId: string | null;
  /** Document ids the plan would promote. Never longer than `limit`. */
  documentIds: string[];
  /** The cap the caller asked for. */
  limit: number;
  /**
   * `DISCOVERED` remaining in `caseId` after this plan is applied, assuming
   * nothing else writes in between. Reported so a caller can size the next
   * wave without re-deriving it — but the next plan re-measures regardless.
   */
  remainingInCase: number;
}

export interface PlanPromotionOptions {
  /**
   * Maximum documents to promote. Required — there is deliberately no default,
   * so no call promotes the whole backlog by omission.
   */
  limit: number;
  /**
   * Promote from this case. Omit to take the case with the smallest
   * `DISCOVERED` count, which is the wave order task 35 asks for: a systemic
   * failure then surfaces on tens of documents rather than hundreds.
   */
  caseId?: string;
}

/**
 * Measure the backlog and select a bounded set of documents to promote.
 *
 * Read-only: this function never writes. Its result is both the dry-run
 * preview and the input to `applyPromotion`.
 */
export async function planPromotion(
  prisma: PrismaClient,
  opts: PlanPromotionOptions
): Promise<PromotionPlan> {
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new Error(`planPromotion: limit must be a positive integer, got ${opts.limit}`);
  }

  const measuredAt = new Date();

  const grouped = await prisma.document.groupBy({
    by: ['caseId'],
    where: { status: 'DISCOVERED' },
    _count: { _all: true },
  });

  const waveOrder: CasePromotionCount[] = grouped
    .map((g) => ({ caseId: g.caseId as string, discovered: g._count._all }))
    // Ascending by backlog; caseId breaks ties so the order is deterministic
    // for a given measurement rather than dependent on group-by ordering.
    .sort((a, b) => a.discovered - b.discovered || a.caseId.localeCompare(b.caseId));

  const target = opts.caseId
    ? waveOrder.find((w) => w.caseId === opts.caseId)
    : waveOrder[0];

  if (!target) {
    return {
      measuredAt,
      waveOrder,
      caseId: opts.caseId ?? null,
      documentIds: [],
      limit: opts.limit,
      remainingInCase: 0,
    };
  }

  const docs = await prisma.document.findMany({
    where: { caseId: target.caseId, status: 'DISCOVERED' },
    orderBy: { createdAt: 'asc' },
    take: opts.limit,
    select: { id: true },
  });

  return {
    measuredAt,
    waveOrder,
    caseId: target.caseId,
    documentIds: docs.map((d) => d.id),
    limit: opts.limit,
    remainingInCase: Math.max(0, target.discovered - docs.length),
  };
}

export interface PromotionResult {
  /** Rows actually moved DISCOVERED → QUEUED. */
  promoted: number;
  /**
   * Ids in the plan that were no longer `DISCOVERED` when the write ran —
   * something else promoted, cleared or re-pathed them in between. Not an
   * error; reported so a caller can tell a short write from a lost one.
   */
  skipped: string[];
}

/**
 * Apply a plan. Promotes `DISCOVERED` → `QUEUED` and touches nothing else —
 * no `filingId`, no `documentType`. See `PROMOTION_MODE_RATIONALE`.
 *
 * The `status: 'DISCOVERED'` predicate is repeated in the write, so a document
 * that changed state between planning and applying is left alone rather than
 * dragged backwards out of PROCESSING or INDEXED.
 */
export async function applyPromotion(
  prisma: PrismaClient,
  plan: PromotionPlan
): Promise<PromotionResult> {
  if (plan.documentIds.length === 0) return { promoted: 0, skipped: [] };
  if (plan.documentIds.length > plan.limit) {
    throw new Error(
      `applyPromotion: plan holds ${plan.documentIds.length} ids but its own limit is ${plan.limit}`
    );
  }

  const res = await prisma.document.updateMany({
    where: { id: { in: plan.documentIds }, status: 'DISCOVERED' },
    data: { status: 'QUEUED' },
  });

  const skipped =
    res.count === plan.documentIds.length
      ? []
      : (
          await prisma.document.findMany({
            where: { id: { in: plan.documentIds }, status: { not: 'QUEUED' } },
            select: { id: true },
          })
        ).map((d) => d.id);

  return { promoted: res.count, skipped };
}

export interface RequeueErroredOptions {
  /** Maximum documents to requeue. Required, for the same reason as above. */
  limit: number;
  /** Restrict to one case. Omit for all cases. */
  caseId?: string;
}

export interface RequeuePlan {
  measuredAt: Date;
  documentIds: string[];
  limit: number;
  /** `ERROR` rows matching the scope, at measurement time. */
  erroredTotal: number;
}

/**
 * Plan a bounded requeue of `ERROR` documents — the operation the planning
 * documents call `ssRequeueErrored`, which likewise does not exist yet.
 *
 * The cap is the point. An uncapped requeue of a document that always fails is
 * worse than no requeue: each OCR-not-ready failure pauses claims for every
 * worker in the process, so re-driving a permanently-broken document degrades
 * throughput for every other document. `limit` bounds one run; the in-process
 * OCR counter in `parsing-worker.ts` bounds what one run can cost.
 *
 * Read-only. Apply with `applyRequeue`.
 */
export async function planRequeueErrored(
  prisma: PrismaClient,
  opts: RequeueErroredOptions
): Promise<RequeuePlan> {
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new Error(`planRequeueErrored: limit must be a positive integer, got ${opts.limit}`);
  }

  const where = { status: 'ERROR', ...(opts.caseId ? { caseId: opts.caseId } : {}) };
  const measuredAt = new Date();
  const erroredTotal = await prisma.document.count({ where });
  const docs = await prisma.document.findMany({
    where,
    orderBy: { updatedAt: 'asc' },
    take: opts.limit,
    select: { id: true },
  });

  return { measuredAt, documentIds: docs.map((d) => d.id), limit: opts.limit, erroredTotal };
}

/**
 * Apply a requeue plan: `ERROR` → `QUEUED`, clearing `errorMessage` so a stale
 * cause cannot be read as the current one.
 */
export async function applyRequeue(
  prisma: PrismaClient,
  plan: RequeuePlan
): Promise<PromotionResult> {
  if (plan.documentIds.length === 0) return { promoted: 0, skipped: [] };
  if (plan.documentIds.length > plan.limit) {
    throw new Error(
      `applyRequeue: plan holds ${plan.documentIds.length} ids but its own limit is ${plan.limit}`
    );
  }

  const res = await prisma.document.updateMany({
    where: { id: { in: plan.documentIds }, status: 'ERROR' },
    data: { status: 'QUEUED', errorMessage: null },
  });

  const skipped =
    res.count === plan.documentIds.length
      ? []
      : (
          await prisma.document.findMany({
            where: { id: { in: plan.documentIds }, status: { not: 'QUEUED' } },
            select: { id: true },
          })
        ).map((d) => d.id);

  return { promoted: res.count, skipped };
}
