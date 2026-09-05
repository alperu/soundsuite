/**
 * Evidence outline (docs/tasks/06-mcp-two-profiles.md, work item 3).
 *
 * The `local` profile's replacement for the multi-pass report outline: one
 * JSON-only LLM call that groups the gathered evidence into topical sections
 * and names the gaps — and writes NO prose. Sections reference evidence by
 * `EvidenceItem.id`; the model sees short `[E1]…[En]` labels and we map them
 * back, dropping anything it invented.
 *
 * Never throws except on a caller abort: any failure (provider, parse, policy,
 * or our own `timeoutMs` ceiling) yields `null` plus a one-line reason on
 * `options.onWarn`. `null` means "no outline" — the caller must NOT substitute
 * a per-document re-keying of the input, which costs a minute and says nothing
 * (report v4, N-3).
 */

import { callLLMJson } from '../mcp/tools/ai-helper';
import type { ToolExecutionContext } from '../mcp/tool-types';
import type { EvidenceItem, EvidenceResult, McpProfile, EffortLevel } from '../mcp/research-types';
import { truncateBlock } from './context-builder';
import { LOCAL_PROVIDER } from '../mcp/llm-policy';

export type EvidenceOutline = NonNullable<EvidenceResult['outline']>;

export interface EvidenceOutlineOptions {
  /** Defaults to the local provider — the outline is a local-profile step. */
  provider?: string;
  /** Resolve from `LOCAL_ROUTING.outline.model` via `localOutlineModel()`. */
  model?: string;
  thinking?: boolean;
  effort?: EffortLevel;
  signal?: AbortSignal;
  /** Policy profile stamped on the call so `callLLM` refuses non-Ollama under `local`. */
  profile?: McpProfile;
  /** Total prompt budget for the evidence block. Default 60 000 chars. */
  maxContextChars?: number;
  /**
   * Hard ceiling on the whole call (ms). Enforced here so the outline can
   * never burn the caller's much larger phase budget. Default 25 000.
   */
  timeoutMs?: number;
  /** Highest-scoring N items the model is shown. Default 40. */
  maxItems?: number;
  /** Per-item char cap. Default 400. */
  maxCharsPerItem?: number;
  /** Deprecated alias for `maxCharsPerItem`. */
  perItemChars?: number;
  /** Reason sink for the event stream when the outline yields null. */
  onWarn?: (reason: string, detail?: Record<string, unknown>) => void;
}

export const OUTLINE_DEFAULTS = {
  provider: LOCAL_PROVIDER,
  /** Hard ceiling — a caller-supplied `timeoutMs` may lower it, never raise it. */
  timeoutMs: 25_000,
  maxItems: 40,
  maxCharsPerItem: 400,
  maxContextChars: 60_000,
} as const;

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
- List a gap only when the excerpts genuinely do not cover it.
- Excerpts marked "DRAFT, filing not confirmed" are unfiled working copies: never describe them as filed, ruled on, or part of the record; a section title that relies on one must say "draft".
- Never describe an unmarked excerpt as filed either — filing status is confirmed only where an excerpt says so.`;

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
 *
 * Returns `null` when nothing usable survives — sections AND gaps both empty.
 * Sections without gaps is a valid outline; gaps without sections is the most
 * valuable answer of all ("no filing addresses X"), so neither is nulled.
 */
export function normaliseOutline(raw: unknown, evidence: EvidenceItem[]): EvidenceOutline | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawOutline;
  if (!Array.isArray(r.sections) && !Array.isArray(r.gaps)) return null;

  const sections: EvidenceOutline['sections'] = [];
  for (const s of Array.isArray(r.sections) ? r.sections : []) {
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

  if (sections.length === 0 && gaps.length === 0) return null;
  return { sections, gaps };
}

/**
 * The slice of evidence the model actually sees: the `maxItems`
 * highest-scoring items, kept in their original (already-ranked) order so the
 * `[E#]` labels stay stable. Showing all 150 items is what made the outline
 * unaffordable — v4 N-3. Exported for tests.
 */
export function selectOutlineItems(evidence: EvidenceItem[], maxItems: number): EvidenceItem[] {
  if (maxItems <= 0 || evidence.length <= maxItems) return evidence.slice();
  const score = (e: EvidenceItem) => e.rerankScore ?? e.score ?? 0;
  const keep = new Set(
    evidence
      .map((e, i) => ({ i, s: score(e) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, maxItems)
      .map((x) => x.i),
  );
  return evidence.filter((_, i) => keep.has(i));
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
    if (e.recordStatus === 'draft') meta.push('DRAFT, filing not confirmed');
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
  evidence: EvidenceItem[],
  query: string,
  subQueries: string[],
  options: EvidenceOutlineOptions,
): Promise<EvidenceOutline | null> {
  const provider = options.provider ?? OUTLINE_DEFAULTS.provider;
  // No model default here: the tag belongs to `LOCAL_ROUTING.outline.model`,
  // resolved against the host by `localOutlineModel()`. Empty means "let the
  // provider pick", which is what the pre-v4 code did.
  const model = options.model;
  const warn = (reason: string, detail?: Record<string, unknown>) => {
    options.onWarn?.(reason, detail);
    console.warn(`[evidence-outline] ${reason}`, { provider, model, ...detail });
  };

  if (evidence.length === 0) return { sections: [], gaps: ['no evidence retrieved'] };

  const items = selectOutlineItems(evidence, options.maxItems ?? OUTLINE_DEFAULTS.maxItems);
  const { block, used } = buildOutlineContext(items, {
    maxTotalChars: options.maxContextChars ?? OUTLINE_DEFAULTS.maxContextChars,
    perItemChars: options.maxCharsPerItem ?? options.perItemChars ?? OUTLINE_DEFAULTS.maxCharsPerItem,
  });
  if (used === 0) {
    warn('no evidence fit the outline context budget');
    return null;
  }

  const userContent = `## Research Question
${query}

## Sub-Questions Searched
${subQueries.map((sq, i) => `${i + 1}. ${sq}`).join('\n')}

## Evidence (${used} of ${evidence.length} excerpts shown, highest-scoring first)

${block}

---

Group the excerpts above into sections and list the gaps. JSON only — no prose.`;

  // The context object only carries the policy profile; `callLLM` reads
  // nothing else from it and refuses non-Ollama providers when it is 'local'.
  const context = options.profile
    ? ({ profile: options.profile } as unknown as ToolExecutionContext)
    : undefined;

  // Own ceiling: a 25 s null is honest, a 60 s fake outline is worse than
  // nothing. Fires before any caller-level phase timeout, so the caller's
  // fallback path is never reached.
  // Clamp, don't just default: a caller that hands us its own (much larger)
  // phase budget must not be able to raise this ceiling, or the outline is
  // back to burning a minute before anyone hears about it (v4 N-3).
  const timeoutMs = Math.min(options.timeoutMs ?? OUTLINE_DEFAULTS.timeoutMs, OUTLINE_DEFAULTS.timeoutMs);
  const ceiling = new AbortController();
  const timer = setTimeout(() => ceiling.abort(), timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, ceiling.signal])
    : ceiling.signal;
  const startedAt = Date.now();

  try {
    const raw = await callLLMJson<unknown>(EVIDENCE_OUTLINE_SYSTEM_PROMPT, userContent, {
      maxTokens: 2048,
      temperature: 0.1,
      // Dashboard path: normaliseOutline() already degrades {_markdown} to null
      // with a warning. Throwing instead would put a raw model snippet into
      // the persisted event-stream warning (CLAUDE.md § Privacy).
      allowMarkdownFallback: true,
      provider,
      model,
      thinking: options.thinking,
      effort: options.effort,
      signal,
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
    const outline = normaliseOutline(raw, items);
    if (!outline) {
      warn(`outline unusable — model returned no sections and no gaps (${model ?? 'auto'})`, {
        model,
        itemsShown: used,
        ms: Date.now() - startedAt,
      });
      return null;
    }
    return outline;
  } catch (err) {
    // Only a caller abort propagates. Our own ceiling — and every provider or
    // parse failure — degrades to null with a reason for the event stream.
    if (options.signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = ceiling.signal.aborted;
    warn(
      timedOut
        ? `outline timed out after ${timeoutMs} ms (${provider}/${model ?? 'auto'}) — no outline`
        : `outline failed (${msg.slice(0, 160)}) — no outline`,
      { model, timedOut, timeoutMs, itemsShown: used, ms: Date.now() - startedAt },
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
