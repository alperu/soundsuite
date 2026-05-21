/**
 * Haystack-aware search endpoint.
 *
 * Glue between the new structured filter UI (HaystackFilterInput) and:
 *   1. The Haystack HTTP server at `/api/haystack/read` (Agent 3 builds this).
 *   2. The existing semantic search pipeline (`query_case_knowledge` MCP tool).
 *
 * Behaviour:
 *   - POST { filter?: string, freetext?: string, caseId?: string, chatId?: string }
 *   - If `filter` is non-empty, forward to `/api/haystack/read?filter=...`. If the
 *     Haystack endpoint isn't live yet (404), surface a stub with a note so the
 *     UI keeps working.
 *   - If `freetext` is non-empty, also run a semantic search. Results are merged
 *     into the same response under separate keys so the UI can show provenance.
 *
 * This route is purely additive; it does not modify /api/search/deep or
 * deep-search-runner — the deep search pipeline keeps its current behaviour.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getToolRegistry } from '@/lib/mcp/get-tool-registry';

interface HaystackSearchBody {
  filter?: string;
  freetext?: string;
  caseId?: string;
  chatId?: string;
  /** Limit for the semantic pass. */
  limit?: number;
}

interface HaystackResultRow {
  id: string;
  [key: string]: unknown;
}

async function callHaystackRead(
  filter: string,
  origin: string,
): Promise<
  | { ok: true; results: HaystackResultRow[] }
  | { ok: false; status: number; note: string }
> {
  try {
    const url = `${origin}/api/haystack/read?filter=${encodeURIComponent(filter)}`;
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (res.status === 404) {
      return { ok: false, status: 404, note: 'haystack endpoint not yet live' };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, note: `haystack read failed (${res.status})` };
    }
    const data = (await res.json()) as { results?: HaystackResultRow[]; rows?: HaystackResultRow[] };
    return { ok: true, results: data.results ?? data.rows ?? [] };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      note: `haystack read errored: ${(err as Error).message}`,
    };
  }
}

export async function POST(request: NextRequest) {
  let body: HaystackSearchBody;
  try {
    body = (await request.json()) as HaystackSearchBody;
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const filter = (body.filter ?? '').trim();
  const freetext = (body.freetext ?? '').trim();
  const limit = body.limit ?? 10;

  if (!filter && !freetext) {
    return NextResponse.json(
      { error: { message: 'Provide at least one of filter or freetext' } },
      { status: 400 },
    );
  }

  const origin = request.nextUrl.origin;

  // Run both branches in parallel where applicable.
  const tasks: Promise<unknown>[] = [];

  let haystackTask: ReturnType<typeof callHaystackRead> | null = null;
  if (filter) {
    haystackTask = callHaystackRead(filter, origin);
    tasks.push(haystackTask);
  }

  type SemanticResult = { success: boolean; data?: unknown; error?: string };
  let semanticTask: Promise<SemanticResult> | null = null;
  if (freetext) {
    semanticTask = (async (): Promise<SemanticResult> => {
      try {
        const registry = await getToolRegistry();
        const result = await registry.execute('query_case_knowledge', {
          query: freetext,
          limit,
          ...(body.caseId ? { caseId: body.caseId } : {}),
          ...(body.chatId ? { chatId: body.chatId } : {}),
        });
        return result as SemanticResult;
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    })();
    tasks.push(semanticTask);
  }

  await Promise.all(tasks);

  const response: {
    filter: string;
    freetext: string;
    haystack?: { results: HaystackResultRow[]; note?: string };
    semantic?: { results: unknown; error?: string };
  } = { filter, freetext };

  if (haystackTask) {
    const r = await haystackTask;
    if (r.ok) {
      response.haystack = { results: r.results };
    } else {
      response.haystack = { results: [], note: r.note };
    }
  }

  if (semanticTask) {
    const r = await semanticTask;
    if (r.success) {
      response.semantic = { results: r.data };
    } else {
      response.semantic = { results: [], error: r.error };
    }
  }

  return NextResponse.json(response);
}
