/**
 * Adaptive-RAG complexity router (task: docs/tasks/01-adaptive-rag-router.md).
 *
 * A cheap, deterministic, zero-latency heuristic that picks a retrieval tier for
 * a query so simple lookups don't pay the cost of deep-search decomposition or
 * the RLM agentic loop. It does NOT call an LLM — it's pure string analysis over
 * the query and (optionally) the chip/intent segmentation the search path
 * already computes.
 *
 * IMPORTANT — this only *decides*; it does not act. The caller uses the decision
 * ONLY when the user has opted into "Auto" routing. Manual deep-search / RLM
 * toggles always win when Auto is off, and an explicit API request is never
 * clamped (see docs/tasks/01 and the advisor note about tri-state control).
 *
 * Bias: escalate to a more expensive tier only on STRONG signals; when unsure,
 * fall to the safe middle (`deep`) rather than guessing `single-shot` (under-
 * retrieval hurts answer quality) or `rlm` (wastes latency).
 */

import type { Segment } from './chip-segments';
import type { ResearchTier } from '../mcp/research-types';

export type QueryRoute = 'no-retrieval' | 'single-shot' | 'deep' | 'deep-report' | 'rlm';

/**
 * Map a router decision onto the MCP research tier vocabulary
 * (docs/tasks/06-mcp-two-profiles.md, Part B.2). `auto` is resolved here.
 */
export function routeToResearchMode(route: QueryRoute): ResearchTier {
  switch (route) {
    case 'rlm':         return 'deep-rlm';
    case 'deep-report': return 'deep-report';
    case 'deep':        return 'deep';
    case 'single-shot':
    case 'no-retrieval':
    default:            return 'fast';
  }
}

export interface RouteDecision {
  route: QueryRoute;
  /** Human-readable justification, surfaced in the UI for auditability. */
  reason: string;
  /** 0–1 — how strong the matched signal was. Low confidence ⇒ safe middle. */
  confidence: number;
}

// --- Signal patterns --------------------------------------------------------

/** Asks for a written deliverable (report / memo / summary / brief) → deep with
 *  multi-pass synthesis. Checked BEFORE the RLM regex: "write a memo tracing
 *  how X evolved" is a report request that happens to use narrative words.
 *
 *  Bare `report` / `brief` / `memo` are filing NOUNS in a legal corpus ("the
 *  psychologist's report", "the brief filed in March"), so a noun alone is not
 *  a signal. It fires only when:
 *    (a) a report verb (write / draft / prepare / produce / give me / generate
 *        / summarize / compile) is followed within three words by a
 *        deliverable noun (report / memo / brief / summary / overview /
 *        write-up), or
 *    (b) the intent STARTS with `report|memo|summary|overview` + `on|of|about`
 *        ("summary of every affidavit filed in April"), or
 *    (c) the verb `summarize` appears at all — it is never a filing noun. */
const REPORT_VERB = 'write|draft|prepare|produce|give me|generate|summari[sz]e|compile';
const REPORT_NOUN = 'report|memo(?:randum)?|brief|summary|overview|write[- ]?up';
const REPORT_RE = new RegExp(
  `\\b(?:${REPORT_VERB})\\b(?:\\W+\\w+){0,3}?\\W+(?:${REPORT_NOUN})\\b` +
  `|^\\W*(?:report|memo(?:randum)?|summary|overview)\\s+(?:on|of|about)\\b` +
  `|\\bsummari[sz]e\\b`,
  'i',
);

/** Open-ended synthesis / relationship / evolution → RLM (agentic gap-filling). */
const RLM_RE =
  /\b(trace|connect(?:ion|ions)?|relationship|inter[- ]?related|how (?:did|has|have)|evolv(?:e|ed|ing)|over time|tie(?:s|d)? together|piece together|build (?:a )?(?:timeline|narrative|picture)|tell the story|what happened|walk me through|chronolog)/i;

/** Comparison / breadth / multi-faceted → deep-search decomposition. */
const DEEP_RE =
  /\b(compare|comparison|versus|vs\.?|contrast|differ(?:s|ence|ences)?|contradict|inconsisten(?:t|cies)|across (?:all|every|the|these|multiple)|every|all (?:the )?(?:motions|filings|documents|orders|exhibits|hearings)|both|each of|multiple)/i;

/** Texas-style cause numbers, e.g. 03-25-00333-CV or D-1-FM-21-000111. */
const CAUSE_NUMBER_RE =
  /\b\d{2}-\d{2}-\d{4,5}-[a-z]{1,3}\b|\b[a-z]-\d-[a-z]{2}-\d{2}-\d{5,6}\b/i;

/** A leading question word that signals a focused factual lookup. */
const FACTUAL_Q_RE = /^(?:what|who|whose|when|where|which|is|are|was|were|does|did|do|how many|how much)\b/i;

/**
 * Extract the free-text "intent" (everything outside `{{ }}` chips) and whether
 * any structured chip is present. Works with or without a pre-computed
 * segmentation (falls back to the raw query).
 */
function splitIntent(query: string, segments?: Segment[]): { intent: string; hasChips: boolean } {
  if (segments && segments.length > 0) {
    const hasChips = segments.some((s) => s.kind === 'chip');
    const intent = segments
      .map((s) => (s.kind === 'chip' ? s.nextIntent : s.text))
      .filter(Boolean)
      .join(' ')
      .trim();
    return { intent, hasChips };
  }
  return { intent: query.trim(), hasChips: false };
}

/**
 * Classify a query into a retrieval tier. Pure + synchronous.
 *
 * @param query     The raw user query (may contain `{{ }}` chips).
 * @param segments  Optional output of segmentChipsAndIntents(query) so the
 *                  router sees the same parse the search path uses.
 */
export function classifyQueryComplexity(query: string, segments?: Segment[]): RouteDecision {
  const raw = (query ?? '').trim();
  if (!raw) {
    return { route: 'single-shot', reason: 'empty query', confidence: 0 };
  }

  const { intent, hasChips } = splitIntent(query, segments);
  // Classify the free-text intent. When chips were parsed out, an empty intent
  // means a pure structured lookup — do NOT fall back to the raw `{{ }}` string
  // (its braces/uuid would inflate the word count and misroute to `deep`).
  const text = intent;
  const words = text.split(/\s+/).filter(Boolean);
  const hasQuoted = /"[^"]+"/.test(query);
  const hasExactId = CAUSE_NUMBER_RE.test(query) || hasQuoted;

  // 0. Deliverable language ("write a memo", "summarize", "brief") → deep with
  //    multi-pass synthesis. Wins over RLM: the shape of the answer is the
  //    stronger signal than the narrative verbs inside it.
  if (REPORT_RE.test(text)) {
    return { route: 'deep-report', reason: 'report / memo / summary language ("report", "memo", "summarize", "brief")', confidence: 0.8 };
  }

  // 1. Strongest signal first: open-ended synthesis / relationship → RLM.
  if (RLM_RE.test(text)) {
    return { route: 'rlm', reason: 'synthesis / relationship language ("trace", "how did … evolve", "connect")', confidence: 0.8 };
  }

  // 2. Comparison / breadth / multi-faceted → deep decomposition.
  if (DEEP_RE.test(text)) {
    return { route: 'deep', reason: 'comparative / multi-faceted language ("compare", "across", "every")', confidence: 0.75 };
  }

  // 3. Exact identifier or quoted phrase → single-shot hybrid nails it.
  if (hasExactId) {
    return { route: 'single-shot', reason: 'exact identifier or quoted phrase present', confidence: 0.85 };
  }

  // 4. Pure structured lookup: chips present and essentially no free-text intent.
  //    Still routed to single-shot (not a separate no-retrieval path yet) so we
  //    never return zero results; no-retrieval is a documented future tier.
  if (hasChips && words.length <= 2) {
    return { route: 'single-shot', reason: 'structured filter with minimal free text', confidence: 0.7 };
  }

  // 5. Short, focused factual question → single-shot.
  if (words.length <= 12 && (FACTUAL_Q_RE.test(text) || text.includes('?'))) {
    return { route: 'single-shot', reason: 'short focused factual question', confidence: 0.65 };
  }

  // 6. No strong signal → safe middle (deep). Under-retrieving a hard question
  //    hurts quality more than the extra latency of deep search.
  return { route: 'deep', reason: 'no strong signal — defaulting to deep (safe middle)', confidence: 0.4 };
}
