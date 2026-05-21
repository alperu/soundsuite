/**
 * POST /api/search/interpret
 *
 * Translates a freetext query into a structured Haystack chip set + compiled
 * filter using `interpretQuery`. Person and case indexes are loaded once per
 * cold-start (cached for 60 s) by calling the legal repo directly — avoids
 * a self-fetch through the Haystack auth gate.
 */

import { NextRequest, NextResponse } from 'next/server';

import {
  interpretQuery,
  type CaseIndexEntry,
  type InterpretContext,
  type PersonIndexEntry,
} from '@/lib/search/freetext-interpreter';

export const dynamic = 'force-dynamic';

interface CachedIndex {
  loadedAt: number;
  personIndex: PersonIndexEntry[];
  caseIndex: CaseIndexEntry[];
}

const CACHE_TTL_MS = 60_000;
let cached: CachedIndex | null = null;

async function loadIndexes(): Promise<{
  personIndex: PersonIndexEntry[];
  caseIndex: CaseIndexEntry[];
}> {
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return { personIndex: cached.personIndex, caseIndex: cached.caseIndex };
  }

  let personIndex: PersonIndexEntry[] = [];
  let caseIndex: CaseIndexEntry[] = [];

  try {
    // Soft-import the repo — the legal schema may not be migrated in every env.
    const repo: any = await import('@/lib/legal/repo' as any).catch(() => null);
    if (repo?.findPerson) {
      const rows: any[] = await repo.findPerson('person', 5000).catch(() => []);
      personIndex = rows.map((r) => ({
        id: String(r.id ?? r.personId ?? ''),
        displayName: String(r.displayName ?? r.name ?? r.id ?? ''),
        intrinsicTags: extractIntrinsicTags(r),
      })).filter((p) => p.id && p.displayName);
    }
    if (repo?.findCase) {
      const rows: any[] = await repo.findCase('case', 5000).catch(() => []);
      caseIndex = rows.map((r) => ({
        id: String(r.id ?? r.caseId ?? ''),
        causeNo: r.causeNo ?? r.cause_no ?? undefined,
        name: r.name ?? r.title ?? undefined,
      })).filter((c) => c.id);
    }
  } catch {
    // Schema/migration not ready — operate with empty indexes (interpreter still
    // handles dates, entity nouns, jurisdiction, amendments).
  }

  cached = { loadedAt: Date.now(), personIndex, caseIndex };
  return { personIndex, caseIndex };
}

/** Pull boolean markers off a repo row. */
function extractIntrinsicTags(row: any): Record<string, boolean> {
  const tags: Record<string, boolean> = {};
  for (const k of ['judge', 'lawyer', 'courtClerk', 'courtReporter']) {
    if (row[k] === true || row[k] === 1 || row[k] === '1') tags[k] = true;
  }
  // Tags often live in a JSON column.
  if (row.tags && typeof row.tags === 'object') {
    for (const [k, v] of Object.entries(row.tags as Record<string, unknown>)) {
      if (v === true || v === 1 || v === '1') tags[k] = true;
    }
  }
  return tags;
}

export async function POST(request: NextRequest) {
  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
  }
  const text = typeof body?.text === 'string' ? body.text : '';
  if (!text.trim()) {
    return NextResponse.json({ error: { message: 'text is required' } }, { status: 400 });
  }

  const { personIndex, caseIndex } = await loadIndexes();
  const ctx: InterpretContext = { personIndex, caseIndex, now: new Date() };
  const result = await interpretQuery(text, ctx);
  return NextResponse.json(result);
}

/** Test-only export to allow cache reset between requests. */
export function __resetInterpretCache() {
  cached = null;
}
