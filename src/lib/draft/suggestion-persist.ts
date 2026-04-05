/**
 * Server-side helpers for persisting DraftSuggestion rows, computing anchor
 * positions from verbatim text, detecting conflicts, and converting Prisma
 * rows into the DTO shape the client consumes.
 *
 * Used by:
 *   - src/app/api/draft/chat/route.ts (auto-suggest streaming path)
 *   - src/app/api/draft/suggestions/route.ts (batch insert fallback)
 *   - src/app/api/draft/suggestions/[id]/route.ts (PATCH status)
 */

import { prisma } from '@/lib/db/prisma';
import type { DraftSuggestion as DraftSuggestionRow } from '@prisma/client';
import {
  DraftSuggestionDTO,
  DenyReasonTagSlug,
  RawSuggestion,
  SuggestionCategory,
  SuggestionStatus,
} from './suggestion-types';

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

export interface ResolvedAnchor {
  /** Absolute position in the plain-text view of the document. */
  from: number;
  to: number;
  /** The verbatim substring that was matched (same as input if exact match). */
  matched: string;
}

/**
 * Locate a verbatim `anchorText` within `documentText` and return its start/end
 * positions. If the text appears more than once, prefer the occurrence closest
 * to (but not matching) `anchorHint` if provided.
 *
 * Returns null if the text cannot be located at all — the server should drop
 * such suggestions rather than storing them with bogus positions.
 */
export function locateAnchor(
  documentText: string,
  anchorText: string,
  anchorHint?: string
): ResolvedAnchor | null {
  if (!anchorText || anchorText.length === 0) return null;

  // First try verbatim.
  const positions: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= documentText.length) {
    const idx = documentText.indexOf(anchorText, searchFrom);
    if (idx === -1) break;
    positions.push(idx);
    searchFrom = idx + 1;
    if (positions.length >= 50) break; // safety — don't explode on super common phrases
  }

  if (positions.length === 0) {
    // Whitespace-tolerant fallback: normalise both and search.
    const normalizedDoc = documentText.replace(/\s+/g, ' ');
    const normalizedAnchor = anchorText.replace(/\s+/g, ' ').trim();
    const idx = normalizedDoc.indexOf(normalizedAnchor);
    if (idx === -1) return null;
    // Approximate the original-text position by counting characters up to idx.
    // We walk the original doc, skipping extra whitespace, until we reach the
    // normalized position. This is best-effort; close enough for ProseMirror.
    let origPos = 0;
    let normPos = 0;
    while (normPos < idx && origPos < documentText.length) {
      if (/\s/.test(documentText[origPos])) {
        // Collapse runs of whitespace in the original to a single space.
        while (origPos < documentText.length && /\s/.test(documentText[origPos])) origPos++;
        normPos++;
      } else {
        origPos++;
        normPos++;
      }
    }
    return {
      from: origPos,
      to: Math.min(documentText.length, origPos + normalizedAnchor.length),
      matched: documentText.slice(origPos, origPos + normalizedAnchor.length),
    };
  }

  // Single match — easy.
  if (positions.length === 1) {
    return { from: positions[0], to: positions[0] + anchorText.length, matched: anchorText };
  }

  // Multiple matches — use anchorHint to disambiguate if possible.
  if (anchorHint && anchorHint.length > 0) {
    let bestIdx = positions[0];
    let bestDistance = Infinity;
    const hintIdx = documentText.indexOf(anchorHint);
    if (hintIdx !== -1) {
      for (const pos of positions) {
        const dist = Math.abs(pos - hintIdx);
        if (dist < bestDistance) {
          bestDistance = dist;
          bestIdx = pos;
        }
      }
      return { from: bestIdx, to: bestIdx + anchorText.length, matched: anchorText };
    }
  }

  // No hint — default to first occurrence.
  return { from: positions[0], to: positions[0] + anchorText.length, matched: anchorText };
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Given a list of persisted suggestion rows (all from the same session),
 * return a map of id → list of ids whose anchor ranges intersect it.
 *
 * UI uses this to show the "conflicts with #N" badge. Accepting one
 * suggestion in a conflict group auto-stales the others (handled in the
 * tracking plugin when the transaction collapses their range).
 */
export function detectConflicts(rows: Array<Pick<DraftSuggestionRow, 'id' | 'anchorFrom' | 'anchorTo'>>): Map<string, string[]> {
  const conflicts = new Map<string, string[]>();
  const sorted = [...rows].sort((a, b) => a.anchorFrom - b.anchorFrom);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.anchorFrom >= a.anchorTo) break; // no overlap, and since sorted, no further overlaps
      // overlap
      if (!conflicts.has(a.id)) conflicts.set(a.id, []);
      if (!conflicts.has(b.id)) conflicts.set(b.id, []);
      conflicts.get(a.id)!.push(b.id);
      conflicts.get(b.id)!.push(a.id);
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Persist helpers
// ---------------------------------------------------------------------------

export interface PersistOneInput {
  draftId: string;
  sessionId: string;
  draftVersion: number;
  raw: RawSuggestion;
  documentText: string;
}

/**
 * Persist a single raw suggestion. Returns null if the anchor cannot be
 * located verbatim in the document (caller should emit a warning event).
 */
export async function persistSuggestion(input: PersistOneInput): Promise<DraftSuggestionRow | null> {
  const { draftId, sessionId, draftVersion, raw, documentText } = input;

  const anchor = locateAnchor(documentText, raw.anchorText, raw.anchorHint);
  if (!anchor) return null;

  const row = await prisma.draftSuggestion.create({
    data: {
      draftId,
      sessionId,
      draftVersion,
      anchorFrom: anchor.from,
      anchorTo: anchor.to,
      originalText: anchor.matched,
      proposedText: raw.proposedText,
      category: raw.category,
      reason: raw.reason,
      confidence: raw.confidence ?? null,
      status: 'pending',
    },
  });

  return row;
}

/**
 * Update an existing suggestion row in-place for the Regenerate flow.
 * Leaves status='pending' and bumps regenerationCount.
 */
export async function regenerateSuggestion(
  id: string,
  raw: RawSuggestion,
  documentText: string
): Promise<DraftSuggestionRow | null> {
  const existing = await prisma.draftSuggestion.findUnique({ where: { id } });
  if (!existing) return null;
  if (existing.regenerationCount >= 3) return existing; // hard cap

  // Try to re-anchor against the current document; if unchanged, keep old coords.
  const anchor = locateAnchor(documentText, raw.anchorText ?? existing.originalText, raw.anchorHint);

  return prisma.draftSuggestion.update({
    where: { id },
    data: {
      proposedText: raw.proposedText,
      reason: raw.reason,
      category: raw.category,
      confidence: raw.confidence ?? null,
      anchorFrom: anchor?.from ?? existing.anchorFrom,
      anchorTo: anchor?.to ?? existing.anchorTo,
      originalText: anchor?.matched ?? existing.originalText,
      regenerationCount: existing.regenerationCount + 1,
      status: 'pending',
      resolvedAt: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Row → DTO
// ---------------------------------------------------------------------------

export function rowToDTO(
  row: DraftSuggestionRow,
  opts?: { conflictsWith?: string[] }
): DraftSuggestionDTO {
  let denyReasonTags: DenyReasonTagSlug[] = [];
  try {
    const parsed = JSON.parse(row.denyReasonTags);
    if (Array.isArray(parsed)) denyReasonTags = parsed as DenyReasonTagSlug[];
  } catch {
    // ignore malformed JSON
  }

  return {
    id: row.id,
    draftId: row.draftId,
    sessionId: row.sessionId,
    draftVersion: row.draftVersion,
    anchorFrom: row.anchorFrom,
    anchorTo: row.anchorTo,
    originalText: row.originalText,
    proposedText: row.proposedText,
    category: row.category as SuggestionCategory,
    reason: row.reason,
    confidence: row.confidence,
    status: row.status as SuggestionStatus,
    denyReasonTags,
    denyReasonText: row.denyReasonText,
    regenerationCount: row.regenerationCount,
    conflictsWith: opts?.conflictsWith,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Tolerant JSON envelope parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw AI response (may include stray prose, code fences, or trailing
 * commentary) into a SuggestionEnvelope. Returns null if no valid JSON can
 * be extracted at all.
 *
 * Extracted by stripping to the first `{` and the last `}`, then JSON.parse.
 * Callers should run the result through suggestionEnvelopeSchema.safeParse.
 */
export function extractJsonEnvelope(text: string): unknown | null {
  if (!text) return null;
  // Strip code fences if present.
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const candidate = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
