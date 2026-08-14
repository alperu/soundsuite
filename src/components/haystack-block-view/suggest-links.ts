import { linkVerdicts, type LinkPlan } from './link-rules';
import type { FilingBlock, ScopeGraph } from './scope-graph';

/**
 * Suggest the link a filing is probably missing.
 *
 * Deterministic and explainable on purpose — no embeddings. A suggestion the
 * user cannot argue with is a suggestion they have to verify from scratch, and
 * verifying is the expensive part of this job. Every suggestion here can be
 * read back as a sentence: same case, filed after it, and these words in
 * common.
 *
 * It is also allowed to say nothing. A confident-looking guess between two
 * near-identical candidates costs more than a blank row, because the user has
 * to notice it is wrong before they can fix it.
 */

/** Words that appear in every filing title and so distinguish nothing. */
const STOPWORDS = new Set([
  'motion',
  'to',
  'the',
  'of',
  'for',
  'and',
  'in',
  'on',
  'a',
  'an',
  'order',
  'response',
  'reply',
  'notice',
  'request',
  'court',
  'plaintiff',
  'defendant',
  'petitioner',
  'respondent',
  're',
  'no',
  'case',
  'cause',
  'filed',
  'amended',
  'first',
  'second',
  'third',
]);

/** A suggestion the user has to be able to disagree with. */
export interface LinkSuggestion {
  /** The filing the link would be written on. */
  sourceKey: string;
  slot: string;
  targetKey: string;
  plan: LinkPlan;
  /** Short phrases explaining the pick — rendered as chips, not prose. */
  reasons: string[];
  /** How far ahead of the runner-up this was. Small means "barely". */
  margin: number;
}

/** Title words worth comparing: lowercase, de-punctuated, minus the boilerplate. */
function meaningfulTokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !STOPWORDS.has(word)),
  );
}

function overlap(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const word of a) if (b.has(word)) shared.push(word);
  return shared;
}

/** Days between two ISO dates, or null when either is missing. */
function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return (left - right) / 86_400_000;
}

/**
 * The minimum lead a winner needs over the runner-up before we will name it.
 * Below this the honest answer is a blank row.
 */
const MIN_MARGIN = 0.75;

/**
 * Score one candidate. Higher is better; `null` disqualifies.
 *
 * Only two signals, both domain facts rather than statistics: filings in the
 * same case are the only plausible answers at all, and a filing answers
 * something filed BEFORE it. A missing date is NO SIGNAL — with `filingDate`
 * absent on most of the corpus, treating absence as "close in time" would
 * manufacture confidence out of nothing.
 */
function scoreCandidate(
  source: FilingBlock,
  candidate: FilingBlock,
): { score: number; reasons: string[] } | null {
  if (candidate.caseId !== source.caseId) return null;

  const reasons: string[] = ['same case'];
  let score = 1;

  const gap = daysBetween(source.filingDate, candidate.filingDate);
  if (gap !== null) {
    // A response filed BEFORE the motion it answers is not the answer.
    if (gap < 0) return null;
    // Closer in time is better, but the effect flattens: 3 days and 10 days
    // are both "around the same time"; 3 days and 300 are not.
    score += 1 / (1 + gap / 30);
    reasons.push(gap < 1 ? 'filed same day' : `filed ${Math.round(gap)}d later`);
  }

  const shared = overlap(meaningfulTokens(source.label), meaningfulTokens(candidate.label));
  if (shared.length > 0) {
    score += Math.min(shared.length, 3) * 0.6;
    reasons.push(`shares "${shared.slice(0, 2).join('", "')}"`);
  }

  return { score, reasons };
}

/**
 * The best link for one filing's slot, or nothing.
 *
 * Candidates come from `linkVerdicts`, so a suggestion is never something a
 * drop would refuse — the rules stay the single authority on what is possible,
 * and this only ranks what they already allowed.
 */
export function suggestForSlot(
  graph: ScopeGraph,
  sourceKey: string,
  slot: string,
): LinkSuggestion | null {
  const source = graph.filingById.get(sourceKey.replace(/^filing:/, ''));
  if (!source) return null;

  const scored: Array<{ key: string; plan: LinkPlan; score: number; reasons: string[] }> = [];
  for (const verdict of linkVerdicts(graph, sourceKey, { slot, side: 'output' })) {
    if (!verdict.ok || !verdict.plan) continue;
    const candidate = graph.filingById.get(verdict.key.replace(/^filing:/, ''));
    if (!candidate) continue;
    const scoreResult = scoreCandidate(source, candidate);
    if (!scoreResult) continue;
    scored.push({ key: verdict.key, plan: verdict.plan, ...scoreResult });
  }
  if (scored.length === 0) return null;

  scored.sort((a, z) => z.score - a.score);
  const [best, runnerUp] = scored;
  const margin = best.score - (runnerUp?.score ?? 0);
  // One candidate is its own answer; several need a clear winner.
  if (runnerUp && margin < MIN_MARGIN) return null;

  return {
    sourceKey,
    slot,
    targetKey: best.key,
    plan: best.plan,
    reasons: best.reasons,
    margin: Math.round(margin * 100) / 100,
  };
}
