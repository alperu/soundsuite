#!/usr/bin/env npx tsx
/**
 * Search Pipeline Benchmark
 *
 * Measures wall-clock time for each stage of the AI search pipeline:
 *   1. Vector search (embedding + LanceDB query + reranking)
 *   2. Pattern search (keyword regex fallback)
 *   3. Context building
 *   4. LLM completion
 *
 * Usage:
 *   npx tsx scripts/benchmark-search.ts [options]
 *
 * Options:
 *   --query "..."         Search query (default: test query)
 *   --provider ollama     AI provider (default: ollama)
 *   --model qwen3.5:9b    Model name (default: qwen3.5:9b)
 *   --host http://...     Server URL (default: http://localhost:3000)
 *   --runs N              Number of runs for averaging (default: 1)
 *   --deep                Use deep search instead of AI search
 *   --report              Write report to docs/search-benchmark.md
 */

const BASE_URL = getArg('--host') || 'http://localhost:3000';
const QUERY = getArg('--query') || 'Who called me camel expert from middle east';
const PROVIDER = getArg('--provider') || 'ollama';
const MODEL = getArg('--model') || 'qwen3.5:9b';
const RUNS = parseInt(getArg('--runs') || '1', 10);
const USE_DEEP = process.argv.includes('--deep');
const WRITE_REPORT = process.argv.includes('--report');
const THINKING = !process.argv.includes('--no-thinking');

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

interface StageResult {
  name: string;
  durationMs: number;
  detail?: string;
}

interface BenchmarkResult {
  query: string;
  provider: string;
  model: string;
  endpoint: string;
  totalMs: number;
  stages: StageResult[];
  sourceCount: number;
  tokenUsage: { inputTokens: number; outputTokens: number };
  answerLength: number;
  error?: string;
}

// ── Stream NDJSON helper ────────────────────────────────────────────

interface TimedEvent {
  event: any;
  timestamp: number;
}

async function streamNdjson(res: Response): Promise<TimedEvent[]> {
  const events: TimedEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push({ event: JSON.parse(line), timestamp: Date.now() });
      } catch { /* skip malformed */ }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      events.push({ event: JSON.parse(buffer), timestamp: Date.now() });
    } catch { /* skip */ }
  }

  return events;
}

// ── AI Search benchmark (NDJSON streaming) ──────────────────────────

async function benchmarkAiSearch(): Promise<BenchmarkResult> {
  const t0 = Date.now();
  const stages: StageResult[] = [];
  let lastStepTime = t0;
  let sourceCount = 0;
  let tokenUsage = { inputTokens: 0, outputTokens: 0 };
  let answerLength = 0;
  let error: string | undefined;

  const stepLabels: Record<string, string> = {
    searching: 'Vector Search (embed + LanceDB + rerank)',
    pattern_searching: 'Pattern Search (keyword regex)',
    building_context: 'Context Building',
    generating: 'LLM Completion',
  };

  try {
    const res = await fetch(`${BASE_URL}/api/search/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        provider: PROVIDER,
        model: MODEL,
        limit: 20,
        searchMode: 'hybrid',
        thinking: THINKING,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    // Stream the response line-by-line to get real per-stage timings
    const events = await streamNdjson(res);
    let prevStep: string | null = null;

    for (const { event, timestamp } of events) {
      if (event.type === 'progress') {
        if (prevStep) {
          stages.push({
            name: stepLabels[prevStep] || prevStep,
            durationMs: timestamp - lastStepTime,
            detail: event.message,
          });
        }
        prevStep = event.step;
        lastStepTime = timestamp;
      }

      if (event.type === 'result') {
        if (prevStep) {
          stages.push({
            name: stepLabels[prevStep] || prevStep,
            durationMs: timestamp - lastStepTime,
          });
        }
        sourceCount = event.data?.sources?.length ?? 0;
        tokenUsage = event.data?.usage ?? tokenUsage;
        answerLength = event.data?.answer?.length ?? 0;
      }

      if (event.type === 'error') {
        error = event.error;
      }
    }
  } catch (err) {
    error = (err as Error).message;
  }

  return {
    query: QUERY,
    provider: PROVIDER,
    model: MODEL,
    endpoint: '/api/search/ai',
    totalMs: Date.now() - t0,
    stages,
    sourceCount,
    tokenUsage,
    answerLength,
    error,
  };
}

// ── Deep Search benchmark (NDJSON streaming) ────────────────────────

async function benchmarkDeepSearch(): Promise<BenchmarkResult> {
  const t0 = Date.now();
  const stages: StageResult[] = [];
  let lastStepTime = t0;
  let sourceCount = 0;
  let tokenUsage = { inputTokens: 0, outputTokens: 0 };
  let answerLength = 0;
  let error: string | undefined;

  const stepLabels: Record<string, string> = {
    decomposing: 'Query Decomposition (LLM)',
    searching: 'Parallel Sub-Query Searches',
    pattern_searching: 'Pattern Search (keyword regex)',
    merging: 'Dedup + Reranking',
    generating: 'Report Generation (LLM)',
  };

  try {
    const res = await fetch(`${BASE_URL}/api/search/deep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: QUERY,
        provider: PROVIDER,
        model: MODEL,
        limit: 20,
        searchMode: 'hybrid',
        thinking: THINKING,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const events = await streamNdjson(res);
    let prevStep: string | null = null;

    for (const { event, timestamp } of events) {
      if (event.type === 'progress' && event.step) {
        if (prevStep) {
          stages.push({
            name: stepLabels[prevStep] || prevStep,
            durationMs: timestamp - lastStepTime,
          });
        }
        prevStep = event.step;
        lastStepTime = timestamp;
      }

      if (event.type === 'result') {
        if (prevStep) {
          stages.push({
            name: stepLabels[prevStep] || prevStep,
            durationMs: timestamp - lastStepTime,
          });
        }
        sourceCount = event.data?.sources?.length ?? 0;
        tokenUsage = event.data?.usage ?? tokenUsage;
        answerLength = event.data?.report?.length ?? event.data?.answer?.length ?? 0;
      }

      if (event.type === 'error') {
        error = event.error;
      }
    }
  } catch (err) {
    error = (err as Error).message;
  }

  return {
    query: QUERY,
    provider: PROVIDER,
    model: MODEL,
    endpoint: '/api/search/deep',
    totalMs: Date.now() - t0,
    stages,
    sourceCount,
    tokenUsage,
    answerLength,
    error,
  };
}

// ── Report generation ───────────────────────────────────────────────

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pctOfTotal(ms: number, totalMs: number): string {
  if (totalMs === 0) return '0%';
  return `${Math.round((ms / totalMs) * 100)}%`;
}

function printResult(r: BenchmarkResult, runNum?: number) {
  const header = runNum !== undefined ? `\n── Run ${runNum + 1} ──` : '';
  if (header) console.log(header);

  if (r.error) {
    console.log(`  ERROR: ${r.error}`);
    return;
  }

  console.log(`  Query:    "${r.query}"`);
  console.log(`  Model:    ${r.provider}/${r.model}`);
  console.log(`  Endpoint: ${r.endpoint}`);
  console.log(`  Total:    ${formatMs(r.totalMs)}`);
  console.log(`  Sources:  ${r.sourceCount}`);
  console.log(`  Tokens:   ${r.tokenUsage.inputTokens} in / ${r.tokenUsage.outputTokens} out`);
  console.log(`  Answer:   ${r.answerLength} chars`);
  console.log('');
  console.log('  Stage Breakdown:');

  const maxNameLen = Math.max(...r.stages.map(s => s.name.length));
  for (const s of r.stages) {
    const bar = '█'.repeat(Math.max(1, Math.round((s.durationMs / r.totalMs) * 40)));
    console.log(`    ${s.name.padEnd(maxNameLen)}  ${formatMs(s.durationMs).padStart(8)}  ${pctOfTotal(s.durationMs, r.totalMs).padStart(4)}  ${bar}`);
  }
}

function generateReport(results: BenchmarkResult[]): string {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const r = results[0]; // Use first run for single-run, or avg for multi-run

  // Average stages across runs
  const avgStages: StageResult[] = [];
  if (results.length > 0 && results[0].stages.length > 0) {
    for (let i = 0; i < results[0].stages.length; i++) {
      const name = results[0].stages[i].name;
      const totalMs = results.reduce((sum, r) => sum + (r.stages[i]?.durationMs ?? 0), 0);
      avgStages.push({ name, durationMs: Math.round(totalMs / results.length) });
    }
  }

  const avgTotal = Math.round(results.reduce((s, r) => s + r.totalMs, 0) / results.length);
  const avgInputTokens = Math.round(results.reduce((s, r) => s + r.tokenUsage.inputTokens, 0) / results.length);
  const avgOutputTokens = Math.round(results.reduce((s, r) => s + r.tokenUsage.outputTokens, 0) / results.length);
  const avgSources = Math.round(results.reduce((s, r) => s + r.sourceCount, 0) / results.length);

  let md = `# Search Pipeline Benchmark Report

Generated: ${now}
Runs: ${results.length}

## Configuration

| Parameter | Value |
|-----------|-------|
| Query | \`${r.query}\` |
| Provider | ${r.provider} |
| Model | ${r.model} |
| Endpoint | ${r.endpoint} |
| Server | ${BASE_URL} |

## Results Summary

| Metric | Value |
|--------|-------|
| Total time | **${formatMs(avgTotal)}** |
| Sources retrieved | ${avgSources} |
| Input tokens | ${avgInputTokens.toLocaleString()} |
| Output tokens | ${avgOutputTokens.toLocaleString()} |
| Tokens/sec | ${avgTotal > 0 ? Math.round(avgOutputTokens / (avgTotal / 1000)) : '?'} tok/s |

## Stage Breakdown

| Stage | Duration | % of Total | Bar |
|-------|----------|-----------|-----|
`;

  for (const s of avgStages) {
    const bar = '█'.repeat(Math.max(1, Math.round((s.durationMs / avgTotal) * 30)));
    md += `| ${s.name} | ${formatMs(s.durationMs)} | ${pctOfTotal(s.durationMs, avgTotal)} | \`${bar}\` |\n`;
  }

  md += `| **Total** | **${formatMs(avgTotal)}** | **100%** | |\n`;

  // Bottleneck analysis
  const sorted = [...avgStages].sort((a, b) => b.durationMs - a.durationMs);
  const bottleneck = sorted[0];
  const bottleneckPct = avgTotal > 0 ? Math.round((bottleneck.durationMs / avgTotal) * 100) : 0;

  md += `
## Bottleneck Analysis

**Primary bottleneck: ${bottleneck.name}** (${formatMs(bottleneck.durationMs)}, ${bottleneckPct}% of total)

`;

  if (bottleneck.name.includes('LLM') || bottleneck.name.includes('Completion') || bottleneck.name.includes('Report')) {
    md += `The LLM completion stage dominates. Possible improvements:
- Check if model is fully loaded in GPU VRAM (\`ollama ps\` — \`size_vram\` should equal \`size\`)
- Use a smaller/faster model (e.g., qwen3.5:4b instead of 9b)
- Reduce context size (fewer sources or shorter chunks)
- Check GPU utilization during inference
`;
  } else if (bottleneck.name.includes('Vector') || bottleneck.name.includes('Search')) {
    md += `The search stage dominates. This includes query embedding + LanceDB search + reranking. Possible improvements:
- Check if embedding model is loaded in GPU
- Check reranker container status (vLLM may be cold-starting)
- Reduce retrieval limit
- Check LanceDB index health
`;
  } else if (bottleneck.name.includes('Rerank')) {
    md += `Reranking dominates. Possible improvements:
- Ensure vLLM reranker container is warm (model loaded)
- Reduce number of candidates sent to reranker
- Check reranker GPU utilization
`;
  }

  // Per-run details
  if (results.length > 1) {
    md += `\n## Per-Run Details\n\n`;
    for (let i = 0; i < results.length; i++) {
      const run = results[i];
      md += `### Run ${i + 1}\n\n`;
      md += `Total: ${formatMs(run.totalMs)} | Sources: ${run.sourceCount} | Tokens: ${run.tokenUsage.inputTokens}/${run.tokenUsage.outputTokens}\n\n`;
      md += `| Stage | Duration |\n|-------|----------|\n`;
      for (const s of run.stages) {
        md += `| ${s.name} | ${formatMs(s.durationMs)} |\n`;
      }
      md += '\n';
    }
  }

  md += `\n---\n*Generated by \`scripts/benchmark-search.ts\`*\n`;
  return md;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('Search Pipeline Benchmark');
  console.log('=========================');
  console.log(`Server:   ${BASE_URL}`);
  console.log(`Query:    "${QUERY}"`);
  console.log(`Model:    ${PROVIDER}/${MODEL}`);
  console.log(`Endpoint: ${USE_DEEP ? '/api/search/deep' : '/api/search/ai'}`);
  console.log(`Thinking: ${THINKING}`);
  console.log(`Runs:     ${RUNS}`);
  console.log('');

  // Check server is up
  try {
    const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
    console.log('Server: OK');
  } catch {
    console.error(`ERROR: Cannot reach server at ${BASE_URL}`);
    console.error('Make sure the dev server is running (npm run dev)');
    process.exit(1);
  }

  const results: BenchmarkResult[] = [];

  for (let i = 0; i < RUNS; i++) {
    if (RUNS > 1) process.stdout.write(`Run ${i + 1}/${RUNS}... `);
    const result = USE_DEEP ? await benchmarkDeepSearch() : await benchmarkAiSearch();
    results.push(result);
    printResult(result, RUNS > 1 ? i : undefined);
  }

  if (WRITE_REPORT) {
    const report = generateReport(results);
    const fs = await import('fs');
    const path = await import('path');
    const reportPath = path.join(process.cwd(), 'docs', 'search-benchmark.md');

    // Ensure docs/ exists
    const docsDir = path.dirname(reportPath);
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

    fs.writeFileSync(reportPath, report);
    console.log(`\nReport written to ${reportPath}`);
  } else {
    console.log('\nTip: Add --report to write results to docs/search-benchmark.md');
  }
}

main().catch(console.error);
