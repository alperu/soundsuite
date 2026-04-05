/**
 * Shared types for the Auto-Suggest feature: the structured AI output envelope,
 * DTOs returned by API routes, status transitions, and deny-reason tag vocabulary.
 *
 * The types here are the contract between:
 *   - src/app/api/draft/chat/route.ts (server parses AI JSON into these)
 *   - src/app/api/draft/suggestions/**  (CRUD on DraftSuggestion rows)
 *   - src/hooks/use-draft-suggestions.ts (client stream consumer)
 *   - src/components/draft/suggestion-*.tsx (UI rendering)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Categories & deny-reason tags
// ---------------------------------------------------------------------------

export const SUGGESTION_CATEGORIES = [
  'tone',
  'grammar',
  'structure',
  'citation',
  'clarity',
  'other',
] as const;

export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

/** UI colors for each category (tailwind-class friendly). */
export const CATEGORY_COLORS: Record<SuggestionCategory, { dot: string; border: string; label: string }> = {
  tone:      { dot: 'bg-amber-500',   border: 'border-l-amber-500',   label: 'text-amber-700' },
  grammar:   { dot: 'bg-blue-500',    border: 'border-l-blue-500',    label: 'text-blue-700' },
  citation:  { dot: 'bg-purple-500',  border: 'border-l-purple-500',  label: 'text-purple-700' },
  structure: { dot: 'bg-emerald-500', border: 'border-l-emerald-500', label: 'text-emerald-700' },
  clarity:   { dot: 'bg-cyan-500',    border: 'border-l-cyan-500',    label: 'text-cyan-700' },
  other:     { dot: 'bg-slate-400',   border: 'border-l-slate-400',   label: 'text-slate-700' },
};

export const DENY_REASON_TAGS = [
  { slug: 'wrong-tone',              label: 'Wrong tone' },
  { slug: 'inaccurate',              label: 'Inaccurate or unsupported' },
  { slug: 'too-verbose',             label: 'Too verbose' },
  { slug: 'off-topic',               label: 'Off topic / irrelevant' },
  { slug: 'redundant',               label: 'Already stated elsewhere' },
  { slug: 'stylistic-disagreement',  label: 'I prefer the original' },
  { slug: 'legal-incorrect',         label: 'Legally incorrect' },
  { slug: 'missing-citation',        label: 'Missing citation' },
] as const;

export type DenyReasonTagSlug = (typeof DENY_REASON_TAGS)[number]['slug'];

// ---------------------------------------------------------------------------
// Status values
// ---------------------------------------------------------------------------

export const SUGGESTION_STATUSES = ['pending', 'accepted', 'denied', 'ignored', 'stale'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

// ---------------------------------------------------------------------------
// AI output schema (what the model must return when Auto-Suggest is ON)
// ---------------------------------------------------------------------------

/** One raw suggestion as the AI produces it — pre-persist, pre-anchor-resolution. */
export const rawSuggestionSchema = z.object({
  anchorText: z.string().min(1).max(2000),
  anchorHint: z.string().max(60).optional(),
  proposedText: z.string().min(1).max(4000),
  category: z.enum(SUGGESTION_CATEGORIES),
  reason: z.string().min(1).max(280),
  confidence: z.number().min(0).max(1).optional(),
});

export type RawSuggestion = z.infer<typeof rawSuggestionSchema>;

/** The full envelope the AI must return when autoSuggest=true. */
export const suggestionEnvelopeSchema = z.object({
  suggestions: z.array(rawSuggestionSchema).max(20),
  notes: z.string().max(4000).optional(),
});

export type SuggestionEnvelope = z.infer<typeof suggestionEnvelopeSchema>;

// ---------------------------------------------------------------------------
// DTO returned by API routes to the client
// ---------------------------------------------------------------------------

export interface DraftSuggestionDTO {
  id: string;
  draftId: string;
  sessionId: string;
  draftVersion: number;
  anchorFrom: number;
  anchorTo: number;
  originalText: string;
  proposedText: string;
  category: SuggestionCategory;
  reason: string;
  confidence: number | null;
  status: SuggestionStatus;
  denyReasonTags: DenyReasonTagSlug[];
  denyReasonText: string | null;
  regenerationCount: number;
  /** IDs of other suggestions whose anchor range intersects this one. */
  conflictsWith?: string[];
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Stream events (NDJSON) between server and client
// ---------------------------------------------------------------------------

export type SuggestionStreamEvent =
  | { type: 'progress'; step?: string; message: string; detail?: Record<string, unknown> }
  | { type: 'token'; text: string }                              // ignored in suggest mode, kept for debug
  | { type: 'suggestion'; suggestion: DraftSuggestionDTO }
  | { type: 'suggestions_done'; count: number }
  | { type: 'regenerate_done'; suggestionId: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; error: string; raw?: string }
  | { type: 'result'; data: { text: string; model: string; provider: string; usage?: unknown } };

// ---------------------------------------------------------------------------
// API request/response shapes
// ---------------------------------------------------------------------------

/** PATCH /api/draft/suggestions/[id] body */
export const patchSuggestionBodySchema = z.object({
  status: z.enum(['accepted', 'denied', 'ignored', 'stale', 'pending']),
  denyReasonTags: z.array(z.string()).max(8).optional(),
  denyReasonText: z.string().max(2000).nullable().optional(),
});

export type PatchSuggestionBody = z.infer<typeof patchSuggestionBodySchema>;

/** POST /api/draft/suggestions body (manual batch insert / recovery path) */
export const postSuggestionsBodySchema = z.object({
  draftId: z.string().uuid(),
  sessionId: z.string().min(1),
  draftVersion: z.number().int().nonnegative(),
  items: z.array(
    rawSuggestionSchema.extend({
      anchorFrom: z.number().int().nonnegative(),
      anchorTo: z.number().int().nonnegative(),
    })
  ).max(20),
});

export type PostSuggestionsBody = z.infer<typeof postSuggestionsBodySchema>;

// ---------------------------------------------------------------------------
// Learned preferences — shape of the injected system-prompt block
// ---------------------------------------------------------------------------

export interface PreferenceRule {
  category: SuggestionCategory;
  signal: 'prefer' | 'avoid';
  summary: string;
  weight: number;
}

export interface PreferenceExample {
  original: string;
  proposed: string;
}

export interface PreferencesBlock {
  /** Ready-to-inject markdown string (or empty if no signals). */
  markdown: string;
  /** Structured counterpart — useful for logging and tests. */
  rules: PreferenceRule[];
  examples: PreferenceExample[];
  /** Rough token estimate for the markdown field. */
  estimatedTokens: number;
}
