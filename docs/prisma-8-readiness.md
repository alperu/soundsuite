# Prisma "Next" / Prisma 8 readiness

**Status:** Forward-looking research · **Date:** 2026-05-05 · **Scope:** what to do when Prisma's TypeScript rewrite ships stable

This document captures what `prisma-next` (the working name for the next major version of Prisma ORM, expected to ship as **Prisma 8**) brings to Sound Suite, and **specifically how it interacts with the XETO + Project Haystack layer planned in `docs/xeto-haystack-research.md`**.

It is meant to sit on the shelf until Prisma 8 hits a stable release. At that point this doc becomes the playbook for whether to upgrade and what to refactor.

---

## 1. Where things stand today (May 2026)

We're on **Prisma 7.8.0** (after `docs/upgrade-nextjs-prisma.md` Step 2, branch `upgrade/prisma-7`). The XETO + Haystack layer is **planned but not yet built** (see `docs/xeto-haystack-research.md`). The two pieces of context that matter:

- **Prisma 7's contribution we depend on:** the `@prisma/adapter-better-sqlite3` driver adapter — finally honors `PRAGMA journal_mode=WAL` + `busy_timeout=5000` at the connection layer (Prisma issue #2955), which is the prerequisite for the Haystack tag-write workload.
- **Prisma 7's hard limit for our XETO/Haystack plan:** Prisma's typed JSON query operators (`path`, `equals`, `array_contains`) are documented for Postgres + MySQL only — SQLite gets the JSON *type* but not the typed query builder. Our research doc therefore plans a custom Haystack-filter → `$queryRaw` SQL emitter to compile filter syntax like `motion and signed and caseRef==@case-1234` into `WHERE json_extract(tags, '$.motion') = 1 AND ...`. Workable, but the SQL emitter is hand-rolled and lives outside Prisma's type system.

## 2. What `prisma-next` is

Quoting the [prisma/prisma-next](https://github.com/prisma/prisma-next) README verbatim:

> **Prisma Next** is a new foundation for Prisma ORM, rewritten fully in TypeScript to be **extensible** and **composable** by default.
>
> - **A TypeScript rewrite of Prisma ORM**: Rebuilt end-to-end to unlock new capabilities and a more composable architecture.
> - **Extensible by default**: Add extension packs in `prisma-next.config.ts` to unlock new schema attributes and new query capabilities.
> - **Two query APIs**:
>   - **ORM Client** (`db.orm`): model collections with fluent `where/include/select` composition
>   - **Query builder** (`db.sql`): type-safe SQL plan builder for when you want lower-level control
> - **Designed for AI-assisted workflows**: deterministic contracts, structured plans, stable diagnostics, and guardrails that help agents (and humans) iterate safely.
>
> - **Verify at runtime**: detect schema drift before a query runs
> - **Type your queries**: keep results and query operators fully type-safe
> - **Power tooling + agents**: contracts, plans, and diagnostics are structured data — easy to inspect, diff, and reason about

**Repo signals as of 2026-05-05:**
- Created Oct 2025; 296 stars; 26 open issues; default branch `main`; last push 2026-05-05.
- Recent merged work points at the migration planner (M4 invariant-aware ref routing, self-edge support), `cipherstash-extension` scaffolding (a real extension pack in flight), and "drive-orchestrate-plan" agent skills.
- Repository is **not open to external contributions** (per the CONTRIBUTORS.md note).
- Announcement: <https://pris.ly/pn-anouncement> ("The Next Evolution of Prisma ORM").

**Maturity stance:** alpha-grade as of writing. The package is `@prisma/prisma-next` (separate from the existing `@prisma/client`), the API surface is still moving, and there is no published stability guarantee. This document does **not** propose adopting it now. It proposes knowing exactly what to do when Prisma announces a stable Prisma 8.

## 3. Why this matters specifically for Sound Suite

There are three orthogonal benefits — two for the existing app, one that's load-bearing for the XETO/Haystack layer.

### 3.1 Benefits for the existing Sound Suite app (independent of XETO)

| Benefit | Why we care |
|---|---|
| **`db.sql` type-safe plan builder** | Today every dynamic query (`scripts/benchmark-search.ts`, `src/lib/ingestion/indexing-verifier.ts`, anywhere we use `prisma.$queryRaw`) is a stringly-typed SQL fragment with no compile-time guard. `db.sql` proposes the same surface as a typed builder, so the result types flow back through TypeScript. Eliminates a real footgun class. |
| **Runtime schema-drift detection** | The `applySqlitePragmas()` flow + the lazy nature of Prisma 7 schema validation means a stale migration won't fail until you hit the bad column. `prisma-next` advertises drift detection *before* the query runs — fewer mystery 500s after a sloppy DB swap. |
| **AI-assisted workflows: deterministic contracts** | Sound Suite already has an MCP layer that exposes `query_case_knowledge`, `scan_for_pattern`, etc. to AI clients. `prisma-next`'s plan-as-data contract means we could pass a structured query plan back to the AI on error ("you tried to filter by `dueBy` but that column was renamed to `deadline`"). Today the AI just gets a stack trace. |

None of these are emergencies — they're "would be nicer if" ergonomics. We don't need Prisma 8 to ship the rest of the planned roadmap.

### 3.2 The big one: extension packs unblock a `prisma-next-haystack` plugin

This is where Prisma 8 becomes load-bearing for the XETO/Haystack layer.

`docs/xeto-haystack-research.md` Section 3 lays out the hybrid architecture:

```
Strongly-typed core (Prisma models) + open tags layer (Json column) + XETO spec validation
```

The compromise the research doc accepts is that Haystack-filter queries live in a custom `haystackFilter()` function that compiles to `$queryRaw`, sitting **outside** Prisma's type system. The research call-out:

> Prisma's *typed* JSON query operators (`path`, `equals`, `array_contains`) are documented for Postgres+MySQL only. SQLite gets the type, not the query builder. So tag queries always go through `$queryRaw` with the haystack-filter compiler.

**Prisma 8's extension packs collapse this compromise.** From the README:

> Add an extension pack in `prisma-next.config.ts` to unlock new schema attributes and query operators. For example, `pgvector`:

The cipherstash extension currently in flight inside the `prisma-next` repo confirms this isn't speculative — it's the headline ergonomic of the rewrite.

What that means for us:

```ts
// Hypothetical prisma-next.config.ts in Sound Suite, post-Prisma 8
import { defineConfig } from 'prisma/next/config'
import { haystack } from '@court-lens/prisma-next-haystack'

export default defineConfig({
  extensions: [
    haystack({
      schemaPaths: ['./xeto/cc.courtlens.legal', './xeto/proc.tx', './xeto/proc.ca'],
      validator: '@haxall/haxall',  // runtime XETO validator (per xeto-haystack-research §3a)
      tagColumn: 'tags',             // the Json column we add to Filing/Motion/etc.
    }),
  ],
})
```

What that extension would buy us — versus the hand-rolled Prisma 7 path:

| Today (Prisma 7 + `$queryRaw` plan) | With `prisma-next-haystack` extension (Prisma 8) |
|---|---|
| `db.filing.findMany({ where: { ... } })` for typed columns + parallel `haystackFilter("motion and signed", ...)` for tag queries — two surfaces. | One surface: `db.filing.findMany({ where: { tags: hs("motion and signed and caseRef==@case-1234") } })`. Filter parser sits in the extension; Prisma 8 sees it as a first-class operator. |
| `haystackFilter()` returns `unknown` rows; we cast manually. | Result type narrowed by which markers the filter requires (extension can encode that `tags: hs("motion")` returns rows with `tags.motion` known-true). |
| Tag write-path validation lives in a separate `repo.ts` wrapper that calls `ns.fits(dict, spec)` before `prisma.filing.create(...)`. | Extension intercepts the write path: schema attribute `@@xetoSpec("Motion")` on the Prisma model triggers automatic XETO validation on every `create`/`update`. The two layers stay in sync by construction. |
| Schema drift between XETO specs and Prisma models is invisible until a query at runtime. | `prisma-next`'s "verify at runtime: detect schema drift before a query runs" applies to extension-defined attributes too. Discrepancy flagged at request entry. |
| MCP tool surface needs a hand-written translation from filter strings to typed query plans. | The same plan that `db.sql`/`db.orm` produces is structured data — the MCP layer can serialise/deserialise it directly. AI clients get a typed plan to inspect rather than an opaque SQL string. |

### 3.3 Bonus: pgvector extension if we ever migrate to Postgres

The README explicitly cites `pgvector` as the example extension. `PostgressUpgradeV2.md` notes that Postgres migration is on the long-term roadmap; if we ever take it, vector search (currently in LanceDB) could move into Prisma directly via `pgvector`. Today that integration would be hand-rolled.

## 4. The migration playbook for "Prisma 8 has shipped stable"

When Prisma announces a stable Prisma 8 release (i.e. the `prisma-next` repo's `main` is tagged as a Prisma ORM major release and migrated into the main `prisma/prisma` repo), the order of operations:

1. **Read the Prisma 7 → 8 upgrade guide first** — there *will* be breaking changes the README hasn't surfaced yet.
2. **Capture a baseline backup** via `scripts/full-backup.sh` (the same flow used for Steps 1 + 2 of the framework upgrade).
3. **Branch from main** as `upgrade/prisma-8`. Don't stack on `upgrade/prisma-7` or whatever follows it.
4. **Verify the better-sqlite3 driver adapter still ships** (or what replaces it). Step 2 of `docs/upgrade-nextjs-prisma.md` made the adapter the gating prerequisite for tag-heavy concurrent writes. If Prisma 8 changes the driver-adapter contract, redo the wiring in `src/lib/db/prisma.ts` first.
5. **Migrate `src/lib/db/prisma.ts`'s adapter init** to the Prisma 8 form. Keep `applySqlitePragmas()`. Keep the `resolveSqlitePath()` helper that translates Prisma's `file:./data/...` URL to the absolute path better-sqlite3 wants — that compatibility shim is independent of the Prisma version.
6. **Migrate `prisma.config.ts`** to whatever shape `prisma-next.config.ts` wants. The Prisma 7 file is small — should be a near-rename.
7. **Schema migration**: the `prisma-client-js` generator we deliberately stayed on (per `docs/upgrade-nextjs-prisma.md` Step 3) probably becomes obsolete in Prisma 8 in favour of `prisma-next`'s native generator. Check whether `prisma-client-js` is still supported as a compatibility mode, or if we have to switch generators (in which case the Turbopack import-resolution issue from `prisma#28627` may finally be resolved upstream — check before committing).
8. **Test ergonomics**: convert one or two `$queryRaw` call sites to `db.sql` to confirm the query builder type flow works under our `tsconfig.json` strict settings. Don't bulk-convert until soak.
9. **If at this point the XETO/Haystack layer has been built** (per `docs/xeto-haystack-research.md`): evaluate building or adopting a `prisma-next-haystack` extension (Section 3.2 above). Decide between:
   - (a) Keep the hand-rolled `haystackFilter()` SQL emitter, just upgrade the surrounding Prisma — minimal change, no upside but no risk
   - (b) Build the extension as part of the upgrade — large refactor, eliminates the hand-rolled SQL emitter, gives type-safe Haystack queries
   - (c) Build the extension as a follow-up after the upgrade soaks — the safest split
   
   Recommend (c) unless the extension proves trivial during prototype.
10. **Soak** for the same 2–3 days the Prisma 7 step needed before merging to main.

## 5. What we explicitly KEEP from the Prisma 7 work

These don't get undone in the move to Prisma 8:

- **`@prisma/adapter-better-sqlite3` model** — even if the adapter package name changes, the *concept* (TypeScript-native driver, no Rust binary, PRAGMAs honored at the connection layer) is what Prisma 8 doubles down on.
- **`resolveSqlitePath()` shim in `src/lib/db/prisma.ts`** — translates Prisma's `file:` URL convention to better-sqlite3's CWD-relative path resolution. Independent of the Prisma version; needed as long as we ship SQLite locally.
- **`src/services/workflow-service.ts` using the singleton** — the bare-`new PrismaClient()` pattern is permanently dead in driver-adapter mode. Don't regress.
- **`src/lib/action-log.ts` being client-safe** — once a module imports the DB client, it's server-only forever. The split we did in Step 2 is foundational.
- **`serverExternalPackages`** entries for Prisma packages — Turbopack still needs the hint regardless of Prisma version.

## 6. Open uncertainties

Things this doc cannot promise because the upstream isn't pinned yet:

- **Whether Prisma 8 is the actual ship name.** It might land as Prisma 9, or as a parallel `@prisma/next` package living alongside `@prisma/client` indefinitely. The repo currently publishes as `@prisma/prisma-next` (separate npm scope) — that suggests it could ship as a non-replacing alternative rather than a forced upgrade.
- **Whether `prisma-client-js` survives as a generator option.** If Prisma 8 forces the new generator, the Turbopack issue (`prisma#28627`) needs to be confirmed fixed before we can land it without breaking the build.
- **Whether driver adapters become mandatory or optional.** Prisma 7 made them mandatory; Prisma 8 may go further (no fallback at all) or relax (some legacy path).
- **Whether the extension API is stable enough to write `prisma-next-haystack` against.** As of May 2026, internal extensions like `cipherstash-extension` are still being scaffolded. External extension authoring may not be supported until Prisma 8.x mid-cycle.
- **Whether the `db.sql` plan format is documented well enough** for the MCP layer to consume it as deterministic structured data (the README claims yes; we'd need to verify against the actual API).

## 7. Triggers for revisiting this doc

Open this doc and re-evaluate when **any** of the following happens:

1. Prisma announces a stable Prisma 8 release and migrates `prisma-next` content into the main `prisma/prisma` repo.
2. The XETO + Haystack layer ships in Sound Suite (per `docs/xeto-haystack-research.md` migration sequence) — at that point the value calculation in Section 3.2 becomes concrete.
3. `prisma-next` publishes a public extension authoring guide. That's the moment a `prisma-next-haystack` plugin becomes feasible to scope.
4. The community ships a community `prisma-next` Haystack adapter. (Unlikely given Haystack's small JS footprint, but worth tracking.)
5. We hit a real performance ceiling on the hand-rolled `haystackFilter()` SQL emitter that Prisma 8's typed query path would solve.

Until one of those triggers fires: **stay on Prisma 7**, finish the XETO/Haystack layer using the hand-rolled compromise the research doc accepts, and let `prisma-next` mature in the open.

## 8. References

- `prisma/prisma-next` repo — <https://github.com/prisma/prisma-next>
- Prisma Next announcement — <https://pris.ly/pn-anouncement>
- `docs/upgrade-nextjs-prisma.md` (Steps 1–3 of the framework upgrade)
- `docs/xeto-haystack-research.md` (the XETO + Haystack architecture this would integrate with)
- Prisma issue #2955 (SQLite WAL/busy_timeout) — solved by Prisma 7 + better-sqlite3 adapter
- Prisma issue #3786 (SQLite Json type) — partially solved in Prisma 6.2; full typed-query operators still Postgres/MySQL only as of Prisma 7
- Prisma issue #28627 (new generator + Turbopack) — open as of writing; gates the prisma-client generator switch
