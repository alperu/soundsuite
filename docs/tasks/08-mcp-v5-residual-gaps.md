# MCP v5 residual gaps

**Status:** Implemented (2026-09-05) — operator steps pending · **Effort:** M · **Priority:** Medium-High · **Source:** `docs/MCP-Improvements/REPORT-v5-independent-verification.md`

v5 independently verified v4.1 from outside the process: six of eight v4 items confirmed fixed,
two partial by correct design. What remains is a short tail of gaps plus operator actions on
features that are shipped but inert.

## Correction to the v5 report, established before work started

**R-4 (`structuredContent` absent) is not a code gap.** The installed bridge at
`~/sound-suite-bridge/bridge.mjs` contains zero occurrences of `structuredContent`; the repo copy
(`scripts/mcp-bridge/bridge.mjs`, shipped in `c4cee6f`) contains four. The v5 probe ran through
proxy → *installed* bridge and therefore measured the pre-fix code. Syncing the bridge closes R-4.

This also reorders v5 §4: it places the bridge sync last because "nothing verified in this report
requires it", but R-4 is the bridge-side change, so the sync is what verifies it.

## Work items

| # | Item | Stream | Status |
|---|---|---|---|
| 1 | **R-1** gate `GET /api/mcp/tools` (and siblings) on the same origin check as execute, or declare the catalogue public | A | ✅ every `/api/mcp/*` route incl. job routes |
| 2 | **M-5** raise the execute gate above a browser control: stop trusting a forged leftmost `X-Forwarded-For` | A | ◐ chain/X-Real-IP/Forwarded variants closed; single-value forge **proven unclosable** (Next injects XFF from socket) |
| 3 | **R-3 / 19d456a** bound `tableMarkdown` by `maxCharsPerChunk`; add the pre-cap evidence total to `stats.caps` | B | ✅ + outline model dead-code bug fixed |
| 4 | **SS-3** per-tool tests for the 12 LLM analysis tools | C | ✅ 278 tests; 4 bugs found, 3 fixed (stream E) |
| 5 | **R-5** clean proxy-vs-direct latency measurement | lead | ✅ noise — median proxy 14.7 s vs direct 16.2 s |
| 6 | Bridge sync + proxy restart (closes R-4) | operator | ⏳ |
| 7 | Draft backfill (`--apply`) | operator | ⏳ |
| 8 | Install a small instruct model, pick it on Admin → AI Services | operator | ⏳ (was inert before this round — outline not wired) |
| 9 | `/api/admin/structure-backfill` for `heading_path` / `block_type` coverage | operator | ⏳ |

## Deliberately not done

- **Batched rerank after fusion** (v5 queue 8). v5 §6 answers this: the FIFO exists because vLLM
  batches one rerank per GPU, bounded concurrency only relocates the queue, and the real fix needs
  measurement on hardware not present in this setup. Promotion to a job already removed the timeout
  risk that made the 70 s urgent.

## Binding contracts

File ownership is exclusive.

**A — surface gating.** Owns `src/lib/mcp/execute-auth.ts`, `src/app/api/mcp/execute/route.ts`,
`src/app/api/mcp/tools/route.ts`, `src/app/api/mcp/claude-tools/route.ts`, and any other
`src/app/api/mcp/*` listing route it gates.

**B — evidence caps.** Owns `src/lib/search/gather-evidence.ts`, `src/lib/mcp/research-types.ts`.

**C — tool tests.** Owns `src/lib/mcp/tools/__tests__/**` only. Creates test files; does not modify
tool implementations. If a test reveals a bug, it reports it rather than fixing it.

## Privacy

Synthetic fixtures and queries only. No case numbers, party names, filing titles, or document text.
v5 explicitly redacted live citation values; keep it that way.

## Added mid-round

| # | Item | Stream | Status |
|---|---|---|---|
| 10 | **User requirement:** MCP picks up admin-page model config — `ai.ollamaOutlineModel`, admin pickers for Decompose/Outline, OCR/vision filtered via `details.families` | D | ✅ verified live in Chrome |
| 11 | Fix SS-3 findings #1–#3 (param validation, `{_markdown}` fallback, unguarded returns) gated on stream C's tripwires | E | ✅ 30 tripwires flipped; #4/#5 left failing |

## Outcome

See `docs/MCP-Improvements/REPORT-v5.1-residual-gaps-closed.md`. Typecheck byte-identical to baseline;
914 tests pass across mcp/search/api-mcp/db + admin panel (was 579); ingestion at its 63-failure
baseline; lint clean.

New open items: `/api/config` GET returns stored API keys ungated (P1); second MCP surface on `:3001`
unprobed; SS-3 #4/#5; absent-`profile` bypass in `ai-helper`.
