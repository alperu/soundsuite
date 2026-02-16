import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/admin/rerank-test
 * Test vLLM reranking connection by sending a small rerank request.
 * Body: { host: string, model: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { host, model } = (await request.json()) as { host: string; model: string };

    if (!host) {
      return NextResponse.json({ valid: false, error: 'Host URL is required' }, { status: 400 });
    }
    if (!model) {
      return NextResponse.json({ valid: false, error: 'Model name is required' }, { status: 400 });
    }

    const url = `${host.replace(/\/+$/, '')}/v1/rerank`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        query: 'What is the legal standard for summary judgment?',
        documents: [
          'Summary judgment is appropriate when there is no genuine dispute of material fact.',
          'The weather today is sunny with a high of 75 degrees.',
        ],
        top_n: 2,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return NextResponse.json({
        valid: false,
        error: `vLLM returned ${res.status}: ${text.slice(0, 200)}`,
      });
    }

    const data = await res.json();
    const results = data.results;

    if (!Array.isArray(results) || results.length === 0) {
      return NextResponse.json({
        valid: false,
        error: 'Unexpected response format — no results array',
      });
    }

    const topScore = results[0]?.relevance_score ?? results[0]?.score ?? 0;

    // Validate score ordering: the relevant legal document (index 0) should
    // score higher than the irrelevant weather sentence (index 1).
    // Results come back sorted by score desc, so check which original doc index won.
    const topIdx = results[0]?.index ?? 0;
    const bottomIdx = results[1]?.index ?? 1;
    const bottomScore = results[1]?.relevance_score ?? results[1]?.score ?? 0;

    if (topIdx === 1 || (topIdx === 0 && bottomIdx === 1 && bottomScore > topScore)) {
      // The irrelevant document scored higher — scores are inverted
      return NextResponse.json({
        valid: true,
        warning: true,
        message:
          `Reranker connected but scores appear inverted (relevant=${topIdx === 1 ? bottomScore.toFixed(4) : topScore.toFixed(4)}, ` +
          `irrelevant=${topIdx === 1 ? topScore.toFixed(4) : bottomScore.toFixed(4)}) — ` +
          `the vLLM hf_overrides workaround may not be applied. ` +
          `Recreate the container or add --hf-overrides for Qwen3-Reranker models.`,
      });
    }

    return NextResponse.json({
      valid: true,
      message: `Model "${model}" is working. Top relevance score: ${topScore.toFixed(4)}`,
    });
  } catch (error: any) {
    const msg = error?.message || String(error);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return NextResponse.json({
        valid: false,
        error: 'Connection refused — is vLLM running?',
      });
    }
    if (msg.includes('TimeoutError') || msg.includes('aborted')) {
      return NextResponse.json({
        valid: false,
        error: 'Request timed out — vLLM may still be loading the model',
      });
    }
    return NextResponse.json(
      { valid: false, error: msg.slice(0, 200) },
      { status: 500 },
    );
  }
}
