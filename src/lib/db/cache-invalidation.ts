/**
 * Prisma client extension that automatically invalidates the Redis filings
 * cache whenever a Document, Filing, or Case is written. This removes the
 * burden of remembering to call FilingsCacheService.invalidate* from every
 * route, service, and worker that mutates these models.
 *
 * The hook fires AFTER the write completes and is fire-and-forget — if Redis
 * is down the FilingsCacheService no-ops gracefully.
 *
 * For updateMany/deleteMany the result is just a row count, so we pre-query
 * to collect the affected caseIds before running the mutation.
 */
import type { PrismaClient } from '@prisma/client';

type Op =
  | 'create'
  | 'createMany'
  | 'update'
  | 'updateMany'
  | 'upsert'
  | 'delete'
  | 'deleteMany';

const WRITE_OPS: Op[] = [
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

type Model = 'document' | 'filing' | 'case';

async function collectCaseIds(
  client: PrismaClient,
  model: Model,
  operation: string,
  args: unknown
): Promise<string[]> {
  const a = args as { data?: any; where?: any; create?: any; update?: any };

  if (operation === 'create') {
    const cid = model === 'case' ? a.data?.id : a.data?.caseId;
    return cid ? [cid] : [];
  }

  if (operation === 'createMany') {
    const rows: any[] = Array.isArray(a.data) ? a.data : [a.data];
    return rows
      .map(r => (model === 'case' ? r?.id : r?.caseId))
      .filter((x): x is string => typeof x === 'string');
  }

  if (operation === 'upsert') {
    const cid =
      model === 'case'
        ? a.create?.id ?? a.where?.id
        : a.create?.caseId ?? a.update?.caseId;
    if (cid) return [cid];
    // fall through to where-based lookup
  }

  if (
    operation === 'update' ||
    operation === 'delete' ||
    operation === 'upsert'
  ) {
    if (model === 'case') {
      const id = a.where?.id;
      return id ? [id] : [];
    }
    // Document / Filing: prefer caseId on the row, fetch if absent
    const dataCaseId = a.data?.caseId ?? a.update?.caseId;
    if (typeof dataCaseId === 'string') return [dataCaseId];
    try {
      const found = await (client as any)[model].findUnique({
        where: a.where,
        select: { caseId: true },
      });
      return found?.caseId ? [found.caseId] : [];
    } catch {
      return [];
    }
  }

  if (operation === 'updateMany' || operation === 'deleteMany') {
    try {
      const rows = await (client as any)[model].findMany({
        where: a.where,
        select: model === 'case' ? { id: true } : { caseId: true },
      });
      return (rows as any[])
        .map(r => (model === 'case' ? r.id : r.caseId))
        .filter((x): x is string => typeof x === 'string');
    } catch {
      return [];
    }
  }

  return [];
}

function invalidate(caseIds: string[]) {
  if (caseIds.length === 0) return;
  // Lazy import to avoid pulling Redis into the cold start path / circular deps.
  import('@/services/filings-cache')
    .then(({ FilingsCacheService }) => {
      const cache = new FilingsCacheService();
      const unique = Array.from(new Set(caseIds));
      for (const cid of unique) {
        cache.invalidateCase(cid).catch(() => {});
      }
    })
    .catch(() => {});
}

export function withCacheInvalidation(client: PrismaClient): PrismaClient {
  const makeHandler = (model: Model) =>
    async ({
      operation,
      args,
      query,
    }: {
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }) => {
      if (!WRITE_OPS.includes(operation as Op)) return query(args);

      const caseIds = await collectCaseIds(client, model, operation, args);
      const result = await query(args);
      invalidate(caseIds);
      return result;
    };

  return client.$extends({
    query: {
      document: { $allOperations: makeHandler('document') },
      filing: { $allOperations: makeHandler('filing') },
      case: { $allOperations: makeHandler('case') },
    },
  }) as unknown as PrismaClient;
}
