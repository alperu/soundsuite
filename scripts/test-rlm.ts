#!/usr/bin/env tsx
/**
 * test-rlm.ts — standalone closed-loop test of the RLM tool-use path.
 *
 * This script lives outside Next.js so it talks to the master via HTTP
 * (to discover the ss-rlm endpoint) and then talks DIRECTLY to vLLM's
 * /v1/chat/completions on the resolved sidecar. It then drives the same
 * tool-use loop runRlmWithTools() does in the master, with a stub
 * executor returning fake chunks, so we can verify whether:
 *
 *   1. The fleet has an ss-rlm sidecar with the container in 'running' state
 *   2. vLLM accepts our tool-calling request (no HTTP 400 / 500)
 *   3. The model emits tool_calls in any recognizable shape
 *   4. The recursion actually loops (multi-round tool calls)
 *   5. The model eventually stops calling tools and produces a final answer
 *
 * Usage:
 *   npx tsx scripts/test-rlm.ts "your question here"   # custom query
 *   npx tsx scripts/test-rlm.ts                        # uses Torrez default
 *
 * Environment:
 *   FLEET_URL  default http://localhost:3000
 *   RLM_HOST   override sidecar hostname (skip fleet discovery)
 *   RLM_PORT   default 8100
 */

const FLEET_URL = process.env.FLEET_URL ?? 'http://localhost:3000';
const RLM_PORT = Number(process.env.RLM_PORT ?? 8100);
const HOST_OVERRIDE = process.env.RLM_HOST;

const QUERY = process.argv.slice(2).join(' ').trim()
  || 'Check Torrez changing statements on Trust fund specially on May 13 2026 recorders records.';

const INITIAL_EXCERPTS = [
  { cite: '03-25-00905-CV 1 Supp. RR 20', text: 'Torrez admitted "this fraud" existed regarding trust funds on September 10, 2025.' },
  { cite: 'CR 1265', text: 'Successor counsel J. Scott Milner told the court "there is no fraud" on September 24, 2025.' },
  { cite: 'FINDING 15', text: 'Torrez testified inheritance was placed in a trust fund to maintain its separate property character (June 20, 2025).' },
  { cite: 'Exhibit P-11', text: 'Reference to Torrez false testimony about trust accounts in Turkey.' },
  { cite: 'Exhibit P-35', text: 'Additional reference to false testimony about Turkish trust accounts.' },
];

const SYSTEM_PROMPT = `You are an evidence-gathering assistant. The user has a research question. Your job is to call the query_case_knowledge tool 1–3 times to fetch any additional excerpts you think are needed beyond the initial set already in your context. Do NOT write a full report. Once you have enough evidence, respond briefly (1–2 sentences) confirming you're done.`;

const USER_CONTENT = `## Research Question
${QUERY}

## Initial Excerpts (${INITIAL_EXCERPTS.length} sources)

${INITIAL_EXCERPTS.map(e => `[${e.cite}]\n${e.text}`).join('\n\n---\n\n')}

If you need more evidence, call query_case_knowledge with a focused sub-query. Otherwise reply briefly that you have enough.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'query_case_knowledge',
      description: 'Semantic + keyword search over indexed court documents. Returns ranked excerpts.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Sub-query, under 20 words.' },
          limit: { type: 'integer', description: 'Max excerpts to return.', default: 20 },
        },
        required: ['query'],
      },
    },
  },
];

// ─── Inline fallback parser (mirror of src/lib/ai/stream-rlm.ts) ────────────

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

function extractFallbackToolCalls(content: string, tools: typeof TOOLS, round: number): ToolCall[] {
  const out: ToolCall[] = [];
  let idx = 0;
  // Qwen XML: <tool_call><function=NAME><parameter=K>V</parameter>…</function></tool_call>
  const qwenXml = /<tool_call>\s*<function\s*=\s*([A-Za-z_][\w-]*)\s*>([\s\S]*?)<\/function>\s*<\/tool_call>/g;
  const paramRe = /<parameter\s*=\s*([A-Za-z_][\w-]*)\s*>([\s\S]*?)<\/parameter>/g;
  let qm: RegExpExecArray | null;
  while ((qm = qwenXml.exec(content)) !== null) {
    const fnName = qm[1];
    if (!tools.some(t => t.function.name === fnName)) continue;
    const args: Record<string, unknown> = {};
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(qm[2])) !== null) {
      const key = pm[1];
      const raw = pm[2].trim();
      if (/^-?\d+(?:\.\d+)?$/.test(raw)) args[key] = Number(raw);
      else if (raw === 'true') args[key] = true;
      else if (raw === 'false') args[key] = false;
      else if (raw === 'null') args[key] = null;
      else args[key] = raw;
    }
    out.push({ id: `fallback-${round}-${idx++}`, type: 'function', function: { name: fnName, arguments: JSON.stringify(args) } });
  }
  // Hermes XML
  const hermes = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = hermes.exec(content)) !== null) {
    try {
      const j = JSON.parse(m[1]);
      if (j && typeof j.name === 'string' && tools.some(t => t.function.name === j.name)) {
        out.push({ id: `fallback-${round}-${idx++}`, type: 'function', function: { name: j.name, arguments: JSON.stringify(j.arguments ?? {}) } });
      }
    } catch { /* skip */ }
  }
  // Pythonic positional
  for (const t of tools) {
    const name = t.function.name;
    const re = new RegExp(`\\b${name}\\s*\\(\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1\\s*\\)`, 'g');
    while ((m = re.exec(content)) !== null) {
      out.push({ id: `fallback-${round}-${idx++}`, type: 'function', function: { name, arguments: JSON.stringify({ query: m[2] }) } });
    }
  }
  // Pythonic kwargs (single tool call form)
  for (const t of tools) {
    const name = t.function.name;
    const re = new RegExp(`\\b${name}\\s*\\(\\s*([a-zA-Z_]\\w*\\s*=\\s*[^)]+)\\)`, 'g');
    while ((m = re.exec(content)) !== null) {
      const args: Record<string, unknown> = {};
      const body = m[1];
      const kw = /([a-zA-Z_]\w*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?\d+(?:\.\d+)?|true|false|null|\[[^\]]*\]|\{[^}]*\}|[A-Za-z_]\w*)/g;
      let mm: RegExpExecArray | null;
      while ((mm = kw.exec(body)) !== null) {
        const k = mm[1];
        let v: unknown = mm[2];
        if (typeof v === 'string' && (v.startsWith('"') || v.startsWith("'"))) v = v.slice(1, -1);
        else if (typeof v === 'string' && /^-?\d/.test(v)) v = Number(v);
        else if (v === 'true') v = true;
        else if (v === 'false') v = false;
        else if (v === 'null') v = null;
        args[k] = v;
      }
      // Skip if positional regex already caught this call site
      if (!out.some(c => c.function.name === name && c.function.arguments.includes(String(args.query ?? '')))) {
        out.push({ id: `fallback-${round}-${idx++}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
      }
    }
  }
  return out;
}

// ─── Stub tool executor — pretends to be the master's tool registry ─────────

let stubCallCount = 0;
async function stubExecutor(toolName: string, args: Record<string, unknown>) {
  stubCallCount += 1;
  if (toolName !== 'query_case_knowledge') return { ok: false, content: `Unknown tool: ${toolName}`, chunkCount: 0 };
  const sub = typeof args.query === 'string' ? args.query : '(none)';
  const fakeChunks = [
    { cite: `STUB-${stubCallCount}-A`, text: `Stub re "${sub}": Torrez identified trust origin as Turkish inheritance.` },
    { cite: `STUB-${stubCallCount}-B`, text: `Stub re "${sub}": May 13 2026 cross-examination contradicts earlier deposition.` },
    { cite: `STUB-${stubCallCount}-C`, text: `Stub re "${sub}": Bank records show no inheritance transfer matching the claim.` },
  ];
  return {
    ok: true,
    content: fakeChunks.map(c => `[${c.cite}]\n${c.text}`).join('\n\n---\n\n'),
    preview: `${fakeChunks.length} stub excerpts for "${sub.slice(0, 40)}"`,
    chunkCount: fakeChunks.length,
  };
}

// ─── Discover the ss-rlm endpoint from the live fleet API ──────────────────

async function discoverRlmEndpoint(): Promise<{ endpoint: string; host: string; hostname: string }> {
  if (HOST_OVERRIDE) {
    console.log(`[1] using RLM_HOST=${HOST_OVERRIDE} override (skipping fleet discovery)`);
    return { endpoint: `http://${HOST_OVERRIDE}:${RLM_PORT}`, host: HOST_OVERRIDE, hostname: HOST_OVERRIDE };
  }
  console.log(`[1] GET ${FLEET_URL}/api/admin/gpu-fleet`);
  const r = await fetch(`${FLEET_URL}/api/admin/gpu-fleet`, { signal: AbortSignal.timeout(5000) });
  const j = await r.json() as { sidecars?: Array<any> };
  const sidecars = j.sidecars ?? [];
  for (const s of sidecars) {
    if (s.status !== 'connected') continue;
    const rlm = s.sidecarStatus?.containers?.rlm;
    if (!rlm || rlm.status !== 'running') continue;
    if (rlm.image === 'dmr' || rlm.image === 'host-ollama' || rlm.image === 'docker-model-runner') continue;
    const url = new URL(s.url);
    return { endpoint: `http://${url.hostname}:${RLM_PORT}`, host: url.hostname, hostname: s.hostname ?? url.hostname };
  }
  throw new Error('no sidecar in fleet with rlm.status===running on a real vLLM image');
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log('───────────────────────────────────────────────────────────────');
  console.log('  RLM closed-loop test');
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  query:           ${QUERY}`);
  console.log(`  initial sources: ${INITIAL_EXCERPTS.length}`);
  console.log(`  tool stub:       returns 3 fake chunks per call`);
  console.log();

  // Step 1: discover the endpoint
  let endpoint: string, host: string, hostname: string;
  try {
    ({ endpoint, host, hostname } = await discoverRlmEndpoint());
    console.log(`  ✓ endpoint=${endpoint} sidecar=${hostname}`);
  } catch (err) {
    console.error(`  ✗ ${(err as Error).message}`);
    process.exit(2);
  }
  console.log();

  // Step 2: connectivity probe
  console.log(`[2] GET ${endpoint}/v1/models`);
  try {
    const r = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(5000) });
    const t = await r.text();
    console.log(`  ✓ HTTP ${r.status} (${t.length} chars). Preview: ${t.slice(0, 180)}`);
  } catch (err) {
    console.error(`  ✗ ${(err as Error).message}`);
    process.exit(3);
  }
  console.log();

  // Step 3: drive the tool-use loop manually
  console.log('[3] tool-use loop:');
  console.log();
  const messages: Array<any> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_CONTENT },
  ];
  const maxRounds = 4;
  let totalInput = 0, totalOutput = 0;
  let toolCallsTotal = 0, fallbackHits = 0, finalContent = '';

  for (let round = 1; round <= maxRounds; round++) {
    const roundT0 = Date.now();
    const promptChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    console.log(`  [round ${round}] POST /v1/chat/completions promptChars=${promptChars} messages=${messages.length}`);
    let res: Response;
    try {
      res = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mit-oasys/rlm-qwen3-8b-v0.1',
          messages,
          tools: TOOLS,
          tool_choice: 'auto',
          max_tokens: 1024,
          temperature: 0.3,
          stream: false,
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      console.error(`  ✗ fetch failed (${Date.now() - roundT0}ms): ${(err as Error).message}`);
      process.exit(4);
    }
    if (!res.ok) {
      const body = await res.text();
      console.error(`  ✗ HTTP ${res.status}: ${body.slice(0, 400)}`);
      process.exit(5);
    }
    const j = await res.json() as any;
    const elapsed = Date.now() - roundT0;
    const msg = j.choices?.[0]?.message ?? {};
    const usage = j.usage ?? {};
    totalInput += usage.prompt_tokens ?? 0;
    totalOutput += usage.completion_tokens ?? 0;

    let toolCalls: ToolCall[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    console.log(`  [round ${round}] response elapsed=${elapsed}ms vllm_tool_calls=${toolCalls.length} content_chars=${(msg.content ?? '').length} usage=${JSON.stringify(usage)}`);

    if (toolCalls.length === 0 && typeof msg.content === 'string' && msg.content.length > 0) {
      const fb = extractFallbackToolCalls(msg.content, TOOLS, round);
      if (fb.length > 0) {
        fallbackHits += 1;
        console.log(`  [round ${round}] ⚠  fallback parser extracted ${fb.length} call(s) — vLLM parser missed. Content preview: ${msg.content.slice(0, 160).replace(/\s+/g, ' ')}`);
        toolCalls = fb;
      } else {
        console.log(`  [round ${round}] no tool calls and no fallback hits — treating as final answer.`);
        console.log(`  [round ${round}] FINAL CONTENT: ${msg.content.slice(0, 800)}${msg.content.length > 800 ? '…' : ''}`);
        finalContent = msg.content;
        break;
      }
    }

    if (toolCalls.length === 0) {
      console.log(`  [round ${round}] no content either — exiting`);
      break;
    }

    toolCallsTotal += toolCalls.length;
    messages.push({ role: 'assistant', content: typeof msg.content === 'string' ? msg.content : '', tool_calls: toolCalls });

    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
      console.log(`  [round ${round}]   → ${call.function.name}(${JSON.stringify(args).slice(0, 160)})`);
      const result = await stubExecutor(call.function.name, args);
      console.log(`  [round ${round}]   ← ok=${result.ok} chunks=${result.chunkCount} preview="${(result.preview ?? '').slice(0, 60)}"`);
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: result.content });
    }
  }

  console.log();
  console.log('───────────────────────────────────────────────────────────────');
  console.log('Summary');
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  elapsed:        ${Date.now() - t0} ms`);
  console.log(`  tool calls:     ${toolCallsTotal}`);
  console.log(`  fallback hits:  ${fallbackHits}`);
  console.log(`  stub calls:     ${stubCallCount}`);
  console.log(`  tokens:         ${totalInput} in + ${totalOutput} out`);
  console.log(`  final chars:    ${finalContent.length}`);
  console.log();

  if (toolCallsTotal === 0 && finalContent.length === 0) {
    console.log('VERDICT: ✗ RLM produced nothing useful. Endpoint reachable but neither tool calls nor content.');
    process.exit(1);
  }
  if (toolCallsTotal === 0) {
    console.log('VERDICT: ⚠  RLM answered directly without calling tools. Either initial excerpts sufficed,');
    console.log('         or the model isn\'t emitting tool-call shapes the parser/fallback can detect.');
    return;
  }
  if (fallbackHits > 0) {
    console.log(`VERDICT: ⚠  vLLM\'s pythonic parser missed ${fallbackHits} round(s) — master\'s fallback parser`);
    console.log('         saved the run. Worth investigating whether the parser flag is wrong or vLLM has a bug.');
  } else {
    console.log(`VERDICT: ✓ vLLM tool-call parser working. ${toolCallsTotal} call(s) extracted cleanly, recursive loop ran.`);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(99);
});
