import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

/**
 * Allowed haystack tag fields that an extractor may suggest for.
 * Keep in sync with the Filing schema and the Phase-2 extractor prompt.
 */
export type HaystackTagField =
  | 'filedOn'
  | 'receivedOn'
  | 'judgeRef'
  | 'movantRef'
  | 'respondentRef'
  | 'reporterRef'
  | 'fileRef';

export const HAYSTACK_TAG_FIELDS: HaystackTagField[] = [
  'filedOn',
  'receivedOn',
  'judgeRef',
  'movantRef',
  'respondentRef',
  'reporterRef',
  'fileRef',
];

/**
 * Request body for POST /api/cases/[id]/fill-haystack-tags.
 *
 * All fields are optional. By default the route scans every filing in the
 * case and proposes values for every supported field, without writing.
 */
export interface FillTagsRequest {
  /** Optional: limit to specific filing IDs. Default = all filings in case. */
  filingIds?: string[];
  /** Optional: limit to specific fields. Default = HAYSTACK_TAG_FIELDS. */
  fields?: HaystackTagField[];
  /** Default true — return suggestions without writing them. */
  dryRun?: boolean;
}

/**
 * One proposed change for a single (filing, field) pair.
 *
 * `proposedValue` is what the extractor wants to assign. For dates this is an
 * ISO-8601 string; for *Ref fields this is a Hayson `@ref` payload (whatever
 * the Phase-2 extractor decides) — kept as `unknown` here so consumers must
 * narrow before use.
 */
export interface FillTagSuggestion {
  filingId: string;
  filingTitle: string;
  /** Field name on the Filing row. See `HaystackTagField`. */
  field: HaystackTagField | string;
  /** Present value on the row (likely null/undefined for un-tagged filings). */
  currentValue: unknown;
  /** Value the extractor wants to write (ref payload or ISO date string). */
  proposedValue: unknown;
  /** Optional human-readable form (e.g. "Hon. Roberts" for a judge ref). */
  proposedDisplay?: string;
  /** Optional excerpt from the indexed text that supports the proposal. */
  sourceExcerpt?: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Response shape for POST /api/cases/[id]/fill-haystack-tags.
 *
 * Phase 1 (this stub): returns `suggestions: []` and a `note` indicating the
 * extractor is not yet wired. Phase 2 will populate `suggestions` via the
 * configured AI model.
 */
export interface FillTagsResponse {
  ok: true;
  /** Number of filings inspected. */
  scanned: number;
  suggestions: FillTagSuggestion[];
  /** Optional info / error message (e.g. Phase-1 stub notice). */
  note?: string;
}

export interface FillTagsErrorResponse {
  ok: false;
  error: string;
}

/**
 * POST /api/cases/[id]/fill-haystack-tags
 *
 * Phase 1 STUB: counts filings in the case (optionally filtered by
 * `filingIds`) and returns an empty suggestions array. The real extractor
 * will be implemented in a follow-up agent (Phase 2) and will populate
 * `suggestions` with proposed values for haystack-tag fields.
 *
 * This endpoint MUST NOT mutate any data. Always returns dry-run results.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<FillTagsResponse | FillTagsErrorResponse>> {
  try {
    const { id } = await params;

    const caseRow = await (prisma as any).case.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!caseRow) {
      return NextResponse.json(
        { ok: false, error: 'case_not_found' },
        { status: 404 },
      );
    }

    let body: FillTagsRequest = {};
    try {
      const raw = await request.json();
      if (raw && typeof raw === 'object') body = raw as FillTagsRequest;
    } catch {
      // Empty body is fine — all fields are optional.
    }

    const where: { caseId: string; id?: { in: string[] } } = { caseId: id };
    if (Array.isArray(body.filingIds) && body.filingIds.length > 0) {
      where.id = { in: body.filingIds };
    }

    const scanned = await (prisma as any).filing.count({ where });

    const response: FillTagsResponse = {
      ok: true,
      scanned,
      suggestions: [],
      note: 'Phase 2 — AI extractor not yet implemented',
    };
    return NextResponse.json(response);
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'fill_haystack_tags_failed' },
      { status: 500 },
    );
  }
}
