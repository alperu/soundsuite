/**
 * @deprecated — superseded by /api/search/unified (Task #54).
 *
 * Kept for one release cycle as a thin forwarder so any in-flight client
 * code keeps working. The legacy {filter, freetext} shape is mapped to the
 * unified {query} shape by concatenating filter + freetext with a space.
 *
 * Remove this file in the release after the chip composer ships (#55).
 */

import { NextRequest, NextResponse } from 'next/server';

interface LegacyHaystackBody {
  filter?: string;
  freetext?: string;
  caseId?: string;
  chatId?: string;
  limit?: number;
}

export async function POST(request: NextRequest) {
  let body: LegacyHaystackBody;
  try {
    body = (await request.json()) as LegacyHaystackBody;
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON body' } },
      { status: 400 },
    );
  }

  const filter = (body.filter ?? '').trim();
  const freetext = (body.freetext ?? '').trim();
  if (!filter && !freetext) {
    return NextResponse.json(
      { error: { message: 'Provide at least one of filter or freetext' } },
      { status: 400 },
    );
  }
  const query = [filter, freetext].filter(Boolean).join(' ').trim();

  // Forward to /api/search/unified. Use same-origin fetch so middleware /
  // auth headers carry through.
  const url = `${request.nextUrl.origin}/api/search/unified`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      ...(body.caseId ? { caseId: body.caseId } : {}),
      ...(body.chatId ? { chatId: body.chatId } : {}),
      ...(body.limit ? { limit: body.limit } : {}),
    }),
  });
  const json = await res.json();

  // Surface the unified envelope under the legacy `{haystack, semantic}` shape
  // so existing callers don't crash. `haystack.results` carries chunks.
  if (!res.ok) {
    return NextResponse.json(json, { status: res.status });
  }
  return NextResponse.json({
    filter,
    freetext,
    deprecated: 'POST /api/search/haystack is deprecated — use /api/search/unified',
    semantic: { results: { results: json.chunks ?? [] } },
    haystack: { results: [], note: 'haystack route folded into unified pipeline' },
  });
}
