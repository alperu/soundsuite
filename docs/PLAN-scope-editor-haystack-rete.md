# PLAN — Haystack Block View: Filtering | Editor (Rete.js scope editor + tag mapping)

Date: 2026-08-11 (rev 2). Status: **PLAN ONLY — no code written.**
Sources: three research agents — `research-haystack-model` (entity model + scope enforcement),
`research-retejs-sedona` (Rete.js + sedonaWebEditor patterns), `research-tag-editor`
(existing TagPanel, tag write path, unconnected-filing enumeration).

## What this is

A reusable two-tab component — **Haystack Block View** — with tabs **Filtering** and
**Editor**, opened full-page from a small button next to Case Scope in the search page's
right-menu Settings tab, and embeddable elsewhere in the app.

- **Filtering**: a Rete.js block canvas rendering the Haystack model (cases → typed
  filings → connected responses/replies/attachments) with **cascading selection**: select a
  case → everything in it; select a motion → the motion plus everything connected to it
  (responses, replies, amendments); deselect granularly. The resulting scope **overrides**
  the case-scope dropdown and any preset while active.
- **Editor**: the mapping workbench. Shows **unconnected filings** (and entities with
  missing refs) as a worklist; selecting one opens the existing structured **TagPanel** to
  assign `respondingTo` / `replyingTo` / `motionRef` parentage / person refs / amendment
  links. The intended loop: **Filter → notice the graph isn't ready → Editor → connect →
  back to Filter** with the cascade now walking real edges.

## Decision 0 — REVERSED from rev 1: no schema migration needed

Rev 1 assumed `respondingTo`/`replyingTo` "have nowhere to live" and deferred motion-level
edges to a v2 with new Prisma columns. **Wrong.** Findings (research-tag-editor):

- `splitPatch` in `src/lib/haystack/commit.ts` routes any key not in `NON_TAG_COLUMNS`
  into the **tags JSON** — the tag bag is open, XETO specs are unsealed, and validation
  (`validate.ts:59`, `ignoreRefs: true`) cannot reject an extra slot. The read path
  (`api/haystack/[op]/route.ts:335-352`) hoists tag keys generically, tags win over
  columns.
- `TAG_SPEC_BY_KIND` **already declares both slots with ref pickers**: `respondingTo`
  (kind `response` → target motion, `tag-spec.ts:1273`) and `replyingTo` (kind `reply` →
  target motionAttachment, `:1278`). The shipped TagPanel already renders working pickers
  for them — 0 rows have exercised it.
- Shadow parentage is self-healing: assigning a real `motionId` flips
  `synthesizeRefsFromColumns` from suppressing to surfacing `motionRef`
  (`refs.ts:119-128`); `motionId != id` is a clean "connected" signal.

**One small prerequisite (~12 lines, not a migration)** — without it edges save but render
as raw cuids and the label cache goes stale:
- `refs.ts:179` `REF_TARGET_TABLE`: add `respondingTo: 'Motion'`; widen the value union
  with `'MotionAttachment'`; add `replyingTo: 'MotionAttachment'`.
- `refs.ts:357` `computeDis`: add a `MotionAttachment` case.

**Hard rule for all graph/cascade queries:** read **columns AND tags JSON** (mirror
`route.ts:335-352`). Live data proves columns-only misses edges: 5 Motions carry
`movantRef`/`respondentRef` in tags while all 44 relationship columns are null.

## Current data reality (drives the Editor worklist)

5 Cases → 80 Filings → 819 Documents (82 INDEXED). Motions: 44, all shadow
(`id == filingId`); **39 unconnected** under the tag-aware definition. MotionAttachments:
28, all shadow-parented, **28 unconnected**; 0 have `respondingTo`/`replyingTo` yet.
Immediately linkable: **6 Responses (respondingTo) + 1 Reply (replyingTo)** — so the
Editor must surface *all* missing refs (person refs, motionRef parentage, amendment
links), not just responds/replies, or it looks nearly empty.

"Unconnected" definitions (SQL, columns + `json_extract(tags, …)`) are in the
research-tag-editor report — attachment: shadow `motionId = id` AND no amends/supersedes/
authoredBy AND no respondingTo/replyingTo/motionRef in tags; motion: all relationship
columns null AND no judgeRef/movantRef/respondentRef in tags.

## Component design

```ts
// src/components/haystack-block-view/  (new)
interface HaystackBlockViewProps {
  scope: { kind: 'case'; caseId: string } | { kind: 'all' };
  initialTab?: 'filtering' | 'editor';
  readOnly?: boolean;                                // Filtering-only hosts
  focusEntity?: { kind: EntityKind; id: string };    // Editor opens on this row
  onScopeChange?: (scope: ScopeSelection) => void;   // Filtering → host
}
```

### Filtering tab (Rete.js canvas)

Stack (all OSS — the `retejs/pro-main` repo is example apps over public npm packages;
members-only example *source* → reimplement patterns, never copy): `rete@^2`,
`rete-area-plugin`, `rete-react-plugin`, `rete-render-utils`, `rete-auto-arrange-plugin`
(fallback layout), optional `rete-minimap-plugin`. **No `rete-connection-plugin`** — the
canvas is read-only structure; edge *creation* belongs to the Editor tab's TagPanel, not
to edge-dragging.

Patterns from sedonaWebEditor (file refs in the rete research report): three-layer split
(types / node factory / traversal), **rete node id = entity id**, memoized socket
registry, position-before-add + paint tick before edges, ghost node parked off-screen for
out-of-view refs, custom `accumulating.active() → true` (or no `selectableNodes` at all)
so rete never fights the store, viewport culling via `area.addPipe` when >150 nodes.

Layout v1: hand-rolled columns — Case | Filing (typed blocks; type drives color/icon) —
rows grouped per parent; connected responses/replies indent under their target motion once
edges exist. `elkjs` layered only if cross-links outgrow columns. Documents collapse into
a count badge on the filing block (filings are 1:1 with documents today).

Cascade selection (the invented part — no precedent in either reference repo): selection
is **domain state** in a store (`selected: Set<entityKey>`), tri-state per parent
(`all`/`some`/`none`); toggle case → subtree; toggle motion → motion + entities reachable
via respondingTo/replyingTo/amends/motionRef (BFS over the graph payload, cap ~50 like
graph-expand); deselect child → recompute ancestors. Rete only displays it: node
components read `selected`/`partial` off the node subclass; store pushes **batched
diffs** (`area.update('node', id)` for changed ids only).

Toolbar: Select all / Clear / per-case toggles / live counter ("N filings across M cases,
K indexed docs") / **Apply scope** / Clear scope / an "unmapped entities: N → Edit" pill
that jumps to the Editor tab (the filter→edit→filter loop's visible hinge).

### Editor tab (mapping workbench — composes, never rebuilds)

**Amendment 2026-08-13 (user direction):** the Editor tab becomes THREE panes — worklist
(left, collapsible) | **rete canvas (middle)** | **TagPanel (right)**. The canvas is shared
with the Filtering tab: Filtering mode = cascade selection; Editor mode = **block
programming**: the canvas shows all cases, filings, AND an "Unlinked" lane (unconnected
entities + unfiled documents as visible blocks), `rete-connection-plugin` is enabled in
editor mode only, and drawing a connection commits the corresponding ref (response→motion
= respondingTo, reply→response = replyingTo, filing→motion = motionRef, file→case = link)
via hsCommit + an `entity-updated` dispatch. Clicking a block loads its tags in the
right-hand TagPanel. A **file droplet** drop zone lets the user add files and link them to
cases from the editor (upload mechanism: reuse an existing path if one fits; otherwise UI
stub + follow-up). Edge-creation and droplet may phase as follow-ups if needed —
Filtering-tab completion is not to be sacrificed.

- Left: the **unconnected worklist** — grouped by case, badged by what's missing
  ("no parent motion", "no respondingTo", "no persons"), filterable by kind. Backed by a
  new `GET /api/scope/unconnected` running the tag-aware SQL above.
- Right: the existing **`TagPanel`** (`src/components/case/tag-panel.tsx:54` — already a
  standalone component with a 4-prop surface: `entityKind`, `entityId`, `entityLabel`,
  `onRename`). It already renders the `respondingTo`/`replyingTo` ref pickers and already
  persists through `hsCommit → /api/haystack/commit → commitEntity`.
- **Prereq before embedding**: break the window-event coupling. TagPanel listens to global
  `selected-entity-changed` / `entity-updated` events (`tag-panel.tsx:237-248`,
  `case-management/layout.tsx:1184`) — a second mounted instance fights the layout's. Add
  a prop to suppress the global listener (drive by props), or move selection fully into
  the existing `SelectedEntityProvider` context.
- After a save, refresh the worklist row + graph payload so the Filtering tab reflects the
  new edge immediately (TagPanel already emits `entity-updated`).
- XETO note: per-kind slot lists come from `TAG_SPEC_BY_KIND` (`tag-spec.ts`), not from
  XETO at runtime (defs supplies doc strings only). **Extend the TS table when new slots
  are needed; do not build a spec-driven slot loader** (real `opDefs` change, low value).
  Spec↔table drift is a separate hygiene task.

## Data access

New `GET /api/scope/graph`: all cases → filings (id, type, safe label, docCount,
indexedCount, **connectivity refs read from columns+tags**: motionRef/respondingTo/
replyingTo/amends/supersedes) → per-filing document ids/status. Few hundred KB at current
scale (5/80/819) — one fetch, no pagination. Unindexed documents included but flagged
(default: greyed in UI). Plus `GET /api/scope/unconnected` for the Editor worklist. The
haystack `[op]` protocol route stays untouched (external-client surface).

## Scope enforcement (unchanged from rev 1 — plumbing already exists one layer down)

Chunks carry `filing_id` (`vector-store.ts:100-135`); `buildWhereClause` accepts
pre-escaped `filter._rawWhere` (`:826-831`); `query_case_knowledge` exposes
`whereClauses` (`query-case-knowledge.ts:33`); deep search threads them per sub-query
(`deep-search.ts:300-301, 440-444`).

1. `scopeToWhereClauses(scope)` → single union clause
   `(case_id IN ('c1') OR filing_id IN ('f1','f2'))`: fully-selected cases in the
   `case_id` arm (new filings auto-in-scope; the 4 indexed docs without filingId stay
   reachable), partially-selected cases contribute filing ids. SQL-escape at call site.
2. Passthrough: `whereClauses?: string[]` on `/api/search/unified` (body :26-31, forward
   :71) and `/api/search/ai` (:101, :154); thread through `deep-search-runner.ts`
   (:63, :198) and `ai-search-runner.ts`.
3. **THE bug not to write**: clauses AND-join and `caseId` merges first — scope active ⇒
   send `whereClauses` and **omit `caseId` entirely** at the four request sites in
   `search-interface.tsx` (:962-964, :1474, :1502, :1638).
4. Pattern search / exhibit retrieval (Prisma paths) out of v1; follow-up takes
   `{caseIds, filingIds}` directly.

## Persistence + precedence

IndexedDB: `search.scopeSet` = `{ caseIds: string[], filingIds: string[], version: 1 }`
+ `search.scopeSetActive: boolean` (case/filing ids separate — preserves "whole case"
intent as filings land). `search.aiCaseId` untouched — deactivate = zero-migration
restore. Precedence enforced **at request-build time**: scope active → whereClauses, no
caseId; presets may still write `aiCaseId` harmlessly. UI: pill replacing the Case Scope
select in Settings ("Scoped by graph: N filings, M cases — Edit / Clear"), badge on the
preset dropdown, banner on the block-view page.

## Embedding hosts (reuse survey — corrected route names; there is no /vectors page)

| Host | scope | initialTab | mode |
|---|---|---|---|
| `/scope` page (button beside Case Scope in Settings) | all | filtering | editable |
| `case-management/page.tsx` | all | filtering | editable |
| `case-management/[caseNumber]/page.tsx` | that case | filtering | editable |
| `case-management/[caseNumber]/[filingSlug]/page.tsx` | that case, `focusEntity` = filing | editor | editable |

## Implementation order (post-approval)

1. **refs.ts prereq** (~12 lines): `respondingTo`/`replyingTo` in `REF_TARGET_TABLE`,
   union widen, `computeDis` MotionAttachment case. Independently shippable + testable
   via the existing filing-page TagPanel.
2. `GET /api/scope/graph` + `GET /api/scope/unconnected` (columns+tags reads).
3. Scope enforcement: `scopeToWhereClauses` + route/runner passthrough + four
   request-site precedence guards + `search.scopeSet` persistence. Testable without any
   canvas — ship before UI.
4. TagPanel embedding escape hatch (suppress global listener prop / context selection).
5. `HaystackBlockView` shell + **Editor tab** (worklist + embedded TagPanel). Editor
   first — it makes the data worth filtering.
6. **Filtering tab**: rete bootstrap (dynamic import, ssr:false, definite-height
   container), column layout, typed blocks, edges from columns+tags, cascade store +
   tri-state + batched diffs, toolbar + "unmapped → Edit" pill.
7. Settings-tab button + scope pill + preset-dropdown badge; embed in the three
   case-management hosts.
8. Polish: culling, minimap, unindexed greying.

## Open questions

1. Unindexed documents (737/819): greyed-but-visible (recommended) or hidden?
2. Editor worklist scope: all missing refs (recommended — else ~7 rows) vs
   responds/replies only?
3. Should Apply-scope require zero unmapped entities in selected cases, or just warn
   (recommended: warn via the pill)?
4. v1 scope governs vector search only (recommended); pattern/exhibit tools follow-up.
