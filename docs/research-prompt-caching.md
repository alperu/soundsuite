# Research: prompt caching for Sound Suite's direct Anthropic traffic

**Date:** 2026-08-07 · task #14
**Trigger:** Anthropic console insight — *"Your prompt cache hit rate is low. Caching repeated
content like system prompts could save up to 48% of direct API spend."* Observed most on
searches. (Claude Code traffic is excluded — it manages caching automatically.)
**Method:** codebase audit agent (every direct LLM call site, code-verified file:line) with
the caching rules cross-checked against the Anthropic prompt-caching reference
(docs.anthropic.com → Build with Claude → Prompt caching). A second mechanics agent
stalled and was not waited on; the rules table below reflects the audit agent's verified
numbers.

## Headline findings

1. **`cache_control` appears nowhere in the codebase.** The app has never opted in; the low
   hit rate is fully expected, not a regression.
2. **The intuitive fix is wrong.** "Cache the system prompts" buys nothing: every static
   system prompt measures ~250–380 tokens (DECOMPOSE 1302 chars, OUTLINE 1385, REPORT 1143,
   SECTION 944, RLM 1314) — all far below the model-dependent minimum cacheable prefix
   (512 tokens on Fable 5; 1024 on Opus 4.8/Sonnet 4.x; 2048 on Opus 4.7; 4096 on
   Opus 4.6/4.5 and Haiku 4.5). Marking them silently does nothing.
3. **RLM mode is not Anthropic traffic.** `stream-rlm.ts` POSTs to a locally-resolved vLLM
   host (`/v1/chat/completions`, rlm-qwen3-8b) — it cannot affect the console metric and
   `cache_control` does not apply. (vLLM has its own automatic prefix caching server-side.)
4. **The real win is the deep-search multi-pass section loop.** `baseUserContent`
   (deep-search.ts:1120) — history → question → intent → sub-queries → up to 120K chars of
   document excerpts (~32K tokens) — is a byte-stable prefix of every per-section call
   (`sectionUserContent` at :1218 is a pure append). A 4-section report currently pays for
   that prefix 5 times at full price; with one cache breakpoint it becomes 1 write (1.25×)
   + N reads (0.1×) ≈ **~49% input-token reduction for that stage** — matching the
   console's ~48% estimate almost exactly.

## Mechanics reference (rules that matter here)

| Rule | Value |
| --- | --- |
| Opt-in | per content block: `{ type: 'text', text, cache_control: { type: 'ephemeral' } }` |
| Breakpoints | up to 4 per request; prefix up to each breakpoint is cached |
| Prefix order | `tools` → `system` → `messages`; ANY change upstream of a breakpoint invalidates (incl. tool defs, model, jsonMode-forced tools) |
| Minimum prefix | model-dependent: 512 (Fable 5) / 1024 (Opus 4.8, Sonnet 4.x) / 2048 (Opus 4.7) / 4096 (Opus 4.6/4.5, Haiku 4.5) tokens — below it, marking is a silent no-op |
| TTL | 5 min default (write 1.25×), `ttl: '1h'` extended (write 2×); reads 0.1×; TTL refreshes on hit |
| Beta header | none — prompt caching is GA |
| Verification | `usage.cache_creation_input_tokens` / `usage.cache_read_input_tokens` (in `message_start`); `input_tokens` is the UNCACHED remainder only |

**When caching is NOT worth it:** prompts under the minimum floor; true one-shot calls with
unique content (summarizer per-document previews, tag-fill per-filing pairs, the ten MCP
analysis tools' few-hundred-token schemas — all audited, all below the floor or unique).

## Call-site inventory (audited)

- **All Anthropic traffic funnels through ONE function** — `streamWithAnthropic`
  (`src/lib/ai/ai-provider.ts:616`; `completeAI` routes into it too). SDK `@anthropic-ai/sdk`
  ^0.74.0. No raw fetches to api.anthropic.com exist.
- **Deep search multi-pass** (`deep-search.ts:1096`): 1 decomposition (:217, tiny) +
  1 outline (:1137, jsonMode) + N section calls (:1231) sharing `baseUserContent`. NOTE: the
  outline call does NOT share a cacheable prefix with the section calls today — different
  system prompt AND a jsonMode-forced tool definition ahead of it in the prefix. The win is
  N-way across sections, not N+1.
- **Deep search single-pass** (`generateReport` :874): one call per search — benefits only
  across follow-up turns, and only if retrieval returns a byte-identical source set (it
  re-runs per turn today, so it won't).
- **AI mode** (`ai/route.ts:242`): excerpts live INSIDE the system prompt (~3K tokens);
  changes every turn with retrieval. Static part alone is under the floor.
- **Ingestion/MCP tools**: summarizer (:96), tag-fill (:332), ten analysis tools — static
  parts under the floor, variable parts unique. Not worth building.

## What breaks prefix stability today (fix regardless)

1. `ai-helper.ts:144` appends `JSON_REINFORCEMENT` to the system prompt **on the retry path
   only** — a retried call can never reuse its first attempt's prefix.
2. `getAvailableProvider()` (`ai-helper.ts:38`) can silently resolve a different model than
   the UI selected — caches are model-scoped, so fallback traffic writes a separate,
   never-hit namespace.
3. Dynamic-before-static ordering in `baseUserContent` (history/question before the big
   excerpt block): harmless within one search, guarantees zero reuse across searches.
4. (Good news: no timestamps/UUIDs/request-ids anywhere in prompt prefixes.)

## Implementation plan (ranked)

| # | Change | Where | Effort | Expected effect |
| --- | --- | --- | --- | --- |
| 0 | **Prerequisite:** let `AIMessage.content` carry content blocks and forward them (system + messages) in `streamWithAnthropic` | `ai-provider.ts:12`, `:631-637`, `:686`, `:770` | S | none alone; unlocks all |
| 1 | **Breakpoint after `baseUserContent` in the section loop** — split the user message into `[shared prefix + cache_control][per-section suffix]`, 5-min TTL | `deep-search.ts:1218` → `:1231` | S | **~49% of multi-pass input tokens** — the console's estimate |
| 2 | Log `cache_creation_input_tokens` / `cache_read_input_tokens` next to existing counters (message_start/delta) so hits are verifiable | `ai-provider.ts:611` area | S | measurement; catches silent invalidators |
| 3 | Fix retry-path prefix drift (JSON_REINFORCEMENT as a SUFFIX message, not a system mutation) + pin model resolution | `ai-helper.ts:144`, `:38` | S | protects hit rate |
| 4 | Unify outline+section prompts (common system, pass-specific instructions in the suffix; drop jsonMode on outline or accept the split) → N+1-way sharing | `deep-search.ts:1137` | M | one more full-prefix read per search |
| 5 | Cross-turn caching for AI mode / single-pass — requires stabilizing retrieval so the excerpt block is byte-identical across follow-ups | product change | M/L | measure before building |

**TTL choice:** the section loop completes in seconds → default 5-minute TTL; the 1-hour
TTL's 2× write premium buys nothing here.

**Cost-dashboard caveat:** after enabling, `input_tokens` reports only the uncached
remainder — dashboards keyed on it alone will overstate the savings; total prompt size is
`input + cache_creation + cache_read`.

## Answering the operator's question directly

*"This happens when I do a search for the first time — is there any API improvement?"*
The first call of any search always pays the cache **write**; savings land on the calls
that follow. Today none of the 5–15 calls inside one deep search reuse anything. Item 1
makes the N section calls reuse the ~32K-token excerpt block within the same search —
that's where the console's 48% lives. Repeat searches within 5 minutes additionally reuse
whatever is still warm, but intra-search reuse is the reliable, structural win.
