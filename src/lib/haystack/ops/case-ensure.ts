/**
 * `ssCaseEnsure` — find-or-create a Case, which IS folder registration
 * (plan §3.3, §5.3): the watcher is built from Case.path rows.
 *
 * The create goes through `commitEntity` with `kind: 'case'`, the same call
 * the case-management plus button makes, so the case appears in that list
 * immediately and the path validation (must be a real directory) is the
 * existing one.
 */
import path from 'path';
import { commitEntity } from '@/lib/haystack/commit';
import { bareId, provenanceTag, OpError, type OpContext, type OpResult } from './types';
import { assertDirectory } from './fs-walk';

export interface CaseEnsureParams {
  path: string;
  name?: string;
  caseNumber?: string;
  jurisdiction?: string;
  county?: string;
  state?: string;
  dryRun?: boolean;
}

export async function ssCaseEnsure(ctx: OpContext, params: CaseEnsureParams): Promise<OpResult> {
  const dryRun = params.dryRun !== false;
  let folder: string;
  try {
    folder = await assertDirectory(bareId(params.path, 'path'));
  } catch (err) {
    throw new OpError('INVALID_PARAMS', (err as Error).message);
  }
  const caseNumber = typeof params.caseNumber === 'string' && params.caseNumber.trim() ? params.caseNumber.trim() : null;
  const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : path.basename(folder);

  const select = { id: true, name: true, path: true, caseNumber: true, jurisdiction: true, county: true, state: true };

  const byPath = await ctx.prisma.case.findUnique({ where: { path: folder }, select });
  if (byPath) {
    return { meta: { action: 'found', matchedOn: 'path', dryRun }, rows: [byPath] };
  }

  if (caseNumber) {
    const byNumber = await ctx.prisma.case.findFirst({ where: { caseNumber }, select });
    if (byNumber) {
      // Same docket, different folder: not ours to resolve. Report it.
      return {
        meta: {
          action: 'conflict',
          matchedOn: 'caseNumber',
          dryRun,
          reason: `caseNumber ${caseNumber} is already bound to a different path; nothing written`,
          requestedPath: folder,
        },
        rows: [byNumber],
      };
    }
  }

  const patch: Record<string, unknown> = {
    name,
    path: folder,
    ...(caseNumber ? { caseNumber } : {}),
    ...(params.jurisdiction ? { jurisdiction: String(params.jurisdiction) } : {}),
    ...(params.county ? { county: String(params.county) } : {}),
    ...(params.state ? { state: String(params.state) } : {}),
    ...provenanceTag(ctx.actor, 'ssCaseEnsure'),
  };

  if (dryRun) {
    return {
      meta: { action: 'would-create', dryRun, note: 'Pass dryRun=false to create; the watcher starts discovering PDFs under the path immediately.' },
      rows: [{ id: null, ...patch }],
    };
  }

  const result = await commitEntity({ id: null, kind: 'case', patch });
  if (!result.ok) {
    const parsed = JSON.parse(result.errGridJson) as { meta?: { dis?: string } };
    throw new OpError('EXECUTION_ERROR', parsed?.meta?.dis ?? 'case create failed');
  }
  const row = result.row as Record<string, unknown>;
  return {
    meta: { action: 'created', dryRun: false },
    rows: [{ id: row.id, name: row.name, path: row.path, caseNumber: row.caseNumber ?? null, jurisdiction: row.jurisdiction ?? null, county: row.county ?? null, state: row.state ?? null }],
  };
}
