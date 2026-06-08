/**
 * Graph-aware traversal over the existing curated legal graph
 * (docs/tasks/02-graph-aware-retrieval-haystack.md).
 *
 * ADDITIVE by design: this module does NOT touch boolean-to-fts.ts (whose
 * prisma-traverse resolvers compute *filters*). Here we traverse the same
 * authoritative FK graph to *expand* — to answer "what is structurally related
 * to X" — using only confirmed `Motion` columns (amendment chain + denormalized
 * Person role refs + caseId). No LLM entity extraction: every edge is FK-true
 * (contrast with Microsoft GraphRAG — see the task doc).
 *
 * Scope is always boundable: every function caps fan-out so a prolific judge or
 * a deep amendment chain can't explode the result set.
 */

import { prisma } from '../db/prisma';

export type MotionRole = 'judge' | 'movant' | 'respondent';

export interface MotionNode {
  id: string;
  title: string;
  caseId: string | null;
  filingId: string;
  revisionSeq: number | null;
  /** Why this motion is in the result — the edge that reached it. */
  relation: string;
}

/** Default fan-out / depth caps. Keep small — rerank/RLM prune downstream. */
const MAX_NODES = 50;
const MAX_HOPS = 4;

const MOTION_SELECT = {
  id: true,
  title: true,
  caseId: true,
  filingId: true,
  revisionSeq: true,
  parentMotionId: true,
  amendsId: true,
  supersedesId: true,
  judgeId: true,
  movantId: true,
  respondentId: true,
} as const;

type RawMotion = {
  id: string; title: string; caseId: string | null; filingId: string;
  revisionSeq: number | null; parentMotionId: string | null;
  amendsId: string | null; supersedesId: string | null;
  judgeId: string | null; movantId: string | null; respondentId: string | null;
};

function inScope(caseId: string | null, caseScope?: string[]): boolean {
  if (!caseScope || caseScope.length === 0) return true;
  return caseId != null && caseScope.includes(caseId);
}

function toNode(m: RawMotion, relation: string): MotionNode {
  return { id: m.id, title: m.title, caseId: m.caseId, filingId: m.filingId, revisionSeq: m.revisionSeq, relation };
}

/**
 * Walk a motion's amendment lineage: ancestors (parentMotionId / amendsId /
 * supersedesId, upward) and descendants (childMotions, motions that amend or
 * supersede a node — downward). Bounded BFS over all three edge types.
 *
 * Returns lineage members (excluding the seed), ordered by revisionSeq when
 * present. Respects caseScope (the user's `{{ }}` chip filter set) if given.
 */
export async function amendmentLineage(
  motionId: string,
  opts: { caseScope?: string[]; maxNodes?: number; maxHops?: number } = {},
): Promise<MotionNode[]> {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const maxHops = opts.maxHops ?? MAX_HOPS;

  const seed = await prisma.motion.findUnique({ where: { id: motionId }, select: MOTION_SELECT });
  if (!seed) return [];

  const seen = new Set<string>([seed.id]);
  const out = new Map<string, MotionNode>();
  let frontier: RawMotion[] = [seed as RawMotion];

  for (let hop = 0; hop < maxHops && frontier.length > 0 && out.size < maxNodes; hop++) {
    // Candidate ids one hop out: parents + amends/supersedes pointers.
    const ptrIds = new Set<string>();
    for (const m of frontier) {
      for (const id of [m.parentMotionId, m.amendsId, m.supersedesId]) {
        if (id && !seen.has(id)) ptrIds.add(id);
      }
    }
    const frontierIds = frontier.map((m) => m.id);

    const [ancestors, descendants] = await Promise.all([
      ptrIds.size > 0
        ? prisma.motion.findMany({ where: { id: { in: [...ptrIds] } }, select: MOTION_SELECT })
        : Promise.resolve([] as RawMotion[]),
      // Downward: motions that point AT the frontier via parent/amends/supersedes.
      prisma.motion.findMany({
        where: {
          OR: [
            { parentMotionId: { in: frontierIds } },
            { amendsId: { in: frontierIds } },
            { supersedesId: { in: frontierIds } },
          ],
        },
        select: MOTION_SELECT,
        take: maxNodes,
      }),
    ]);

    const next: RawMotion[] = [];
    for (const [m, relation] of [
      ...ancestors.map((m) => [m, 'amends/parent of seed'] as const),
      ...descendants.map((m) => [m, 'amended/superseded the seed'] as const),
    ]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (inScope(m.caseId, opts.caseScope)) {
        out.set(m.id, toNode(m, relation));
        if (out.size >= maxNodes) break;
      }
      next.push(m);
    }
    frontier = next;
  }

  return [...out.values()].sort((a, b) => (a.revisionSeq ?? 0) - (b.revisionSeq ?? 0));
}

/**
 * Motions in which a person appears in a given role (or any role). Optionally
 * scoped to a set of cases. This is the "all filings where person P appeared"
 * structural query.
 */
export async function motionsByPerson(
  personId: string,
  opts: { role?: MotionRole; caseScope?: string[]; maxNodes?: number } = {},
): Promise<MotionNode[]> {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const roleClauses =
    opts.role === 'judge' ? [{ judgeId: personId }]
      : opts.role === 'movant' ? [{ movantId: personId }]
        : opts.role === 'respondent' ? [{ respondentId: personId }]
          : [{ judgeId: personId }, { movantId: personId }, { respondentId: personId }];

  const where: Record<string, unknown> = { OR: roleClauses };
  if (opts.caseScope && opts.caseScope.length > 0) where.caseId = { in: opts.caseScope };

  const rows = await prisma.motion.findMany({ where, select: MOTION_SELECT, take: maxNodes });
  return rows.map((m) => {
    const role = m.judgeId === personId ? 'judge' : m.movantId === personId ? 'movant' : m.respondentId === personId ? 'respondent' : 'party';
    return toNode(m as RawMotion, `person is ${role}`);
  });
}

/**
 * Motions structurally related to a seed motion: same case AND sharing the
 * seed's judge or movant (the "documents sharing this judge" question). Excludes
 * the seed. Bounded.
 */
export async function relatedMotions(
  motionId: string,
  opts: { caseScope?: string[]; maxNodes?: number } = {},
): Promise<MotionNode[]> {
  const maxNodes = opts.maxNodes ?? MAX_NODES;
  const seed = await prisma.motion.findUnique({ where: { id: motionId }, select: MOTION_SELECT });
  if (!seed || !seed.caseId) return [];
  if (!inScope(seed.caseId, opts.caseScope)) return [];

  const shared: Array<Record<string, unknown>> = [];
  if (seed.judgeId) shared.push({ judgeId: seed.judgeId });
  if (seed.movantId) shared.push({ movantId: seed.movantId });
  if (shared.length === 0) return [];

  const rows = await prisma.motion.findMany({
    where: { caseId: seed.caseId, id: { not: seed.id }, OR: shared },
    select: MOTION_SELECT,
    take: maxNodes,
  });
  return rows.map((m) => {
    const why = seed.judgeId && m.judgeId === seed.judgeId ? 'shares judge' : 'shares movant';
    return toNode(m as RawMotion, `same case, ${why}`);
  });
}
