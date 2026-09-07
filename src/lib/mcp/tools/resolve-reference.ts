/**
 * resolve_reference — human text in, candidate ids out
 * (REPORT-discovery-tools §4.4).
 *
 * A user never says a UUID; they say "the interlocutory appeal". This maps
 * that phrasing onto ranked candidates.
 *
 * TWO BINDING RULES (§4.4, and the reason this tool exists):
 *   1. It NEVER collapses to a single answer. Every candidate carries the
 *      field that matched and a confidence; the caller chooses, or asks.
 *   2. `ambiguous: true` when the top two candidates are within 0.15. That
 *      flag is what tells a well-behaved client to ask instead of proceeding.
 * A discovery tool that silently picks the wrong case reintroduces exactly the
 * false-positive class the SS-3 `caseId is required` fix eliminated.
 *
 * `local` profile safe: deterministic substring/prefix matching over the
 * natural fields. No LLM, no embeddings.
 */

import { BaseMCPTool } from './base-tool';
import {
  ToolMetadata,
  ToolExecutionContext,
  ToolConfigEntry,
} from '../tool-types';

export type ReferenceKind = 'case' | 'motion' | 'person' | 'document';

export const REFERENCE_KINDS: ReferenceKind[] = ['case', 'motion', 'person', 'document'];

/** Top two within this confidence gap ⇒ the answer is not decidable here. */
export const AMBIGUITY_GAP = 0.15;

export interface ResolveReferenceParams {
  text: string;
  kinds?: ReferenceKind[];
  limit?: number;
}

export interface ReferenceCandidate {
  kind: ReferenceKind;
  id: string;
  label: string;
  /** Which field produced the match — 'caseNumber', 'title', 'displayName', … */
  matchedOn: string;
  confidence: number;
  /** Owning case, where the kind has one. */
  caseId?: string;
}

export interface ResolveReferenceResult {
  candidates: ReferenceCandidate[];
  ambiguous: boolean;
}

/** Per-kind candidate pool multiplier — scoring happens in memory over this. */
const POOL_MULTIPLIER = 4;
const POOL_CAP = 50;

export class ResolveReferenceTool extends BaseMCPTool<
  ResolveReferenceParams,
  ResolveReferenceResult
> {
  getMetadata(): ToolMetadata {
    return {
      name: 'resolve_reference',
      displayName: 'Resolve Reference',
      description:
        'Map human text ("the receivership motion", a docket number, a name) to candidate ' +
        'ids. Returns ranked candidates, each with the field that matched and a confidence. ' +
        'Never guesses a single answer: when the top two candidates are within 0.15 the ' +
        'result is flagged ambiguous — ask the user rather than proceeding.',
      version: '1.0.0',
      category: 'search',
      profiles: ['local', 'routed'],
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The human reference to resolve.' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: REFERENCE_KINDS },
            description: 'Entity kinds to search (default: all four).',
          },
          limit: { type: 'number', description: 'Maximum candidates to return (default 5).' },
        },
        required: ['text'],
      },
    };
  }

  async executeImpl(
    params: ResolveReferenceParams,
    context: ToolExecutionContext,
    _config: ToolConfigEntry,
  ): Promise<ResolveReferenceResult> {
    const { text, kinds = REFERENCE_KINDS, limit = 5 } = params ?? ({} as ResolveReferenceParams);
    const raw = String(text).trim();
    const q = raw.toLowerCase();
    const db = context.database as any;
    const wanted = new Set(kinds.filter((k) => REFERENCE_KINDS.includes(k)));
    const pool = Math.min(Math.max(limit, 1) * POOL_MULTIPLIER, POOL_CAP);

    context.logger.info('Handling resolve_reference', {
      kinds: Array.from(wanted),
      limit,
      textLength: raw.length,
    });

    const candidates: ReferenceCandidate[] = [];

    if (wanted.has('case')) {
      const rows = await db.case.findMany({
        where: {
          OR: [
            { caseNumber: { contains: q } },
            { name: { contains: q } },
            { jurisdiction: { contains: q } },
          ],
        },
        select: { id: true, name: true, caseNumber: true, jurisdiction: true },
        orderBy: { createdAt: 'desc' },
        take: pool,
      });
      for (const c of rows ?? []) {
        const scored = bestMatch([
          score(c.caseNumber, q, { exact: 0.95, prefix: 0.8, substring: 0.7 }, 'caseNumber'),
          score(c.name, q, { exact: 0.9, prefix: 0.7, substring: 0.6 }, 'name'),
          score(c.jurisdiction, q, { exact: 0.5, prefix: 0.45, substring: 0.4 }, 'jurisdiction'),
        ]);
        if (scored) {
          candidates.push({ kind: 'case', id: c.id, label: c.name, caseId: c.id, ...scored });
        }
      }
    }

    if (wanted.has('motion')) {
      const rows = await db.motion.findMany({
        where: { title: { contains: q } },
        select: { id: true, title: true, caseId: true },
        orderBy: { createdAt: 'desc' },
        take: pool,
      });
      for (const m of rows ?? []) {
        const scored = bestMatch([
          score(m.title, q, { exact: 0.9, prefix: 0.7, substring: 0.6 }, 'title'),
        ]);
        if (scored) {
          candidates.push({
            kind: 'motion',
            id: m.id,
            label: m.title,
            ...(m.caseId ? { caseId: m.caseId } : {}),
            ...scored,
          });
        }
      }
    }

    if (wanted.has('person')) {
      const rows = await db.person.findMany({
        where: { OR: [{ displayName: { contains: q } }, { barNumber: { contains: q } }] },
        select: { id: true, displayName: true, barNumber: true },
        orderBy: { displayName: 'asc' },
        take: pool,
      });
      for (const p of rows ?? []) {
        const scored = bestMatch([
          score(p.barNumber, q, { exact: 0.95, prefix: 0.7, substring: 0.6 }, 'barNumber'),
          score(p.displayName, q, { exact: 0.9, prefix: 0.7, substring: 0.6 }, 'displayName'),
        ]);
        if (scored) {
          candidates.push({ kind: 'person', id: p.id, label: p.displayName, ...scored });
        }
      }
    }

    if (wanted.has('document')) {
      const rows = await db.document.findMany({
        where: { fileName: { contains: q } },
        select: { id: true, fileName: true, caseId: true },
        orderBy: { createdAt: 'desc' },
        take: pool,
      });
      for (const d of rows ?? []) {
        const scored = bestMatch([
          score(d.fileName, q, { exact: 0.9, prefix: 0.7, substring: 0.6 }, 'fileName'),
        ]);
        if (scored) {
          candidates.push({
            kind: 'document',
            id: d.id,
            label: d.fileName,
            ...(d.caseId ? { caseId: d.caseId } : {}),
            ...scored,
          });
        }
      }
    }

    // One global cross-kind ranking: "top two within 0.15" is kind-agnostic, so
    // a case at 0.95 beside a motion at 0.92 IS ambiguous. Ties break on kind
    // then id so the output is stable across runs.
    candidates.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
    );

    // Computed BEFORE slicing: a `limit: 1` request must still learn that the
    // answer was not decidable, otherwise the flag can be truncated away.
    const ambiguous =
      candidates.length >= 2 && candidates[0].confidence - candidates[1].confidence <= AMBIGUITY_GAP;

    const trimmed = candidates.slice(0, Math.max(limit, 1));
    context.logger.info('resolve_reference completed', {
      candidateCount: trimmed.length,
      ambiguous,
    });
    // Zero matches is an empty list, never an error.
    return { candidates: trimmed, ambiguous };
  }
}

/**
 * Pick the STRONGEST field match on a row, not the first one.
 *
 * Field order is priority, but priority is only the tie-break: a caseNumber
 * substring (0.7) must not suppress an exact name match (0.9) on the same row.
 * This tool's whole job is to rank by confidence, so taking the first matching
 * field would be the tool reporting a confidence it does not believe.
 *
 * `matchedOn` names whichever field actually won.
 */
function bestMatch(
  scored: Array<{ matchedOn: string; confidence: number } | undefined>,
): { matchedOn: string; confidence: number } | undefined {
  let best: { matchedOn: string; confidence: number } | undefined;
  for (const s of scored) {
    // Strictly greater: on a tie the earlier (higher-priority) field keeps it.
    if (s && (best === undefined || s.confidence > best.confidence)) best = s;
  }
  return best;
}

/**
 * Deterministic field scoring: exact > prefix > substring, nothing else.
 * Returns `undefined` when the field does not match at all; `bestMatch`
 * reduces a row's per-field scores to the strongest of them.
 */
function score(
  value: string | null | undefined,
  q: string,
  weights: { exact: number; prefix: number; substring: number },
  matchedOn: string,
): { matchedOn: string; confidence: number } | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (!v || !q) return undefined;
  if (v === q) return { matchedOn, confidence: weights.exact };
  if (v.startsWith(q)) return { matchedOn, confidence: weights.prefix };
  if (v.includes(q)) return { matchedOn, confidence: weights.substring };
  return undefined;
}
