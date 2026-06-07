# Large-File Decomposition — SoundSuite

**Status:** design / proposal
**Scope:** `src/app/api/haystack/[op]/route.ts` (primary) + 4 oversized secondary files
**Origin:** Spun out of evaluating the `mcpfantom` Fastify-migration plan against SoundSuite. SoundSuite is Next.js 16 App Router (no Express/Fastify) and already has file-scoped routing + worker pools (`worker-pool-service.ts`, `parsing-worker-manager.ts`, `p-queue`). So the Fastify framework migration does **not** apply here. The one transferable idea is the *decomposition mindset* for the few genuinely oversized files — done the Next.js way.

---

## Guiding principle

Split fat units into per-feature modules with explicit, typed validation — **without** changing public URL contracts or the existing concurrency model. Prefer mechanical "move to `lib/`" steps that preserve behavior over rewrites.

---

## Part 1 — `api/haystack/[op]/route.ts` (1,969 lines)

### The real diagnosis (not what it looks like)

It *looks* like a monolithic router, but it isn't quite. There are only **9 dispatched ops** via a single `switch (op)` in `dispatchHaystack()` (line ~1935). The `GET`/`POST`/`PUT` exports are 3-line shims to that one function. Seven ops are trivial (~95 lines total); the file's mass is two heavy clusters **plus ~1,400 lines of op-agnostic domain helpers that don't belong in a route file at all.**

| `op` | Handler | Lines | Cluster |
|------|---------|-------|---------|
| `about`,`ops`,`libs`,`defs`,`filetypes`,`close` | `opAbout`…`opClose` | ~95 total | Metadata (trivial) |
| `nav` | `opNav` | 187–198 | Navigation |
| `read` | `opRead` (+`opReadCourt`) | 937–1129 | **Read pipeline** |
| `commit` | `opCommit` → `commitEntity` | 1609–1806 | **Write pipeline** |

The ~1,400 lines of helpers that should move to `src/lib/haystack/...`:
- **Ref/label machinery**: `synthesizeRefsFromColumns` (273–418), `inlineRefLabels` (817–926), `computeDis` (575–652), `formatLabelFor`, `deriveOrigin`/`applyOrigin`, `tableForKind`, `refToId`/`refValueToId`, and the **module-level label cache** (`cacheGet`/`cacheSet`/`invalidateLabelCache`, 419–459).
- **Filing auto-materializers**: `ensureMotionForFiling`, `ensureMotionAttachmentForFiling`, `ensureReportersRecordForFiling`, `ensureClerksRecordForFiling` (1219–1480, ~260 ln).
- **Write machinery**: `commitEntity` (146 ln), `splitPatch`, `applyCaseSideEffects`, `prismaErrToGrid` (1593–1754, ~160 ln), `recoverTagObject`, `filterToTagFields`, `validateCasePath`.

### Cross-cutting concerns (today, all inline)
- **Auth**: `checkAuth()` (53–82) — `HAYSTACK_API_KEY ?? MCP_API_KEY`, parses `Authorization: BEARER authToken=<tok>`.
- **Content negotiation**: `rejectZinc()` (84–96) — 415 on `text/zinc`.
- **Body parse**: inline (1918–1932) — unwraps Hayson `{_kind:'grid', rows:[…]}` → `rows[0]`.
- **Validation**: **manual only — no schema lib.** Each op hand-pulls params (`opRead` at 938–946).
- **Errors**: one `try/catch` around the switch → `errGrid()`; plus `prismaErrToGrid()` for writes.
- **Responses**: Hayson strings via `jsonResponse()` / grid builders from `@/lib/legal/hayson`.

### Duplication to collapse
The same `switch(table)` over the entity set (`Motion`/`MotionEvent`/`Person`/`Hearing`/`Case`/`ClerksRecord`/`ReportersRecord`/…) is **repeated 5×** (lines 278, 493, 585, 868, 1017). Collapse into one entity-table config object. `ClerksRecord`/`ReportersRecord` are repeatedly `as any` because they're missing from the Kysely type map — fix once in the config.

### Caller / URL contract (verified)
Every caller uses **path-style** `/api/haystack/<op>` or `/api/haystack-proxy/<op>` — so real sub-routes would be URL-compatible. Contracts that MUST be preserved:
- `commitEntity` is **imported directly** (not over HTTP) by `api/cases/[id]/fill-haystack-tags/route.ts:5` and `.../revert/route.ts:36` → keep it exported.
- `dispatchHaystack` is imported by the same-origin proxy `api/haystack-proxy/[op]/route.ts` (`{skipAuth:true}`) → keep it exported.
- Typed client `src/lib/haystack-client/index.ts` (`BASE='/api/haystack-proxy'`, path-style `read`/`commit`/`defs`) and frontend fetch sites (`case-management/layout.tsx:405`, `case/tag-panel.tsx`, `case/ref-picker.tsx`, `search/active-token-suggestions.tsx`, `lib/personas/client.ts:285`, `lib/courts/client.ts:149`).
- The **MCP server does NOT call this route** — `/api/search/haystack` and `read-grid` are separate. No MCP impact.

### Recommended approach — Option B → C (registry first, sub-routes later if needed)

`zod` is **not** currently a dependency — adding it is a prerequisite for any typed validation.

**Option B (recommended first):** keep the `[op]` route, extract a typed handler registry. Contract-stable (same URLs, same `dispatchHaystack`/`commitEntity` exports), low risk, mostly mechanical.

Target layout:
```
src/lib/haystack/
  cache.ts          # label cache as a real singleton (NOT module-local in a route)
  refs.ts           # synthesizeRefsFromColumns, inlineRefLabels, computeDis, formatLabel…
  entities.ts       # ONE entity-table config replacing the 5 duplicated switch(table)
  commit.ts         # commitEntity, splitPatch, applyCaseSideEffects, prismaErrToGrid…
  ensure-filing.ts  # ensure*ForFiling materializers
  handlers/
    read.ts         # { schema: zod, handle(ctx) }
    commit.ts
    meta.ts         # about/ops/libs/defs/filetypes/close
    nav.ts
  dispatch.ts       # Record<Op, Handler> map + withAuth + withValidation(schema)

src/app/api/haystack/[op]/route.ts   # shrinks to: rejectZinc → auth → parse → dispatch[op]
```
After extraction the route file is just auth + parse + dispatch (~100 lines). `commitEntity` re-exported from `lib/haystack/commit.ts`.

**Option A (real per-op sub-routes, `haystack/read/route.ts` etc.):** URL-compatible but higher risk — splits the shared mutable label cache across route-module instances (correctness trap) and forces the proxy to be reworked per-op. Do **not** lead with this.

**Option C (hybrid, end state):** do B to de-risk; later promote hot ops (`read`) to real sub-routes only if they need independent caching/runtime config. Best balance of contract-stability and file-locality.

### Phased plan (incremental, behavior-preserving)
1. **Add `zod`.** Move the **label cache** to `lib/haystack/cache.ts` as a singleton (de-risks every later step).
2. Lift domain helpers (`refs.ts`, `commit.ts`, `ensure-filing.ts`, `prismaErrToGrid`) to `lib/haystack/` — pure moves, re-export from the route to keep imports working.
3. Collapse the 5 `switch(table)` blocks into `entities.ts`; fix `ClerksRecord`/`ReportersRecord` typing once.
4. Introduce `handlers/<op>.ts` + `dispatch.ts` map; add `withAuth`/`withValidation`. Route file becomes the thin front door.
5. (Optional, later) Promote `read`/`commit` to real sub-routes (Option C). Decide whether to enforce per-op methods (`read`=GET) — note that's a behavior change callers could notice.

**Risk:** low for steps 1–4 (no URL/contract change, each step independently testable against `__tests__/about.test.ts`, `__tests__/commit-columns.test.ts`). The label cache (step 1) is the one real trap.

---

## Part 2 — Secondary files (sketches, lower priority)

| File | Lines | Symptom | Decomposition |
|------|-------|---------|---------------|
| `components/admin-dashboard.tsx` | 2,922 | **101 `useState`**, 20 top-level fns | **Best ROI.** Tab/section dashboard — split each admin tab into its own component file, co-locate its state. The 101 states = distinct concerns jammed together. |
| `components/search-interface.tsx` | 4,272 | 66 `useState`, 22 `useEffect`, 28 `useCallback` | Already partly split (`./search/*`). Extract custom hooks (`useHaystackSearch`, `useSearchPersistence`, AI-query/token-suggestion logic) and lift remaining sub-panels to `./search/*`. |
| `lib/ingestion/ingestion-pipeline.ts` | 1,961 | God-class, 29 methods; `processDocument` ~560 ln | Stages already separate methods. Split into `stages/{extract-text,ocr,exhibits,embeddings,index}.ts` + thin orchestrator + shared `PipelineContext`; checkpoint/heartbeat → `pipeline-checkpoint.ts`. `processDocument` is the priority carve-out. **Note:** concurrency model is already fine — this is organization only, not a perf change. |
| `app/case-management/[caseNumber]/page.tsx` | 2,263 | 47 `useState`, only 1 top-level fn (least factored) | More work: carve page body into section components (header, filings list, tag-panel wiring, timeline); move fetching into hooks. |

---

## Priority & effort

| Item | Effort | Risk | Why |
|------|--------|------|-----|
| Haystack steps 1–3 (cache + helper lift + entity config) | Medium | Low | Removes ~1,400 ln from the route, fixes real duplication/typing debt |
| Haystack step 4 (handler registry + zod) | Medium | Low | Typed validation, thin route, sets up Option C |
| `admin-dashboard.tsx` tab split | Medium | Low | Highest-symptom file; tabs are natural seams |
| `ingestion-pipeline.ts` stage split | Medium | Low-Med | Clean seams; test coverage exists (`jest src/lib/ingestion/`) |
| `search-interface.tsx` hooks | Med-High | Med | Large surface, already moving in the right direction |
| `case-management page` sections | High | Med | Least internally factored |

**Recommended start:** Haystack steps 1–3 (biggest debt reduction, lowest risk, no contract change), then `admin-dashboard.tsx`.

## Verification
- Run `npx jest src/app/api/haystack/__tests__ --no-coverage` after each haystack step (`about.test.ts`, `commit-columns.test.ts`).
- `npx tsc --noEmit` after helper moves to catch broken imports.
- Smoke-test the live callers: tag-panel read, ref-picker, `case-management/layout.tsx` commit (PUT), persona/court clients.
- For ingestion: `npx jest src/lib/ingestion/ --no-coverage`.
