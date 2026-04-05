/**
 * Learning loop for the Auto-Suggest feature.
 *
 * When the user accepts/denies/ignores a DraftSuggestion, we derive a
 * UserPreferenceSignal row that captures "what this user likes/dislikes".
 * On subsequent Auto-Suggest calls, summarisePreferences() reads recent
 * signals, applies recency decay, picks the top rules, and returns a
 * compact markdown block that is injected into the system prompt.
 *
 * Scoping tiers (per user decision in the plan):
 *   1. draftId — primary
 *   2. caseId  — fallback, weight × 0.5
 *   3. documentType — fallback, weight × 0.25
 */

import { prisma } from '@/lib/db/prisma';
import type {
  DraftSuggestionDTO,
  PreferenceExample,
  PreferenceRule,
  PreferencesBlock,
  SuggestionCategory,
  SuggestionStatus,
} from './suggestion-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max example pairs to retain per preference row (FIFO). */
const MAX_EXAMPLE_PAIRS = 3;

/** Exponential recency decay — signals age out on a 30-day half-life. */
const DECAY_LAMBDA_DAYS = 30;

/** Top N prefer / avoid rules to return from summarisePreferences. */
const TOP_PREFER = 3;
const TOP_AVOID = 3;

/** Few-shot accepted examples to include in the block. */
const FEW_SHOT_EXAMPLES = 3;

/** Hard cap on the injected markdown block size (rough token estimate = chars / 4). */
const MAX_BLOCK_TOKENS = 800;

/** Ignored signals only get recorded after the user has ignored this many in the same category. */
const IGNORE_SIGNAL_THRESHOLD = 3;
const IGNORE_SIGNAL_WEIGHT = 0.2;

// ---------------------------------------------------------------------------
// derivePreferenceSignal — called from the PATCH /api/draft/suggestions/[id] route
// ---------------------------------------------------------------------------

export type Decision = Extract<SuggestionStatus, 'accepted' | 'denied' | 'ignored'>;

interface DeriveInput {
  suggestion: Pick<
    DraftSuggestionDTO,
    'draftId' | 'category' | 'originalText' | 'proposedText' | 'reason' | 'denyReasonTags'
  > & {
    caseId?: string | null;
    documentType?: string | null;
  };
  decision: Decision;
}

/**
 * Convert a terminal suggestion decision into a persisted preference signal.
 *
 * Upserts one row per (draftId, category, signal) bucket so repeated agreements
 * accumulate weight + examples rather than creating duplicates.
 */
export async function derivePreferenceSignal({ suggestion, decision }: DeriveInput): Promise<void> {
  const { draftId, category, originalText, proposedText, reason, denyReasonTags, caseId, documentType } = suggestion;

  if (decision === 'ignored') {
    // Weak signal — only record after the user has ignored IGNORE_SIGNAL_THRESHOLD items
    // in the same category for the same draft.
    const ignoredCount = await prisma.draftSuggestion.count({
      where: { draftId, category, status: 'ignored' },
    });
    if (ignoredCount < IGNORE_SIGNAL_THRESHOLD) return;
  }

  const signalKind: 'prefer' | 'avoid' = decision === 'accepted' ? 'prefer' : 'avoid';
  const summary = buildSummary({ decision, category, reason, denyReasonTags });
  const weight = decision === 'ignored' ? IGNORE_SIGNAL_WEIGHT : 1.0;

  // Upsert: find an existing row for this (draftId, signalKind, category) tuple.
  const existing = await prisma.userPreferenceSignal.findFirst({
    where: { draftId, signal: signalKind, category },
    orderBy: { updatedAt: 'desc' },
  });

  if (existing) {
    // Append example pair (accepted only), capped at MAX_EXAMPLE_PAIRS (FIFO).
    let examplePairs: PreferenceExample[] = [];
    try {
      examplePairs = JSON.parse(existing.examplePairs) as PreferenceExample[];
      if (!Array.isArray(examplePairs)) examplePairs = [];
    } catch {
      examplePairs = [];
    }
    if (decision === 'accepted') {
      examplePairs.push({ original: truncate(originalText, 200), proposed: truncate(proposedText, 200) });
      if (examplePairs.length > MAX_EXAMPLE_PAIRS) {
        examplePairs = examplePairs.slice(-MAX_EXAMPLE_PAIRS);
      }
    }

    await prisma.userPreferenceSignal.update({
      where: { id: existing.id },
      data: {
        summary, // refresh with latest rationale
        examplePairs: JSON.stringify(examplePairs),
        weight: Math.min(existing.weight + weight, 10), // cap at 10 to avoid runaway
        lastSeenAt: new Date(),
        caseId: existing.caseId ?? caseId ?? null,
        documentType: existing.documentType ?? documentType ?? null,
      },
    });
  } else {
    const examplePairs: PreferenceExample[] =
      decision === 'accepted'
        ? [{ original: truncate(originalText, 200), proposed: truncate(proposedText, 200) }]
        : [];

    await prisma.userPreferenceSignal.create({
      data: {
        draftId,
        caseId: caseId ?? null,
        documentType: documentType ?? null,
        signal: signalKind,
        category,
        summary,
        examplePairs: JSON.stringify(examplePairs),
        weight,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// summarisePreferences — called from /api/draft/chat before building the prompt
// ---------------------------------------------------------------------------

export interface SummariseInput {
  draftId?: string;
  caseId?: string;
  documentType?: string;
}

/**
 * Read recent preference signals scoped by draft/case/documentType, apply
 * recency decay, merge duplicates, and return a ready-to-inject markdown
 * block (~300 tokens target, hard-capped at MAX_BLOCK_TOKENS).
 *
 * Returns an empty block when no signals exist — the caller should skip
 * injection entirely in that case.
 */
export async function summarisePreferences(input: SummariseInput): Promise<PreferencesBlock> {
  const { draftId, caseId, documentType } = input;

  // Primary: draftId-scoped.
  // Fallback: caseId-scoped with weight × 0.5.
  // Fallback: documentType-scoped with weight × 0.25.
  const whereClauses: Array<{ where: Record<string, unknown>; weightMult: number }> = [];
  if (draftId) whereClauses.push({ where: { draftId }, weightMult: 1.0 });
  if (caseId) whereClauses.push({ where: { caseId, draftId: null }, weightMult: 0.5 });
  if (documentType) whereClauses.push({ where: { documentType, draftId: null, caseId: null }, weightMult: 0.25 });

  if (whereClauses.length === 0) {
    return { markdown: '', rules: [], examples: [], estimatedTokens: 0 };
  }

  const allSignals = await Promise.all(
    whereClauses.map(async ({ where, weightMult }) => {
      const rows = await prisma.userPreferenceSignal.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        take: 50,
      });
      return rows.map((row) => ({ row, weightMult }));
    })
  );

  const flat = allSignals.flat();
  if (flat.length === 0) {
    return { markdown: '', rules: [], examples: [], estimatedTokens: 0 };
  }

  // Apply exponential recency decay and scope multiplier.
  const now = Date.now();
  const decayed = flat.map(({ row, weightMult }) => {
    const ageDays = (now - row.lastSeenAt.getTime()) / (1000 * 60 * 60 * 24);
    const effective = row.weight * weightMult * Math.exp(-ageDays / DECAY_LAMBDA_DAYS);
    return { row, effective };
  });

  // Merge near-duplicates by summary text (simple containment check).
  const merged: typeof decayed = [];
  for (const entry of decayed) {
    const clash = merged.find((m) => isSimilar(m.row.summary, entry.row.summary));
    if (clash) {
      clash.effective += entry.effective * 0.5;
    } else {
      merged.push({ ...entry });
    }
  }

  // Split by signal kind and category, then take the top N of each.
  const prefers = merged.filter((m) => m.row.signal === 'prefer').sort((a, b) => b.effective - a.effective);
  const avoids = merged.filter((m) => m.row.signal === 'avoid').sort((a, b) => b.effective - a.effective);

  const topPrefers = prefers.slice(0, TOP_PREFER);
  const topAvoids = avoids.slice(0, TOP_AVOID);

  const rules: PreferenceRule[] = [
    ...topPrefers.map((p) => ({
      category: p.row.category as SuggestionCategory,
      signal: 'prefer' as const,
      summary: p.row.summary,
      weight: p.effective,
    })),
    ...topAvoids.map((a) => ({
      category: a.row.category as SuggestionCategory,
      signal: 'avoid' as const,
      summary: a.row.summary,
      weight: a.effective,
    })),
  ];

  // Collect few-shot examples from the top prefer rows only.
  const examples: PreferenceExample[] = [];
  for (const p of topPrefers) {
    try {
      const pairs = JSON.parse(p.row.examplePairs) as PreferenceExample[];
      if (Array.isArray(pairs)) {
        for (const pair of pairs) {
          if (examples.length < FEW_SHOT_EXAMPLES) examples.push(pair);
        }
      }
    } catch {
      // ignore malformed JSON
    }
  }

  // Build the markdown block.
  const markdown = renderMarkdown(topPrefers, topAvoids, examples);
  const estimatedTokens = Math.ceil(markdown.length / 4);

  // Hard cap — if over budget, drop lowest-weight rules until within budget.
  if (estimatedTokens > MAX_BLOCK_TOKENS) {
    return summariseWithShrink(topPrefers, topAvoids, examples, MAX_BLOCK_TOKENS);
  }

  return { markdown, rules, examples, estimatedTokens };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSummary(args: {
  decision: Decision;
  category: SuggestionCategory;
  reason: string;
  denyReasonTags: string[];
}): string {
  const { decision, category, reason, denyReasonTags } = args;
  const categoryLabel = category.toUpperCase();
  const cleanReason = truncate(reason.replace(/\.$/, ''), 100);

  if (decision === 'accepted') {
    return `${categoryLabel}: ${cleanReason}`;
  }

  // Denied / ignored → frame as an "avoid" rule
  if (denyReasonTags && denyReasonTags.length > 0) {
    const tagsText = denyReasonTags.join(', ');
    return `${categoryLabel}: Avoid — ${cleanReason} (tags: ${tagsText})`;
  }
  return `${categoryLabel}: Avoid — ${cleanReason}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

/** Crude similarity check: one string contains 60% of the other's words. */
function isSimilar(a: string, b: string): boolean {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const [smaller, larger] = wordsA.size < wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA];
  let overlap = 0;
  for (const w of smaller) if (larger.has(w)) overlap++;
  return overlap / smaller.size >= 0.6;
}

function renderMarkdown(
  topPrefers: Array<{ row: { summary: string; category: string } }>,
  topAvoids: Array<{ row: { summary: string; category: string } }>,
  examples: PreferenceExample[]
): string {
  if (topPrefers.length === 0 && topAvoids.length === 0 && examples.length === 0) {
    return '';
  }

  const lines: string[] = [];
  lines.push('## User Preferences (learned from prior accept/deny decisions)');
  lines.push('Apply these when generating suggestions. Do not re-suggest content the user has denied with the same rationale.');
  lines.push('');

  if (topPrefers.length > 0) {
    lines.push('Prefer:');
    for (const p of topPrefers) {
      lines.push(`- ${p.row.summary}`);
    }
    lines.push('');
  }

  if (topAvoids.length > 0) {
    lines.push('Avoid:');
    for (const a of topAvoids) {
      lines.push(`- ${a.row.summary}`);
    }
    lines.push('');
  }

  if (examples.length > 0) {
    lines.push('Recent accepted examples (phrasing the user has approved):');
    examples.forEach((ex, i) => {
      lines.push(`${i + 1}. "${truncate(ex.proposed, 160)}"`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function summariseWithShrink(
  topPrefers: Array<{ row: { summary: string; category: string }; effective: number }>,
  topAvoids: Array<{ row: { summary: string; category: string }; effective: number }>,
  examples: PreferenceExample[],
  budget: number
): PreferencesBlock {
  let prefers = [...topPrefers];
  let avoids = [...topAvoids];
  let exs = [...examples];

  // Drop lowest-weight rules first, then examples.
  let markdown = renderMarkdown(prefers, avoids, exs);
  let tokens = Math.ceil(markdown.length / 4);

  while (tokens > budget) {
    if (exs.length > 0) {
      exs = exs.slice(0, exs.length - 1);
    } else if (avoids.length > prefers.length) {
      avoids = avoids.slice(0, avoids.length - 1);
    } else if (prefers.length > 0) {
      prefers = prefers.slice(0, prefers.length - 1);
    } else {
      break;
    }
    markdown = renderMarkdown(prefers, avoids, exs);
    tokens = Math.ceil(markdown.length / 4);
  }

  const rules: PreferenceRule[] = [
    ...prefers.map((p) => ({
      category: p.row.category as SuggestionCategory,
      signal: 'prefer' as const,
      summary: p.row.summary,
      weight: p.effective,
    })),
    ...avoids.map((a) => ({
      category: a.row.category as SuggestionCategory,
      signal: 'avoid' as const,
      summary: a.row.summary,
      weight: a.effective,
    })),
  ];

  return { markdown, rules, examples: exs, estimatedTokens: tokens };
}

// ---------------------------------------------------------------------------
// Utilities for the settings panel ("Clear learned preferences" button)
// ---------------------------------------------------------------------------

export async function clearLearnedPreferencesForDraft(draftId: string): Promise<number> {
  const result = await prisma.userPreferenceSignal.deleteMany({ where: { draftId } });
  return result.count;
}

export async function clearLearnedPreferencesForCase(caseId: string): Promise<number> {
  const result = await prisma.userPreferenceSignal.deleteMany({ where: { caseId } });
  return result.count;
}

/**
 * Promote draftId-scoped signals to caseId scope — used when the user flips
 * the "Share learned preferences across this case" toggle ON.
 */
export async function promoteDraftSignalsToCase(draftId: string, caseId: string): Promise<number> {
  const result = await prisma.userPreferenceSignal.updateMany({
    where: { draftId },
    data: { caseId, draftId: null },
  });
  return result.count;
}
