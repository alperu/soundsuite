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

/**
 * Parse the `scope` query param. It's a URL-encoded JSON array of
 * `{tag, op, value}` chips currently present in the composer. We only act on
 * a `caseRef==<id>` chip for now (used to scope the filingRef picker).
 */
interface ScopeChip {
  tag: string;
  op?: string;
  value: string;
}

function parseScope(raw: string | null): ScopeChip[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is ScopeChip =>
        c && typeof c === 'object' && typeof c.tag === 'string' && typeof c.value === 'string',
    );
  } catch {
    return [];
  }
}

function caseIdsFromScope(scope: ScopeChip[]): string[] {
  const ids: string[] = [];
  for (const c of scope) {
    if ((c.tag !== 'caseRef' && c.tag !== 'case') || (c.op ?? '==') !== '==') continue;
    const id = c.value.startsWith('@') ? c.value.slice(1) : c.value;
    if (id) ids.push(id);
  }
  return Array.from(new Set(ids));
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const pathParam = url.searchParams.get('path') ?? '';
    const prefix = (url.searchParams.get('prefix') ?? '').trim();
    const limitRaw = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
    const scope = parseScope(url.searchParams.get('scope'));

    const segments = pathParam.split('->').filter((s) => s.length > 0);
    if (segments.length < 1) {
      return NextResponse.json({ options: [] satisfies PathValueOption[] });
    }
    const root = segments[0];
    const attrSeg = segments[segments.length - 1];

    // — filingRef: pick from Filing table, optionally scoped to a case== chip. —
    // Single-segment path (`filingRef`) returns filings; the picker uses the
    // returned `value` as the @id and `label` as the human-readable title.
    if (root === 'filingRef' || root === 'filing') {
      const filingClient = prisma as unknown as {
        filing: {
          findMany: (args: {
            where: unknown;
            select?: unknown;
            take?: number;
            orderBy?: unknown;
          }) => Promise<Array<Record<string, unknown>>>;
        };
      };
      const scopedCaseIds = caseIdsFromScope(scope);
      const where: Record<string, unknown> = {};
      if (scopedCaseIds.length === 1) {
        where.caseId = scopedCaseIds[0];
      } else if (scopedCaseIds.length > 1) {
        where.caseId = { in: scopedCaseIds };
      }
      if (prefix) {
        where.OR = [
          { title: { contains: prefix } },
          { filingType: { contains: prefix } },
        ];
      }
      const rows = await filingClient.filing.findMany({
        where,
        select: { id: true, title: true, filingType: true, filingDate: true },
        take: limit,
        orderBy: [{ filingDate: 'desc' }, { title: 'asc' }],
      });
      const options: PathValueOption[] = rows.map((r) => {
        const id = r.id as string;
        const title = (r.title as string) ?? '';
        const ftype = (r.filingType as string | null) ?? '';
        const date = r.filingDate ? String(r.filingDate).slice(0, 10) : '';
        return {
          value: `@${id}`,
          label: title || ftype || id,
          secondary: [ftype, date].filter(Boolean).join(' · ') || undefined,
          id,
        };
      });
      return NextResponse.json({ options });
    }

    // The Prisma client's `$extends` return type doesn't surface the model
    // delegates cleanly here, so we narrow with a local cast. Reads only;
    // never mutates.
    const client = prisma as unknown as {
      case: {
        findMany: (args: {
          where: unknown;
          distinct?: unknown;
          select?: unknown;
          take?: number;
          orderBy?: unknown;
        }) => Promise<Array<Record<string, unknown>>>;
      };
      person: {
        findMany: (args: {
          where: unknown;
          distinct?: unknown;
          select?: unknown;
          take?: number;
          orderBy?: unknown;
        }) => Promise<Array<Record<string, unknown>>>;
      };
    };

    // — case->{attr}: Case-attribute traversal —
    if (root === 'case' && segments.length === 2) {
      const col = CASE_ATTRS[attrSeg];
      if (!col) return NextResponse.json({ options: [] });
      const where: Record<string, unknown> = prefix
        ? { [col]: { startsWith: prefix } }
        : { [col]: { not: null } };
      const rows = await client.case.findMany({
        where,
        distinct: [col],
        select: { id: true, [col]: true },
        take: limit,
        orderBy: { [col]: 'asc' },
      });
      const options: PathValueOption[] = [];
      for (const r of rows) {
        const v = r[col];
        if (typeof v !== 'string' || !v) continue;
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
      const rows = await client.person.findMany({
        where,
        distinct: [col],
        select: { id: true, displayName: true, email: true, barNumber: true },
        take: limit,
        orderBy: { [col]: 'asc' },
      });
      const options: PathValueOption[] = [];
      for (const r of rows) {
        const v = r[col];
        if (typeof v !== 'string' || !v) continue;
        const secondary =
          col === 'displayName'
            ? (r.email as string | null) ?? (r.barNumber as string | null) ?? undefined
            : col === 'email'
              ? (r.displayName as string | null) ?? undefined
              : (r.displayName as string | null) ?? undefined;
        options.push({
          value: v,
          label: v,
          secondary: secondary ?? undefined,
          id: r.id as string,
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
