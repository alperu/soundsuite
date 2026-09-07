# API surface guard — v6 fixes

**Status:** Implemented (2026-09-07) · **Effort:** M · **Priority:** P1 · **Source:** `docs/MCP-Improvements/REPORT-v6-independent-retest.md`

v6 re-tested every v5.1 claim independently: 24 of 25 reproduce. The one material gap is outside the
MCP surface: **`GET /api/config` returns four live provider API keys in plaintext, from any origin
that can reach the port.** Several `/api/admin/*` routes and `POST /api/search/deep` are likewise
outside the `/api/mcp/*` guard.

## Work items

| # | Item | Stream | Status |
|---|---|---|---|
| 1 | Mask API keys on `GET /api/config` (return `configured` + last-4, never the value) | A | ✅ + `?key=<secret>` path (a second leak) now 403 |
| 2 | Extend the origin/auth guard past `/api/mcp/*` — `/api/config`, `/api/admin/*`, `/api/search/deep`, `/api/docs/info` — **without** breaking the sidecar, the dashboard, or the admin login | A | ✅ + `/api/cases` GET/POST; sidecar routes exempt with regression guard (gpu-fleet was briefly gated — caught and fixed) |
| 3 | SS-3 #4 item-level validation on all 10 LLM tools (10 tripwires) | B | ✅ shared validator; drop-vs-reject rule; `stats.itemsDropped` |
| 4 | SS-3 #5 confidence coercion — unscored findings kept, string confidences rejected/coerced explicitly (2 tripwires) | B | ✅ `confidence: number \| null` |
| 5 | Pin the `LLM_PARSE_ERROR` log redaction with a test | B | ✅ |
| 6 | Sync bridge + restart proxy (closes R-4) | lead | ✅ `structuredContent` verified through the proxy |
| 7 | Raw-socket `Host` probe (the one unverified matrix row) | lead | ✅ 401 |
| 8 | Clean re-measure of `deep` — is the 17 % real? | lead | ✅ No — retrieve varied 13× (10.6 s → 141.6 s) between back-to-back runs |
| 9 | Draft backfill `--apply` | lead / operator | ✅ applied — 29 filed / 0 draft / 67 unknown |

## Constraints established before work started

- **The sidecar calls `/api/admin/gpu-fleet` cross-host** (`sideCar/src`, `public/sideCar/scripts`),
  plus `/api/health`, `/api/masters`, `/api/status`, `/api/embeddings`. An origin gate on
  `/api/admin/*` must exempt sidecar-facing routes or authenticate them by key, never by origin alone.
- An admin session system exists (`src/lib/admin/auth.ts`, `adminUser`, `/api/admin/auth/*`) and is
  already used by `cloudflare`, `sessions`, `auth/me`. `system-info`, `action-logs`, `ai-keys` are
  not behind it. Prefer **requiring the admin session** on admin routes over origin heuristics —
  origin is a browser control (v5.1 §4), a session is an access control.
- `GET /api/config` is consumed by seven client components (`toolbar`, `admin-settings`,
  `processing-progress`, `admin-ai-services`, `admin-dashboard`, `admin-reranking-settings`, the
  draft page). Masking keys must not break any of them; the settings UI that *edits* keys must still
  work (write-only semantics: empty/absent means "leave unchanged").
- `/api/admin/ai-keys` already returns provider names + configured flags — the masking shape to copy.

## Binding contracts

**A** owns `src/app/api/config/route.ts`, `src/lib/db/config.ts` (read-side masking only),
`src/lib/mcp/execute-auth.ts` (generalise `guardMcpRoute` → a route guard usable outside MCP, or a
sibling), `src/app/api/admin/**` route files it gates, `src/app/api/search/deep/route.ts`,
`src/app/api/docs/info/route.ts`, `src/lib/admin/auth.ts` if needed, and their tests.

**B** owns `src/lib/mcp/tools/*.ts` (the 10 LLM tool implementations), `src/lib/mcp/tools/ai-helper.ts`,
`src/lib/mcp/tools/base-tool.ts`, and `src/lib/mcp/tools/__tests__/**`.

No overlap. Neither touches `gather-evidence.ts`, `routing-defaults.ts`, or the bridge.

## Privacy

Synthetic fixtures and probes only. **Never read a live key value into a report, log, test, or the
conversation** — v6 classified keys by prefix and length only; keep that discipline.

## Outcome

See `docs/MCP-Improvements/REPORT-v6.1-surface-guard-and-discovery.md`.
