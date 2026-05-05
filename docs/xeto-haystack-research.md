# XETO + Project Haystack: court-domain modeling for Sound Suite

**Status:** Research draft · **Date:** 2026-05-04 · **Scope:** architectural exploration, no code changes

This is the output of a seven-agent investigation into how Project Haystack's tag/spec model and the XETO type language could be layered onto Sound Suite to encode legal procedure (cases, filings, motions, RFAs, per-state rules, deadlines) in a way the AI chat can reason about. It also answers the technical question that prompted it: **does Prisma stay or do we switch ORMs to better fit a tag-based data model?**

The short version:

- **Keep Prisma 7 + SQLite.** Add a `tags` JSON column to the legal-domain models, compile Haystack filter syntax to `json_extract(...)` SQL via `$queryRaw`, validate writes against XETO specs at runtime via `@haxall/haxall`'s `Namespace.fits()`. There is no JS-native Haystack datastore worth switching to.
- **XETO + Haystack are real and active.** Use `@haxall/haxall` (the official Fantom-compiled-to-JS package from SkyFoundry/Brian Frank, npm `@haxall/haxall@4.0.4`, AFL-3.0) for native XETO validation — `Namespace.fits()` and `Namespace.validate()` give us full-fidelity structural checks against XETO specs, with no offline compile step. Use `haystack-core` (j2inn) for the dict/filter runtime alongside it. **`@xeto/sdk` does not exist on npm — `@haxall/haxall` is the canonical entry point.**
- **Encode procedural rules as XETO *instances*, not types.** Three libs: `proc.core` (jurisdiction-neutral), `proc.tx`, `proc.ca`, `proc.frap`. Each rule is a `Rule` dict with `triggerEvent`, `dueAfterDays`, `targetFiling`, `consequenceIfMissed`. Calendar arithmetic and cascading deadlines stay in plain TypeScript — XETO is the schema, not the rule engine.
- **For the visual "next-action" graph, use React Flow, not Rete.js.** Rete is overkill for a read-only derived diagram; React Flow has 28k stars and a declarative API.
- **Stand up a Haystack HTTP server alongside the existing MCP server.** Both are peers over a shared `src/lib/legal/` service — MCP for action-shaped operations (PDF ops, draft chat, exhibit retrieval, AI helpers), Haystack for record-shaped operations (`read filter:"motion and signed"`, schema discovery, third-party tooling like SkySpark/Haxall). One identity model, one data path, two front-ends.

The rest of this document is the detailed plan.

---

## 1. The shape of the data we want

The user's goals, restated as a data model:

1. **Cases** are containers of **filings** (motions, notices, responses, orders, RFAs, bills of review, …).
2. **Each filing has a lifecycle**: `received → response_due → response_filed → signed/granted/denied`. Today this is *not* tracked.
3. **Per-state procedural rules** dictate deadlines: "Texas TRAP 38 says X days after Y event". Today there's a `Case.jurisdiction` free-text field and no rule database.
4. **The system must know who you are** — today it has no User/Attorney model, just file-system paths.
5. **The AI chat should answer** "what's due on this case?" and "what should I do next?" by reasoning over case state + rules.
6. **A visual graph** shows the action sequence (file → serve → wait → respond → rule).

This is essentially a **Project Haystack–style** problem: open-set tags + refs + a typed schema overlay (XETO) that explains what the tags mean. Haystack was designed for building ontologies; the legal domain has the same shape (entities + relations + state markers + rules) as the building/equipment domain it was built for.

## 2. What's actually in court-lens-mcp today

From the agent inventory of `prisma/schema.prisma`:

**Legal-domain models (5):** `Case`, `Filing`, `Document`, `Motion`, `Exhibit`.
**AI/draft (5):** `Draft`, `DraftVersion`, `DraftSuggestion`, `DraftCase`, `UserPreferenceSignal`.
**Workflow (2):** `WorkflowTemplate`, `Workflow`.
**Infrastructure (6):** `Config`, `JobLog`, `ModelDownload`, `PageCache`, `ActionLog`, `SidecarCommand`.

Total: **18 models** (the upgrade doc said 13 — that was wrong; the count grew with the draft-suggestion + sidecar-queue migrations).

**Critical gaps for the XETO goal:**
| Missing | Where it would live |
|---|---|
| User / Attorney / Pro Se model | new `Actor` model |
| Structured Jurisdiction (today `Case.jurisdiction` is free text) | new `Jurisdiction` model + FK |
| Court rule database (TRAP, FRAP, CRC) | new `CourtRule` model OR XETO instances |
| Filing phase / state machine | new `FilingPhase` model + history |
| Deadline calculator | new `src/lib/procedure/` module |
| "Next action" derivation | new derivation pipeline + UI graph |
| Document service date / author / recipient | extend `Document` |

**Filing taxonomy:** 24 hardcoded types in `src/services/filing-type-classifier.ts` (Motion, Notice, RFA, Bill of Review, …) → embedded in LanceDB → semantic classification by L2 distance, 7-day Redis cache. **This stays.** XETO specs would be a *type layer over* the existing classifier output, not a replacement.

## 3. Why Prisma stays — the ORM question answered

Recap of the question: "Is Prisma good for working with the haystack model? Should we switch?"

**Answer: stay on Prisma 7 + SQLite. Add `tags Json` columns. Compile Haystack filter syntax to SQL.**

### What we evaluated (and rejected)

| Option | Why we rejected it |
|---|---|
| **Folio (SkySpark)** | JVM-only, commercial, single vendor. No JS-native equivalent exists. |
| **Switch to MongoDB / CouchDB** | Better for free-form dicts, but loses Prisma's typed core (relations, transactions, generated types). 1 GB of existing data + 13 migrations = real cost. |
| **Switch to Postgres + JSONB + GIN** | Genuinely better for tag containment queries at scale. Doesn't justify running a database server until ~10M records or multi-user mode. SQLite stays adequate. |
| **Neo4j / ArangoDB (graph)** | Refs *do* form a graph, but most queries are 1-2 hops; Cypher is a steep cost for tiny benefit. |
| **EAV "facts" side table** (`id`, `parentRef`, `tag`, `value`) | Strictly worse than JSON-on-row at 100k records: multi-join per filter, lost row locality, fragmented indexes, ref-deref multiplies joins. |
| **Drop the ORM entirely** | Prisma's generated types + migration runner + relation handling earn their keep on the strongly-typed core (Case, Document, Filing). |

### The hybrid we recommend

```
Strongly-typed core (Prisma models)
    Case, Filing, Document, Motion, Exhibit, Actor, Jurisdiction
    + relations enforced by Prisma's typed query builder

Open tags layer (Json column on each entity)
    tags: { motion, signed, dueBy: "2026-06-15", caseRef: "@case-1234", ... }
    written via: writeTags(entity, dict) — runtime XETO validation
    queried via: haystackFilter("motion and signed and caseRef==@case-1234")
                  → compiled to SQL: WHERE json_extract(tags, '$.motion') = 1 ...

XETO spec library (source of truth for tag semantics)
    cc.courtlens.legal/Case.xeto, Motion.xeto, Filing.xeto, Actor.xeto
    proc.core/Rule.xeto, proc.tx/*, proc.ca/*, proc.frap/*
    compiled to JSON Schema → validated by ajv at write time
```

### Implementation specifics

1. **`tags Json @default("{}")` column** added to `Case`, `Filing`, `Document`, `Motion`, `Exhibit`, `Actor`, `WorkflowTemplate`. Migration is additive, zero-risk.
2. **XETO validation via `@haxall/haxall`** — install `@haxall/haxall` (npm, ~13.4 MB unpacked, ESM-only, `Namespace`/`Lib`/`Spec` types in `xeto.d.ts`). At boot, call `XetoEnv.cur()` once, load the `cc.courtlens.legal` lib + `proc.{tx,ca,frap}` libs, and validate every `tags` write via `ns.fits(dict, spec)` (boolean) or `ns.validate(dict, spec)` (returns a `ValidateReport` with structured error rows). This gives us native XETO semantics — `Choice`, `Query`, ref typing, covariant slot narrowing — that JSON Schema can't fully express.

   **Add `@haxall/haxall` to `serverExternalPackages`** in `next.config.ts` so Turbopack doesn't try to bundle the 13 MB Fantom JS:
   ```ts
   serverExternalPackages: [
     '@haxall/haxall',
     'haystack-core',
     // ...existing entries
   ]
   ```
   Server-only — never imported into client code (the bundle is untreeshakable Fantom output, not browser-grade).
3. **`haystackFilter(filterStr, kindHint?)`** — tiny TS function that uses `haystack-core`'s `HFilter.parse()` to parse the filter, then walks the AST and emits a SQLite WHERE clause using `json_extract(tags, '$.path')`. Refs (`caseRef==@case-1234`) deref via a small registry mapping ref tag names to Prisma table joins.
4. **SQLite expression indexes** on hot tag paths:
   ```sql
   CREATE INDEX idx_filing_motion ON Filing(json_extract(tags, '$.motion'));
   CREATE INDEX idx_filing_signed ON Filing(json_extract(tags, '$.signed'));
   CREATE INDEX idx_filing_dueBy  ON Filing(json_extract(tags, '$.dueBy'));
   ```
   The SQL emitter must match these exactly for the planner to use them.
5. **`Prisma.Json` type** is fully supported on SQLite as of Prisma 6.2.0 — but Prisma's *typed* JSON query operators (`path`, `equals`, `array_contains`) are documented for Postgres/MySQL only. SQLite gets the type, not the query builder. So tag queries always go through `$queryRaw` with the haystack-filter compiler. Prisma still owns the typed core.

**This implementation depends on Prisma 7 + the better-sqlite3 adapter** (per `upgrade-nextjs-prisma.md` Step 3) because the adapter actually honors WAL + busy_timeout under the concurrent reads/writes that tag-heavy queries will produce. The two roadmaps land in this order: framework upgrade first, then this layer on top.

## 3a. `@haxall/haxall` — the runtime XETO library

The first agent inventory said "no documented JS API — README is two paragraphs about the xeto binary". That was wrong. The README only covers the CLI, but the package ships a fully typed JS/TS API in `package/esm/xeto.d.ts` (1680 lines).

### What's in the package

```
@haxall/haxall@4.0.4 (AFL-3.0, ~13.4 MB unpacked, ESM)
├── bin/xeto                         CLI (xeto compile, xeto validate, xeto repl)
├── esm/xeto.{js,d.ts}               XETO runtime: Namespace, Lib, Spec, Dict, ...
├── esm/xetoc.{js,d.ts}              XETO compiler
├── esm/xetom.{js,d.ts}              XETO meta / metaspec
├── esm/xetoTools.{js,d.ts}          CLI plumbing
├── esm/xetoDoc.{js,d.ts}            Doc generator
├── esm/haystack.{js,d.ts}           Haystack core (overlaps with j2inn/haystack-core)
├── esm/folio.{js,d.ts}              Folio in-memory store
├── esm/hxFolio.{js,d.ts}            Folio HTTP API
└── lib/xeto/{sys,ph,ph.equips,ph.points,...}/*.xetolib   Pre-built standard libs
```

### The four functions we actually need

```ts
import { XetoEnv, Namespace, Spec, ValidateReport, Dict } from '@haxall/haxall/esm/xeto.js';

// 1. Boot once, app-lifetime singleton.
const env = XetoEnv.cur();
const ns: Namespace = env.compileNamespace([
  'sys',
  'ph',                    // Project Haystack standard
  'cc.courtlens.legal',    // our domain spec
  'proc.tx',
  'proc.ca',
  'proc.frap',
]);

// 2. Resolve the spec for a tag dict.
const motion: Dict = { motion: marker(), signed: marker(), caseRef: ref('@case-1234') };
const spec: Spec = ns.specOf(motion);   // → cc.courtlens.legal::Motion

// 3a. Cheap boolean check.
if (!ns.fits(motion, spec)) { /* reject */ }

// 3b. Full validation with structured errors.
const report: ValidateReport = ns.validate(motion, spec);
for (const item of report.subjects) {
  for (const e of item.items) {
    console.error(e.dis, e.id, e.msg);   // path, severity, message
  }
}

// 4. Compile XETO source from a string (e.g. for a hot-reload editor).
const newSpec = ns.compileData(xetoSourceString, { /* opts */ });
```

That's the entire surface we exercise. The other 1670 lines of `.d.ts` are auxiliary (Folio, comp graphs, Axon, etc.) — we don't import them.

### Operational notes

- **ESM only.** `@haxall/haxall` is `"type": "module"` and uses `import`/`export` — fine in Next.js server components and API routes which already run ESM. Won't load from CommonJS scripts (so `scripts/manage.mjs` can use it via `await import()`, plain `.js` requires can't).
- **Server-side only.** Add `'@haxall/haxall'` to `serverExternalPackages` in `next.config.ts`. Never import into a `'use client'` component — the bundle is untreeshakable Fantom JS, not browser-shaped, and would balloon the client.
- **Boot cost.** Loading the standard `ph` lib + 4 custom libs takes ~200–500 ms on first call. Cache the `Namespace` as a module-level singleton (the same pattern `src/lib/db/prisma.ts` uses).
- **Validation cost.** `ns.fits(dict, spec)` is microseconds for typical dicts; `ns.validate(...)` adds the report assembly overhead — fine for write-time checks, don't run inside hot read loops.
- **License.** Academic Free License 3.0 (AFL-3.0). Permissive, OSI-approved, allows commercial use. SkyFoundry / Brian Frank are the maintainers; v4.0.4 published 2026-01.

### Why this beats the JSON-Schema-via-ajv path

The original agent recommendation was "compile XETO offline → JSON Schema → validate at runtime with ajv". That works for the simple type/marker constraints but loses three things:

1. **`Choice` exclusivity** — `TriggerEvent: Choice; ServedOn: TriggerEvent { servedOn }; FiledOn: TriggerEvent { filedOn }` means a record may have `servedOn` *xor* `filedOn`, not both. JSON Schema can express this with `oneOf` but it's verbose and the error messages are bad.
2. **`Query` slots** — XETO's `Query<of:Filing, via:"caseRef+">` says "all Filings transitively referenced by `caseRef`". JSON Schema has no concept of cross-record traversal; you'd build it ad-hoc.
3. **Covariant slot narrowing** — when `MotionToVacate` declares `withinDays: Number` and a subtype tightens it to `withinDays: Number <unit:"day", default:180>`, XETO checks the narrowing. JSON Schema's `allOf` semantics around `default` are notoriously fuzzy.

Use `@haxall/haxall` and round-trip stays correct with SkyFoundry's reference implementation — anyone who later edits the spec library in SkySpark/Haxall produces output our app accepts byte-for-byte.

### What `@haxall/haxall` does NOT replace

- **`haystack-core` (j2inn)** — still the right pick for parsing/evaluating Haystack filter syntax (`motion and signed and caseRef==@case-1`) at SQL-emit time. The Haxall package has filter support too but `haystack-core`'s `HFilter` is smaller, npm-native, and battle-tested for the JS use case. Use both: `@haxall/haxall` for spec validation, `haystack-core` for filter compilation.
- **Datastore** — `@haxall/haxall` ships Folio (in-memory) but it's not what you want for a 1 GB SQLite-backed app. Prisma + SQLite stays.

## 4. The XETO spec library

### Library structure

| Lib | Purpose |
|---|---|
| `cc.courtlens.legal` | Domain entities: `Case`, `Filing`, `Motion`, `Notice`, `RFA`, `BillOfReview`, `Order`, `Response`, `Actor`, `Court` |
| `proc.core` | Jurisdiction-neutral procedural primitives: `Rule`, `TriggerEvent`, `Deadline`, `Action`, `Consequence` |
| `proc.tx` | Texas rules (TRAP, TRCP, etc.) — instances of `proc.core::Rule` |
| `proc.ca` | California rules (CCP, CRC) |
| `proc.frap` | Federal Rules of Appellate Procedure |

### Verified XETO syntax

```xeto
// proc.core::Rule — the schema for a procedural rule.
Rule: Dict <abstract> {
  citation:           Str          // "Texas TRCP 198.2"
  triggerEvent:       TriggerEvent
  targetFilingType:   Ref<Filing>
  dueAfterDays:       Number <unit:"day">
  consequenceIfMissed: Consequence
}

TriggerEvent: Choice              // exclusive markers
ServedOn: TriggerEvent { servedOn }
FiledOn:  TriggerEvent { filedOn }

Consequence: Choice
DeemedAdmitted: Consequence { deemedAdmitted }    // RFA-style auto-loss
NoticeOfDefault: Consequence { noticeOfDefault }
NoConsequence:   Consequence { noConsequence }
```

```xeto
// proc.tx::rfaResponseRule — an INSTANCE of Rule, not a new type.
@rfaResponseRule: Rule {
  citation:            "Texas TRCP 198.2"
  triggerEvent:        ServedOn
  targetFilingType:    @rfaResponse
  dueAfterDays:        30
  consequenceIfMissed: DeemedAdmitted
}
```

This is the architectural insight from the agent investigation: **rules are instances, not types.** Don't define `TexasRfaRule extends Rule` — define one `Rule` spec and instantiate it per rule. New rule = new instance, not new code.

### Cross-jurisdiction example: Bill of Review

Texas Bill of Review (equitable, 4-year statute) has no clean California analog. Honest inheritance:

```xeto
// cc.courtlens.legal::MotionToVacate — abstract base
MotionToVacate: Filing <abstract> { motion, motionToVacate }

// Texas-specific
TxBillOfReview: MotionToVacate {
  jurisdictionTx
  withinYears: Number <unit:"year", default:4>
  requires: ["meritoriousDefense", "extrinsicFraud", "noNegligence"]
}

// California-specific (CCP 473)
CaMotionForRelief: MotionToVacate {
  jurisdictionCa
  withinDays: Number <unit:"day", default:180>
  requires: ["mistakeOrInadvertence"]
}
```

No covariant override gymnastics — just sibling specs with their own constraints.

### What XETO can't do

XETO is a type system, not a rule engine. These stay in plain TypeScript (`src/lib/procedure/`):

- **Calendar arithmetic** ("the Monday after 20 days" — TRCP 99(b))
- **Cascading deadline resets** (FRAP 4(a)(4): a Rule 59 motion resets the 30-day appeal clock)
- **Weekend / federal holiday rollover** (uses `date-fns` + a holidays table)
- **Multi-party joint deadlines**
- **Conditional consequences** ("if served by certified mail, +3 days")

Use `date-fns`, not Drools or Z3. Drools is overkill; Z3 is the wrong tool entirely.

## 5. Tag model — concrete additions to Sound Suite

Sketch from the Haystack agent (~30 tags). Prefix: none required (we own the namespace).

**Entity markers** (15): `case`, `motion`, `notice`, `rfa`, `billOfReview`, `appellate`, `hearing`, `order`, `response`, `affidavit`, `petition`, `subpoena`, `transcript`, `judgment`, `settlement`

**State markers** (9): `received`, `responded`, `signed`, `granted`, `denied`, `served`, `filed`, `withdrawn`, `mooted`

**Refs** (8): `caseRef`, `motionRef`, `filingRef`, `partyRef`, `attorneyRef`, `courtRef`, `judgeRef`, `priorRef`

**Value tags** (~11): `dueBy`, `receivedOn`, `respondedOn`, `signedOn`, `causeNo`, `jurisdictionTx`, `jurisdictionCa`, `jurisdictionFed`, `docUri`, `sha256`, `pageCount`

**State machine pattern** (Haystack idiom): a single record + additive markers + paired timestamps — not separate records per state.
```json
{
  "id": "@motion-1234",
  "motion": true,
  "received": true,  "receivedOn": "2026-04-15T...",
  "responded": true, "respondedOn": "2026-05-01T...",
  "signed": true,    "signedOn": "2026-05-12T...",
  "caseRef": "@case-5678",
  "dueBy": "2026-05-15T..."
}
```

The `mod` (modification timestamp) auto-updates on every write — that gives you free audit history without a separate event table.

## 6. The "what should I do next?" pipeline

Three layers, all server-side:

### Layer 1 — Rule loader
At startup, walk `proc.{tx,ca,frap}/*.xeto`, load every `Rule` instance, index by `targetFilingType` and `triggerEvent`. Pure in-memory, ~milliseconds.

### Layer 2 — Action derivation (TS, not XETO)
Given a Case, walk its filings + tags:
- For each `Rule`, find filings whose state matches `triggerEvent` (e.g., `received` for `ServedOn`).
- Compute `dueDate = triggerDate + dueAfterDays` (with weekend/holiday rollover).
- Look for an existing filing of `targetFilingType` linked to the trigger filing. If absent → emit an `Action` (do this); if present → emit a `Completed` (already done); if `dueDate < now` → flag as overdue.

### Layer 3 — MCP tools for the AI chat
Exposed to the AI via the existing MCP layer:

```typescript
// Tool: listPossibleActions(caseId) → Action[]
// Tool: listOverdueActions(caseId, now) → Action[]
// Tool: listUpcoming(caseId, withinDays) → Action[]
// Tool: explainRule(ruleQname) → { citation, plainEnglish, sourceUrl }
```

The AI then composes prompts like *"You filed an RFA on April 15. Texas TRCP 198.2 requires the opposing party to respond within 30 days. As of today (May 4), they have 12 days remaining. If they miss it, the requests are deemed admitted (TRCP 198.2(c))."* — entirely from the structured rule library, no hallucination.

## 7. The visual graph — React Flow, not Rete.js

The agent recommendation is unambiguous: **use `@xyflow/react`** (React Flow), not Rete.js, for the "next-action" graph view.

| | Rete.js | React Flow / XYFlow |
|---|---|---|
| Stars | 12k | 28k |
| Cadence | Bugfix-only since 2025 | Weekly releases |
| API style | Imperative plugin tree | Declarative `<ReactFlow nodes edges />` |
| JSON import/export | DIY (docs explicitly say unsupported) | Built-in |
| Headless engine | Yes (`rete-engine`) | N/A — graph is data |
| For a read-only derived diagram | Overkill | Right size |

Implementation:

- `src/components/case/case-action-graph.tsx`
- Source of truth: derived from XETO Action specs + the case's actual Document/Filing records. Read-only.
- Layout: `dagre` for hierarchical placement (top-to-bottom: prerequisites → action → outcome).
- Node colors: green = completed, blue = pending, amber = due soon, red = overdue.
- Click → opens the linked filing in the existing case explorer.
- Re-derive on case mutation; no canvas state to persist.

Reserve Rete.js for a future v2 where users drag-edit XETO Action templates as a building block library (different problem, different tool).

## 8. User identity model

The system today is case-centric, not user-centric. To make "this is the response *I* wrote vs the motion *they* sent" meaningful, add:

```prisma
model Actor {
  id           String   @id @default(cuid())
  kind         String   // "self" | "opposing-counsel" | "pro-se" | "judge" | "court-clerk"
  displayName  String
  barNumber    String?  // optional
  email        String?
  role         String?  // "appellant" | "appellee" | "plaintiff" | "defendant" | "intervenor"
  jurisdictionRef String?
  tags         Json     @default("{}")
  // back-relations: filings authored, filings received, etc.
}
```

Plus:
- `Document.authorId String?` and `Document.recipientId String?`
- `Filing.filedById String?`
- A "self" actor row created on first boot (the user enters name + bar # in admin once)

Now "motion received" vs "motion sent" is a one-tag query: `received and recipientRef == @actor.self`.

## 9. Folder/file XETO spec

The user asked: can XETO model the on-disk folder layout?

Yes — define a `FsLayout` spec where each rule says "files matching glob X belong to filing type Y in case Z":

```xeto
LegalFsLayout: Dict {
  rootPath:    Str
  caseGlob:    Str <default:"{caseName}/">           // case-name as folder
  filingGlob:  Str <default:"{caseName}/{filingType}/{filename}.pdf">
  exhibitGlob: Str <default:"{caseName}/exhibits/{label}.pdf">
}
```

Render a folder tree in the UI from this spec; show "you don't have a `responses/` folder for case X — create it" as a derived action. **Lower priority than the rules engine** — file the spec but don't implement the UI until the rules engine is shipping value.

## 10. Migration sequence

The implementation order matters because each step de-risks the next.

1. **Land the framework upgrade first** (`upgrade-nextjs-prisma.md` Steps 0–3). The better-sqlite3 driver adapter from Prisma 7 is a hard prerequisite for tag-heavy concurrent reads/writes.
2. **Add the `tags Json` column** to Case, Filing, Document, Motion, Exhibit. Migration is additive, zero data risk. Default `{}`.
3. **Vendor `haystack-core`** + write a `haystackFilter()` SQL emitter. Unit-test against a fixture set of dicts.
4. **Add the `Actor` and `Jurisdiction` models.** Backfill: every existing Case gets `jurisdiction = parsed-from-Case.jurisdiction-string` (best-effort; flag unparseables).
5. **Author the first XETO library** (`cc.courtlens.legal`) covering the 18 existing models. Compile to JSON Schema. Wire validation into the write path for `tags` only (don't validate the typed columns).
6. **Author `proc.tx`** with 10–20 of the most-cited Texas rules (TRAP 38, TRCP 198, TRCP 99, etc.). Source: `txcourts.gov`.
7. **Build the action-derivation pipeline** + MCP tools.
8. **Build the React Flow case-action graph.** Wire to a new `/case/[id]/actions` page.
9. **Open the AI chat surface** — the existing draft chat gets a new "Case actions" tool group.
10. **Then `proc.ca` and `proc.frap`.** Same pattern, different rule sources.

Estimated effort (rough, after the framework upgrade is done): **6–10 weeks of focused work** for steps 2–9. Step 10 is open-ended and can grow incrementally.

## 11. Haystack HTTP server alongside MCP

Sound Suite already exposes its tools (case search, exhibit retrieval, contradiction detection, …) over Model Context Protocol (MCP). The two protocols don't compete — MCP is action-oriented (invoke a verb with structured params), Haystack is data-oriented (read/commit records by tag filter). Both can stand up at the same time over the same underlying data, and an AI client can reach for whichever fits the task.

### Recommendation: peers over a shared service

Three options were evaluated:

- ❌ **MCP wraps Haystack** — fails because PDF rendering, exhibit blobs, vector search, draft chat streaming have no Haystack idiom.
- ❌ **Haystack wraps MCP via `eval`** — fails because Haystack's `eval` is for Axon scripts, not arbitrary tool invocation.
- ✅ **Both as peers over a shared internal service** — each protocol stays idiomatic, single XETO-validated write path, no duplicated filter compilation.

### What "shared service" means in code

```
src/lib/legal/                           ← single source of truth for legal-domain data
  repo.ts                                  Prisma + tags JSON, all writes via @haxall/haxall fits()
  haystack-filter-sql.ts                   HFilter (j2inn) → json_extract(...) WHERE clauses
  xeto-namespace.ts                        @haxall/haxall Namespace singleton (mirrors src/lib/db/prisma.ts)
  hayson.ts                                Hayson encode/decode (thin wrapper on haystack-core)
  ref-registry.ts                          tag → Prisma table (caseRef → Case, etc.)
  ops/{about,defs,libs,read,commit,nav}.ts

src/lib/mcp/tools/legal-*.ts             ← refactor existing tools that hit Prisma directly
                                           to call repo.ts. No wire change for MCP clients.
src/lib/mcp/tools/legal-list-actions.ts  ← new: derived from XETO Action specs
src/lib/mcp/tools/legal-list-overdue.ts
src/lib/mcp/tools/legal-explain-rule.ts

src/app/api/haystack/[op]/route.ts       ← Haystack HTTP API; dispatch to ops/*
                                           Auth: bearer token (defer SCRAM until a real client needs it)
src/app/api/mcp/execute/route.ts         ← unchanged; still none/apikey/OAuth
```

Both routes terminate auth into the same `Actor` row from §8. One identity model, two front-ends.

### Standard Haystack ops we expose (v1)

The Haystack 4 standard library defines 11 ops (`about, close, defs, filetypes, libs, nav, ops, read, watchSub, watchUnsub, watchPoll`). Sound Suite v1 implements the read-side core:

| Op | Behaviour | Status |
|---|---|---|
| `about` | server identity, version, project name | ship v1 |
| `ops` | list of supported ops (self-discovery) | ship v1 |
| `libs` | the loaded XETO libs (`cc.courtlens.legal`, `proc.tx`, …) so a client knows our schema | ship v1 |
| `defs` | full Haystack defs grid for the loaded libs | ship v1 |
| `filetypes` | supported wire formats (Hayson, Zinc) | ship v1 |
| `nav` | hierarchical nav (cases → filings → motions) | ship v1 |
| `read` | filter-based query — `motion and signed and caseRef==@case-1234` | ship v1 |
| `close` | end auth session | ship v1 |
| `commit` | write/update records (SkySpark/Folio extension, not standard ph) | ship v1 |
| `watchSub` / `watchPoll` / `watchUnsub` | record-change notifications | defer to v2 (use existing `/api/progress` SSE in the meantime) |
| `eval` | Axon expressions | **skip** — Axon is a SkySpark scripting language we don't support |
| `hisRead` / `hisWrite` / `pointWrite` / `invokeAction` | timeseries + IoT control | **skip** — building-domain only, not legal |

Wire format: Hayson (`application/json` or `application/vnd.haystack+json;version=4`) is the modern default; Zinc is legacy fallback.

**Note on errors:** Haystack returns `200 OK` with a grid whose meta carries an `err` marker — clients check the marker, not the HTTP status. The route handler must enforce this convention.

### Auth — SCRAM today, bearer for v1

- **MCP** keeps the existing `none` / `apikey` / `oauth` modes on `/api/mcp/execute`.
- **Haystack** spec uses HELLO → SCRAM-SHA-256 → `Authorization: BEARER authToken=...`.
- **v1 simplification**: skip the SCRAM handshake; require a static bearer token (same one MCP's `apikey` mode uses). Add SCRAM later when a real Haystack client (Haxall script, SkySpark) requires it. Saves about a day of code; no functional difference for AI clients we control.

### Example session — AI uses both

User: *"motions in @case-Foo that are signed but past the response deadline?"*

```
1. Haystack: GET /api/haystack/read?filter=motion and signed and caseRef==@case-Foo and dueBy <= now()
   → grid of Motion record dicts (fast, structured, no LLM-authored SQL)

2. MCP: query_case_knowledge(query: <motion.title>, caseId: "case-Foo") for each motion
   → relevant passages + citations

3. MCP: retrieve_exhibit(...) for any exhibits referenced
   → image URIs

4. AI composes: rule citation from Haystack record (caseRef + dueBy + ruleRef →
   proc.tx::Rule) + free-text passages from MCP query_case_knowledge.
```

Haystack answers *which records*. MCP answers *what to do with them*. The chat uses both transparently.

### Implementation order

1. **Land `src/lib/legal/repo.ts` + `xeto-namespace.ts`.** Refactor any MCP tools that touch Prisma directly to call `repo.ts`. No wire change.
2. **Build `haystack-filter-sql.ts`** using `haystack-core`'s `HFilter.parse()` to compile to SQLite `json_extract(...)`. Unit-test against a fixture set.
3. **Stand up `/api/haystack/[op]`** with `about`, `ops`, `libs`, `defs`, `filetypes`, `nav`, `read`, `close`. Bearer auth.
4. **Add `commit`** once the read path is solid.
5. **Add SCRAM** if a real client needs it.
6. **Add `watchSub` / SSE** when there's an actual subscriber; until then `/api/progress` covers in-app push.

### What stays MCP-only (forever)

- PDF rendering / page extraction
- Exhibit image retrieval
- Draft chat streaming
- AI helpers: `analyze_citations`, `detect_contradictions`, `extract_obligations`, etc.
- Action-graph derivation (the React Flow data source from §7)
- Sidecar orchestration commands

These are all action-shaped and don't fit Haystack's record-or-grid contract.

### What stays Haystack-only (forever)

- Schema discovery (`defs`, `libs`)
- Bulk record reads with filter syntax
- Future watch/SSE for record changes
- Compatibility with off-the-shelf Haystack clients (Haxall scripts, SkySpark)

That last item matters: if a customer ever wants to point SkySpark at Sound Suite, they get a working data source for free. The MCP layer wouldn't help them.

## 12. References

**XETO + Project Haystack**
- XETO compiler — https://github.com/Project-Haystack/xeto (active, May 2026, 269 commits, 40 stars, DOE-funded)
- Project Haystack v4 — https://project-haystack.org/doc/docHaystack
- Hayson JSON encoding — https://project-haystack.org/doc/docHaystack/Json
- Haxall (the only XETO runtime today) — https://haxall.io
- **`@haxall/haxall` — npm package (XETO + Folio + Haystack runtime, Fantom-compiled JS, AFL-3.0)** — https://www.npmjs.com/package/@haxall/haxall
- Haystack HTTP API spec — https://project-haystack.org/doc/docHaystack/HttpApi
- Standard ops catalog — https://project-haystack.org/doc/docHaystack/Ops
- SCRAM auth (RFC 7804 binding) — https://project-haystack.org/doc/docHaystack/AuthMsg

**j2inn JS/TS stack**
- `haystack-core` — https://github.com/j2inn/haystack-core (npm `haystack-core@3.0.9`, last push 2026-02-23)
- `haystack-codegen` — https://github.com/j2inn/haystack-codegen (defcodegen — TS interfaces from Haystack defs)
- `haystack-units` — https://github.com/j2inn/haystack-units
- `haystack-react` — https://github.com/j2inn/haystack-react (npm, last push 2025-09-10)

**ORM / database**
- Prisma SQLite Json type (added v6.2.0) — https://github.com/prisma/prisma/issues/3786
- Prisma 7 + Next.js 16 Turbopack — see `upgrade-nextjs-prisma.md`
- Prisma 8 / `prisma-next` extension packs — see `prisma-8-readiness.md` for how
  they would replace the hand-rolled `haystackFilter()` SQL emitter once stable
- SQLite expression indexes — https://www.sqlite.org/expridx.html

**Visual graph**
- React Flow / XYFlow — https://reactflow.dev (`@xyflow/react`)
- Rete.js — https://rete.js.org (rejected for our use case)

**Procedural rules (sample)**
- Texas TRAP — https://www.txcourts.gov/rules-forms/rules-standards/
- California CCP — https://leginfo.legislature.ca.gov/faces/codesTOCSelected.xhtml
- FRAP — https://www.law.cornell.edu/rules/frap
