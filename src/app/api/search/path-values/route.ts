/**
 * Path-traversal value picker (Task #65).
 *
 * GET /api/search/path-values?path=<joined>&prefix=<text>&limit=20
 *
 * Returns distinct values for a 2-hop path attribute (e.g.
 * `reporterRef->displayName`, `case->jurisdiction`). The query is read-only
 * and resolves against Prisma — the same source `boolean-to-fts.ts` queries
 * when filtering — so the picker offers values that will actually match.
 *
 * Response: `{ options: [{ value: string, label: string, secondary?: string,
 *   id?: string }] }`
 *
 * Allowlist guard: every joined segment must come from a known allowlist
 * (mirrors `boolean-to-fts.ts:CASE_ATTRIBUTE_ALLOWLIST` /
 * `PERSON_ATTRIBUTE_ALLOWLIST`). Unknown shapes return `{ options: [] }`.
 *
 * v1 simplification: for `<personRef>->displayName` we surface all Persons
 * (no filter by role tag). The picker hint clarifies this; refinement is
 * tracked under #65 as a future improvement.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

// — Allowlists (kept in sync with boolean-to-fts.ts) —
const CASE_ATTRS: Record<string, string> = {
  jurisdiction: 'jurisdiction',
  state: 'state',
  county: 'county',
  country: 'country',
  name: 'name',
  caseNumber: 'caseNumber',
};

const PERSON_ATTRS: Record<string, string> = {
  displayName: 'displayName',
  name: 'displayName', // alias
  email: 'email',
  barNumber: 'barNumber',
};

// Single-segment Person-typed refs that share the same Person catalogue.
const PERSON_REF_ROOTS = new Set([
  'judgeRef',
  'movantRef',
  'respondentRef',
  'lawyerRef',
  'clerkRef',
  'reporterRef',
  // Surface forms (parser aliases also accept these — pickers will pass either)
  'judge',
  'movant',
  'respondent',
  'lawyer',
  'clerk',
  'reporter',
]);

export interface PathValueOption {
  value: string;
  label: string;
  secondary?: string;
  id?: string;
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const pathParam = url.searchParams.get('path') ?? '';
    const prefix = (url.searchParams.get('prefix') ?? '').trim();
    const limitRaw = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;

    const segments = pathParam.split('->').filter((s) => s.length > 0);
    if (segments.length < 2) {
      return NextResponse.json({ options: [] satisfies PathValueOption[] });
    }
    const root = segments[0];
    const attrSeg = segments[segments.length - 1];

    // — case->{attr}: Case-attribute traversal —
    if (root === 'case' && segments.length === 2) {
      const col = CASE_ATTRS[attrSeg];
      if (!col) return NextResponse.json({ options: [] });
      const where: Record<string, unknown> = prefix
        ? { [col]: { startsWith: prefix } }
        : { [col]: { not: null } };
      const rows = await prisma.case.findMany({
        where,
        distinct: [col as 'jurisdiction'],
        select: { id: true, [col]: true } as { id: true },
        take: limit,
        orderBy: { [col]: 'asc' } as { [k: string]: 'asc' },
      });
      const options: PathValueOption[] = [];
      for (const r of rows as Array<Record<string, unknown>>) {
        const v = r[col];
        if (typeof v !== 'string' || !v) continue;
        // Quote string values that contain whitespace so the chip stores them
        // as a Haystack phrase. Caller does the wrapping; we return the bare value.
        options.push({ value: v, label: v, id: r.id as string });
      }
      return NextResponse.json({ options });
    }

    // — <personRef>->{attr}: Person attribute. —
    // We don't filter the Person set by role-pool for v1 (documented limit).
    if (PERSON_REF_ROOTS.has(root) && segments.length === 2) {
      const col = PERSON_ATTRS[attrSeg];
      if (!col) return NextResponse.json({ options: [] });
      const where: Record<string, unknown> = prefix
        ? { [col]: { startsWith: prefix } }
        : { [col]: { not: null } };
      const rows = await prisma.person.findMany({
        where,
        distinct: [col as 'displayName'],
        select: { id: true, displayName: true, email: true, barNumber: true },
        take: limit,
        orderBy: { [col]: 'asc' } as { [k: string]: 'asc' },
      });
      const options: PathValueOption[] = [];
      for (const r of rows) {
        const v = (r as Record<string, unknown>)[col];
        if (typeof v !== 'string' || !v) continue;
        const secondary =
          col === 'displayName'
            ? r.email ?? r.barNumber ?? undefined
            : col === 'email'
              ? r.displayName ?? undefined
              : r.displayName ?? undefined;
        options.push({
          value: v,
          label: v,
          secondary: secondary ?? undefined,
          id: r.id,
        });
      }
      return NextResponse.json({ options });
    }

    // Unknown traversal shape — empty result, consistent with allowlist guard.
    return NextResponse.json({ options: [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ options: [], error: msg }, { status: 500 });
  }
}
