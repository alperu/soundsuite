/**
 * Zero-LLM query decomposition (report M-1).
 *
 * The local evidence engine runs `decomposeQuery` under a hard timeout; when
 * the model is wedged, cold, or queued behind other Ollama work, the pipeline
 * falls back to this deterministic splitter instead of blocking. It mirrors
 * the boolean/chip branch `decomposeQuery` already takes for `{{ … }}` queries
 * and otherwise produces 2–4 keyword variants of the question.
 */

import { parseBooleanQuery, astSerialize } from './boolean-query';

export interface HeuristicDecomposition {
  subQueries: string[];
  intent: string;
}

/** Words per sub-query cap — keeps variants retrieval-sized. */
const MAX_WORDS = 20;
const MAX_SUB_QUERIES = 4;

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from',
  'about', 'regarding', 'concerning', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'has', 'have', 'had', 'that', 'this', 'these', 'those', 'it', 'its',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'did', 'any', 'all',
  'there', 'their', 'they', 'them', 'he', 'she', 'his', 'her', 'we', 'our', 'you', 'your', 'i',
  'please', 'tell', 'me', 'find', 'show', 'list', 'explain', 'describe', 'summarize', 'summarise',
]);

/** Leading question framing that carries no retrieval signal. */
const QUESTION_LEAD = /^(?:(?:what|which|who|whom|whose|when|where|why|how)\s+(?:is|are|was|were|did|do|does|has|have|had|can|could|would|should|will)?\s*|(?:did|do|does|has|have|had|is|are|was|were|can|could|would|should|will)\s+)/i;

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function capWords(s: string): string {
  const words = normalize(s).split(' ');
  return words.length > MAX_WORDS ? words.slice(0, MAX_WORDS).join(' ') : words.join(' ');
}

function stripStopwords(s: string): string {
  return normalize(s)
    .split(' ')
    .filter((w) => w.length > 0 && !STOPWORDS.has(w.toLowerCase().replace(/[^a-z0-9']/g, '')))
    .join(' ');
}

/** Split on commas / semicolons / conjunctions / question words into phrase chunks. */
function phraseChunks(s: string): string[] {
  const stripped = normalize(s).replace(/[?!.]+$/g, '');
  return stripped
    .split(/\s*(?:[,;]|\band\b|\bor\b|\bversus\b|\bvs\.?\b|\bwhat\b|\bwhich\b|\bwho\b|\bwhen\b|\bwhere\b|\bwhy\b|\bhow\b)\s*/i)
    .map((c) => normalize(c))
    .filter((c) => c.length > 0);
}

function pushUnique(out: string[], seen: Set<string>, candidate: string): void {
  const capped = capWords(candidate);
  const key = capped.toLowerCase();
  if (!capped || seen.has(key)) return;
  // A one-word variant is rarely a useful retrieval query unless it is the whole query.
  if (out.length > 0 && capped.split(' ').length < 2) return;
  seen.add(key);
  out.push(capped);
}

/**
 * Deterministic decomposition. Boolean branches win when the query uses
 * `{{ … }}` chip syntax with operators; otherwise 2–4 keyword variants:
 * the query as written, the query minus stopwords, then noun-phrase chunks
 * split on commas / "and" / "or" / question words. De-duplicated,
 * ≤ 20 words each.
 */
export function heuristicDecompose(query: string): HeuristicDecomposition {
  const q = normalize(query);
  if (!q) return { subQueries: [query], intent: query };

  if (/\{\{[\s\S]*?\}\}/.test(q)) {
    const parsed = parseBooleanQuery(q);
    if (parsed.ok && parsed.hasOperators) {
      const branches = parsed.ast.op === 'OR' ? parsed.ast.children : [parsed.ast];
      const subQueries = branches.map(astSerialize).map(normalize).filter((s) => s.length > 0);
      if (subQueries.length > 0) return { subQueries, intent: q };
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();

  pushUnique(out, seen, q);

  const withoutLead = normalize(q.replace(QUESTION_LEAD, '').replace(/[?!.]+$/g, ''));
  const keywords = stripStopwords(withoutLead);
  if (keywords.split(' ').length >= 2) pushUnique(out, seen, keywords);

  for (const chunk of phraseChunks(withoutLead)) {
    if (out.length >= MAX_SUB_QUERIES) break;
    const chunkKeywords = stripStopwords(chunk);
    pushUnique(out, seen, chunkKeywords.split(' ').length >= 2 ? chunkKeywords : chunk);
  }

  return { subQueries: out.slice(0, MAX_SUB_QUERIES), intent: q };
}
