/**
 * Evidence outline (docs/tasks/06-mcp-two-profiles.md, work item 3).
 *
 * The `local` profile's replacement for the multi-pass report outline: one
 * JSON-only LLM call that groups the gathered evidence into topical sections
 * and names the gaps — and writes NO prose. Sections reference evidence by
 * `EvidenceItem.id`; the model sees short `[E1]…[En]` labels and we map them
 * back, dropping anything it invented.
 *
 * Never throws: any failure (provider, parse, policy) yields an empty outline
 * with a single 'outline unavailable' gap so the evidence result still lands.
 */

import { callLLMJson } from '../mcp/tools/ai-helper';
import type { ToolExecutionContext } from '../mcp/tool-types';
import type { EvidenceItem, EvidenceResult, McpProfile, EffortLevel } from '../mcp/research-types';
import { truncateBlock } from './context-builder';

export type EvidenceOutline = NonNullable<EvidenceResult['outline']>;

export interface EvidenceOutlineOptions {
  provider: string;
  model: string;
  thinking?: boolean;
  effort?: EffortLevel;
  signal?: AbortSignal;
  /** Policy profile stamped on the call so `callLLM` refuses non-Ollama under `local`. */
  profile?: McpProfile;
  /** Total prompt budget for the evidence block. Default 60 000 chars. */
  maxContextChars?: number;
  /** Per-item cap. Default 1 200 chars. */
  perItemChars?: number;
}

export const OUTLINE_UNAVAILABLE: EvidenceOutline = { sections: [], gaps: ['outline unavailable'] };

const EVIDENCE_OUTLINE_SYSTEM_PROMPT = `You are a legal research planner organising evidence for someone else to write up.

You are given a research question, the sub-questions that were searched, and a numbered list of evidence excerpts labelled [E1], [E2], … Group the excerpts into 2-7 topical sections and name what is missing.

Respond with JSON shaped exactly as:
{
  "sections": [
    { "title": "Short topical heading", "evidenceIds": ["E3", "E7"], "gap": "optional: what this section still lacks" }
  ],
  "gaps": ["aspect of the question no excerpt addresses", "..."]
}

Rules:
- Do NOT write findings, summaries, analysis, or any prose beyond titles and one-line gap notes.
- Every evidenceIds entry must be one of the [E#] labels given. Never invent labels.
- Organise by topic, not by sub-question. An excerpt may appear in more than one section.
- Omit excerpts that are irrelevant to the question.
- List a gap only when the excerpts genuinely do not cover it.`;

interface RawOutline {
  sections?: Array<{ title?: unknown; evidenceIds?: unknown; gap?: unknown }>;
  gaps?: unknown;
}

/** Parse an `[E7]` / `E7` / `7` label into its 1-based index, or null. */
function labelIndex(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v !== 'string') return null;
  const m = /^\[?\s*E?\s*(\d+)\s*\]?$/i.exec(v.trim());
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Validate a raw model response against the evidence list: unknown labels
 * are dropped, sections with no surviving ids are dropped, duplicates are
 * collapsed, and gap strings are trimmed. Exported for tests.
 */
export function normaliseOutline(raw: unknown, evidence: EvidenceItem[]): EvidenceOutline {
  if (!raw || typeof raw !== 'object') return OUTLINE_UNAVAILABLE;
  const r = raw as RawOutline;
  if (!Array.isArray(r.sections)) return OUTLINE_UNAVAILABLE;

  const sections: EvidenceOutline['sections'] = [];
  for (const s of r.sections) {
    if (!s || typeof s !== 'object') continue;
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) continue;
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const ref of Array.isArray(s.evidenceIds) ? s.evidenceIds : []) {
      const idx = labelIndex(ref);
      let id: string | undefined;
      if (idx !== null && idx >= 1 && idx <= evidence.length) id = evidence[idx - 1].id;
      else if (typeof ref === 'string' && evidence.some((e) => e.id === ref)) id = ref;
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    if (ids.length === 0) continue;
    const gap = typeof s.gap === 'string' && s.gap.trim() ? s.gap.trim() : undefined;
    sections.push({ title, evidenceIds: ids, ...(gap ? { gap } : {}) });
  }

  const gaps = (Array.isArray(r.gaps) ? r.gaps : [])
    .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    .map((g) => g.trim());

  return { sections, gaps };
}

/** Build the `[E#]` labelled evidence block within the char budget. */
export function buildOutlineContext(
  evidence: EvidenceItem[],
  opts: { maxTotalChars: number; perItemChars: number },
): { block: string; used: number } {
  const parts: string[] = [];
  let total = 0;
  let used = 0;
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    const body = truncateBlock(e.tableMarkdown || e.text, opts.perItemChars).text;
    const meta: string[] = [];
    if (e.headingPath) meta.push(e.headingPath);
    if (e.speakers) meta.push(`speakers: ${e.speakers.split('|').filter(Boolean).join(', ')}`);
    if (e.blockType && e.blockType !== 'paragraph') meta.push(e.blockType);
    const part = `[E${i + 1}]${meta.length ? ` (${meta.join(' · ')})` : ''}\n${body}`;
    const cost = part.length + (parts.length > 0 ? 5 : 0);
    if (total + cost > opts.maxTotalChars) continue; // skip-not-break, like buildCiteContext
    parts.push(part);
    total += cost;
    used++;
  }
  return { block: parts.join('\n---\n'), used };
}

export async function buildEvidenceOutline(
  query: string,
  subQueries: string[],
  evidence: EvidenceItem[],
  options: EvidenceOutlineOptions,
): Promise<EvidenceOutline> {
  if (evidence.length === 0) return { sections: [], gaps: ['no evidence retrieved'] };

  const { block, used } = buildOutlineContext(evidence, {
    maxTotalChars: options.maxContextChars ?? 60_000,
    perItemChars: options.perItemChars ?? 1_200,
  });
  if (used === 0) return OUTLINE_UNAVAILABLE;

  const userContent = `## Research Question
${query}

## Sub-Questions Searched
${subQueries.map((sq, i) => `${i + 1}. ${sq}`).join('\n')}

## Evidence (${used} of ${evidence.length} excerpts shown)

${block}

---

Group the excerpts above into sections and list the gaps. JSON only — no prose.`;

  // The context object only carries the policy profile; `callLLM` reads
  // nothing else from it and refuses non-Ollama providers when it is 'local'.
  const context = options.profile
    ? ({ profile: options.profile } as unknown as ToolExecutionContext)
    : undefined;

  try {
    const raw = await callLLMJson<unknown>(EVIDENCE_OUTLINE_SYSTEM_PROMPT, userContent, {
      maxTokens: 2048,
      temperature: 0.1,
      provider: options.provider,
      model: options.model,
      thinking: options.thinking,
      effort: options.effort,
      signal: options.signal,
      context,
      jsonSchema: {
        type: 'object',
        properties: {
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                evidenceIds: { type: 'array', items: { type: 'string' } },
                gap: { type: 'string' },
              },
              required: ['title', 'evidenceIds'],
            },
            minItems: 1,
            maxItems: 7,
          },
          gaps: { type: 'array', items: { type: 'string' } },
        },
        required: ['sections', 'gaps'],
      },
    });
    return normaliseOutline(raw, evidence);
  } catch (err) {
    // A user abort must still propagate; everything else degrades to "no outline".
    if ((err as Error)?.name === 'AbortError' || options.signal?.aborted) throw err;
    console.warn('[evidence-outline] outline call failed — returning empty outline', {
      provider: options.provider,
      model: options.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return OUTLINE_UNAVAILABLE;
  }
}
