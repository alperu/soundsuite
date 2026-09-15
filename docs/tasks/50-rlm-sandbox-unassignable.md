# `ss-rlm-sandbox` cannot be assigned on any host — no runtime resolves it

**Status:** **Implemented 2026-09-15** — steps 1–8 all landed; not yet exercised against a live sidecar (see *Verification status*) · **Effort:** S–M · **Priority:** **P1** — the mode shipped in every catalog, rendered an enabled radio, persisted the click, and was then silently dropped by the sidecar
**Created:** 2026-09-15
**Root cause:** `sideCar/src/lib/mode-templates.ts:381` (`resolveModeForRuntime` has no `ss-rlm-sandbox` case in any of its four runtime branches)
**Secondary:** `src/components/admin-role-assignments.tsx` (no port, no runtime map, no reset default) · `src/lib/db/role-registry.ts:245` (`RUNTIME_VALUES` omits `docker-model-runner`)
**Related:** [`docs/SPEC-ss-rlm-sandbox.md`](../SPEC-ss-rlm-sandbox.md) — the two-master contract this mode exists to serve

---

## Symptom

On `/admin/roleassign`, `ss-rlm-sandbox` looks assignable and is not.

The row renders for every host. Its **Port** column shows `—`. On a Mac the
*Ollama (native)* and *Docker Model Runner* radios are **enabled** (not greyed
out) — clicking one POSTs successfully and the row comes back `enabled: true`.
The sidecar then drops the mode on the next `/config` push and nothing ever
starts.

This is not "the checkbox is disabled". It is **accepts the click, resolves to
nothing** — which is why it reads as "I can't assign it" without any error
surfacing. The one cheap confirmation is the sidecar log:

```
[<master-url>] Mode "ss-rlm-sandbox" runtime "host" not satisfiable on mac-docker-ollama — skipping
```

(`sideCar/src/lib/ws-client.ts:606`). Grep a live sidecar's log for
`not satisfiable` before starting — if that line is absent, the premise below
is wrong and the diagnosis needs redoing.

## Root cause — the working code path is unreachable

`resolveMode(mode, hostOs, runtime)` (`sideCar/src/lib/mode-templates.ts:152`)
has **two** paths:

```ts
// mode-templates.ts:172
if (runtime) {
  return resolveModeForRuntime(mode, hostOs, runtime, containerName);
}
// …falls through to the legacy OS-derived switch below
```

The OS-derived switch **does** handle the mode correctly —
`case 'ss-rlm-sandbox':` at `mode-templates.ts:338` returns the right
`ContainerDef` (`port: 8101`, `vram: 0`, `requiresGpu: false`, `runtime: 'docker'`).

But that branch is only reached when `runtime` is `undefined`, and the master
**always sends a runtime**: `getRuntimesForHost()`
(`src/lib/db/role-registry.ts:280`) fills an entry for every enabled row —
the stored `runtime` column, or `defaultRuntimeFor(mode, hostOs)` when null,
which returns `'docker-ollama'` on linux/windows and `'host'` on Mac. That map
is sent as `runtimes` on both push paths (`src/lib/gpu/fleet-router.ts:921` and
`:1099`).

So control always lands in `resolveModeForRuntime`, and that function has
**no `ss-rlm-sandbox` case in any branch**:

| Branch | Line | What happens for `ss-rlm-sandbox` |
|---|---|---|
| `runtime === 'host'` | `:389` | Switch has cases for the 4 Ollama modes + explicit `return null` for `ss-reranker`/`ss-rlm`. No sandbox case → falls out of the switch → reaches `return null` at `:623`. |
| `runtime === 'docker-ollama'` | `:448` | `if (!dockerSupportsGpu()) return null` (Mac: immediate null). On Linux/Windows it passes the guard, then the switch has no sandbox case → `return null`. |
| `runtime === 'docker-vllm'` | `:513` | `if (!dockerSupportsGpu()) return null`, then only `ss-reranker` and `ss-rlm` are handled → `return null` at `:543`. |
| `runtime === 'docker-model-runner'` | `:564` | Only `ss-embedding`/`ss-completion`/`ss-ocr`/`ss-reranker` → `return null` at `:620`. |

**This is broken on every host, not just Mac.** Linux defaults to
`docker-ollama` (dead end) and Mac to `host` (dead end). Mac/Windows is the
symptom that got noticed, not the shape of the bug — a Mac-only patch leaves
Linux equally broken.

Note the two `dockerSupportsGpu()` guards are themselves wrong for this mode:
`ss-rlm-sandbox` is a `python:3.x` REPL container with `requiresGpu: false`
(`sideCar/src/lib/state.ts:236`), deliberately added so container creation
skips its GPU-only behaviour. The *container* already knows it needs no GPU;
the *runtime resolver* does not.

## What already works — do not rebuild it

Each row below was read at the cited line, not taken from a comment.

| Layer | State | Evidence |
|---|---|---|
| Sidecar container definition | **Done** | `state.ts:220` — `port: 8101`, `vram: 0`, `type: 'vllm'`, `requiresGpu: false`, `containerName: ss-rlm-sandbox` |
| Sidecar OS-default resolution | **Done** (unreachable) | `mode-templates.ts:338` |
| GPU-less container creation | **Done — verified** | `containers.ts:178` and `:657` both gate on `def.requiresGpu !== false`; `docker.ts:785` sets `config.RequiresGpu` from it and `:919` omits `HostConfig.DeviceRequests` when it is `false`. The guards are real, not just documented. |
| Mode → role key mapping | **Done — verified** | `mode-templates.ts:131` `modeToRole` is `mode.replace(/^ss-/, '')`, a slice and not a lookup table, so `rlm-sandbox` cannot be silently dropped there. |
| Master mode catalog | **Done** | `src/lib/gpu/mode-catalog.ts` — in `ModeName`, `ALL_MODES`, `MODE_METADATA` with `availableOn: ['linux','mac-docker-ollama','windows-docker-wsl2']`, `resolveModelFromConfig` reads `cfg.rlmSandboxModel` |
| Master routing to `:8101` | **Done** | `src/lib/ai/stream-rlm.ts:78` `RLM_SANDBOX_PORT = 8101`; the Phase-2 fallback at `:307` requires `containers['rlm-sandbox'].status === 'running'`. Covered by `src/lib/ai/__tests__/stream-rlm-sandbox-fallback.test.ts` |
| Model picker | **Done** | `/admin/openrouter` → `rlmSandboxModel` |
| Mode Types reference page | **Done** | `src/components/admin-role-types.tsx:98` |

The port the user asked for — **8101** — is therefore not a new decision. It is
already the sidecar's registry value and already what the master dials. This
task makes the admin UI agree with it, and makes the sidecar actually resolve it.

## Decision: add a fifth runtime value `'docker-cpu'`, not reuse `docker-vllm`

The discriminator is the Prisma column. `prisma/schema.prisma:486`:

```prisma
runtime        String?  @default("docker-ollama")
```

It is a nullable `String`, **not an enum** — so a new value costs **no
migration**, and the repo's migration gate (explicit user approval + DB backup
before any `prisma migrate`) is not in play. That makes the honest option the
cheap one, so take it.

Add `'docker-cpu'` — *plain Docker, no GPU* — as a fifth `RuntimeChoice`,
surfaced on `/admin/roleassign` as a fifth column (the "dockerOnly tab" from the
request). Semantics: run the role's image as an ordinary container with **no GPU
passthrough and no `dockerSupportsGpu()` gate**, available on **every OS that
has a Docker daemon** — Mac, Windows and Linux alike.

**Why `docker-cpu` and not the obvious `docker`.** The sidecar already has a
type named `RoleRuntime` (`sideCar/src/lib/state.ts:21`):

```ts
export type RoleRuntime = 'docker' | 'host' | 'docker-model-runner';
```

and every docker-backed `ContainerDef` sets `runtime: 'docker'` on it —
including `ss-rlm-sandbox`'s. That is a **different axis** from `RuntimeChoice`
(which distinguishes *which* docker engine), living in an adjacent field with
the same name. Naming the new operator-facing choice `'docker'` would make one
identifier mean two things in two `runtime` fields one struct apart — exactly
the objection raised against reusing `docker-vllm`. Keep them distinguishable:
`RuntimeChoice.'docker-cpu'` resolves to `RoleRuntime.'docker'`.

Rejected alternative: reuse `docker-vllm` and thread a `requiresGpu`-aware
escape past the two `dockerSupportsGpu()` guards. It works, but it makes
`docker-vllm` mean two different things, keeps the UI lying (the column says
"Docker vLLM" for a Python REPL), and puts a per-mode exception inside a guard
whose whole job is to be blanket. The new value is a handful more lines and
leaves the invariant intact.

Today `'docker-cpu'` applies only to `ss-rlm-sandbox`. That is fine — it is the
correct home for any future non-GPU containerised role.

## The runtime union is copied five times

Widening it means touching all five. Changing the **type** first makes the
TypeScript compiler enumerate the UI call sites that need a new entry, because
`Record<RuntimeChoice, boolean>` becomes non-exhaustive — use that as the
mechanism for step-by-step coverage rather than grepping.

| # | Location | Current values | Action |
|---|---|---|---|
| 1 | `sideCar/src/lib/mode-templates.ts` (`RuntimeChoice`) | 4 | Add `'docker-cpu'` — the branch the fix lives in |
| 2 | `src/components/admin-role-assignments.tsx:48` | 4 (incl. DMR) | Add `'docker-cpu'` + a `RUNTIME_COLUMNS` entry |
| 3 | `src/lib/db/role-registry.ts:62` | 4 (incl. DMR) | Add `'docker-cpu'` |
| 4 | `sideCar/src/lib/ws-client.ts:598-603` | inline 4-string whitelist | Add `'docker-cpu'` |
| 5 | `sideCar/src/app/setup/page.tsx:68` | **3** — no DMR at all | See below |

**(5) is deliberately out of scope.** It is the sidecar's own standalone setup
page with its own hand-maintained `MODE_CATALOG` that lists neither `ss-rlm`
nor `ss-rlm-sandbox`, and whose `inferRuntime()` maps `docker-vllm` → DMR. It
is already out of sync with the master on two counts before this change. Fixing
it is a separate reconciliation task; the consequence of deferring is that a
sidecar configured locally through `/setup` still cannot select the sandbox —
only master-driven assignment will work. **Say this in the PR description** so
it is a known limitation rather than a surprise.

## Bug to fix in passing: `RUNTIME_VALUES` silently drops DMR rows

`src/lib/db/role-registry.ts:245`:

```ts
const RUNTIME_VALUES: RuntimeChoice[] = ['host', 'docker-ollama', 'docker-vllm'];
```

`'docker-model-runner'` is missing, although it is in the exported
`RuntimeChoice` type on line 62 and documented in that file's own doc comment.
`isRuntimeChoice()` therefore returns `false` for a stored `docker-model-runner`
row, and `getRuntimesForHost()` silently substitutes
`defaultRuntimeFor(mode, hostOs)` — which for `ss-rlm` on Mac yields `'host'`,
a runtime `resolveModeForRuntime` explicitly refuses for `ss-rlm`
(`mode-templates.ts:450`, "No host-vLLM path today").

So **`ss-rlm` on a Mac is already broken the same way**, and this directly
contradicts what `src/components/__tests__/admin-role-assignments-ports.test.ts:102`
asserts the UI shows ("the DMR endpoint for `ss-rlm` on an unconfigured Mac,
not 8100"). Fix it here: the constant must list all five values.

## Stale rows: the operator who reported this is the one who stays broken

The symptom is that the click **persists**. So any host where someone already
tried to enable the sandbox now holds a `HostRoleAssignment` row with
`mode: 'ss-rlm-sandbox'` and `runtime: 'host'` or `'docker-model-runner'`.

After the fix, `runtimesForMode('ss-rlm-sandbox')` returns `host: false`, so
that row renders as a **checked-but-disabled** radio with the new `docker-cpu`
column unchecked — and `resolveModeForRuntime(…, 'host')` still returns null.
The fix would ship and the reporter would see no change.

`'docker-cpu'` is the *only* valid runtime for this mode, so normalize rather
than migrate: in `getRuntimesForHost()`, coerce `ss-rlm-sandbox` to
`'docker-cpu'` regardless of the stored column (~2 lines), and do the same in
`resolveRuntime()` in the UI component so the radio renders where the sidecar
will actually run it. That fixes existing rows without a data migration and
without asking the operator to notice anything. If normalization is rejected,
the acceptance criteria must instead state that a stale row requires a re-click
or **Reset to defaults** — silence is the one option that is not acceptable.

## Sidecar defaults are missing the role entirely

`sideCar/src/lib/state.ts` keys two maps by short role name, and neither has
`rlm-sandbox`:

- `idleTimeouts` (`:422`) — `getIdleTimeoutForRole('rlm-sandbox')` falls through
  to `state.idleTimeouts.reranker || IDLE_TIMEOUT_MS` ⇒ 5 minutes.
- `minOnline` (`:434`) — `state.minOnline['rlm-sandbox'] ?? 0` ⇒ **0**, which
  `idle-timers.ts:48` and `handlers.ts:346` treat as a HARD "never auto-start".

## The `minOnline` decision: `1`, not `0`

There is a real tension and it has to be resolved explicitly, because both
answers are defensible in isolation:

- `minOnline: 0` — matches the mode's *purpose*: an on-demand fallback the
  master reaches only when no sidecar has `ss-rlm` running. **But** `0` is a
  hard never-auto-start gate, so the container never starts, so
  `resolveRlmEndpoint()`'s Phase-2 check (`stream-rlm.ts:333`,
  `sandboxCS.status !== 'running' → continue`) never matches, so **the fallback
  can never fire**. The mode would be assignable and still useless.
- `minOnline: 1` — pre-starts a container for a fallback that may never be
  used. The cost is one `python:3.x` process at **`vram: 0`**.

**Take `minOnline: 1`.** A zero-VRAM Python container being resident is a
rounding error; a fallback that structurally cannot fire is a defect. Pair it
with `idleTimeoutMin: 0`, which `idle-timers.ts:31` treats as *idle timer
disabled* (and which `minOnline >= 1` would override anyway at `:48`) — the
same shape `RESET_DEFAULTS` already uses for `ss-embedding`.

Separately, `setAssignment`'s create-branch hardcodes a 60-minute idle timeout
for `ss-rlm`/`ss-reranker` only (`role-registry.ts`, `idleTimeoutMin:` ternary).
`ss-rlm-sandbox` should **not** join that list — it gets `0` per the above, and
its cold start is an image pull plus a Python process, not a weights load.

## Implementation steps

1. **`sideCar/src/lib/mode-templates.ts`** — the fix that matters. Widen its
   `RuntimeChoice` to include `'docker-cpu'`. In `resolveModeForRuntime`, add an
   `ss-rlm-sandbox` case that returns the same `ContainerDef` as the OS-default
   branch at `:338` (`port: 8101`, `vram: 0`, `type: 'vllm'`,
   `modes: ['searching']`, `priority: 'normal'`, **`runtime: 'docker'`** — the
   `RoleRuntime` value, not the `RuntimeChoice` one — and `requiresGpu: false`)
   for `runtime === 'docker-cpu'`, **placed before any `dockerSupportsGpu()`
   guard**. Return `null` for `host` and `docker-model-runner` with a comment
   saying why (no native process, no DMR engine — it is not an inference server).
2. **`sideCar/src/lib/ws-client.ts:598-603`** — add `'docker-cpu'` to the inline
   whitelist, or replace the four-way comparison with a shared predicate so
   this copy cannot drift again.
3. **`sideCar/src/lib/state.ts`** — add `'rlm-sandbox': 0` to `idleTimeouts`
   and `'rlm-sandbox': 1` to `minOnline`.
4. **`src/lib/db/role-registry.ts`** — add `'docker-cpu'` to the `RuntimeChoice`
   type (`:62`) and to `RUNTIME_VALUES` (`:245`) **together with the missing
   `'docker-model-runner'`**; add an `ss-rlm-sandbox → 'docker-cpu'` branch to
   `defaultRuntimeFor()`; normalize `ss-rlm-sandbox` to `'docker-cpu'` in
   `getRuntimesForHost()` per the stale-row section.
5. **`src/components/admin-role-assignments.tsx`** — the compiler will point at
   most of these once step 4 lands:
   - `RuntimeChoice` (`:48`) + a `RUNTIME_COLUMNS` entry
     `{ key: 'docker-cpu', short: 'docker-only', label: 'Docker (no GPU)' }`.
   - `MODE_PORTS` (`:73`) — add `'ss-rlm-sandbox': 8101`.
   - `availableRuntimesForOs()` (`:154`) — `'docker-cpu': true` for **all three**
     OSes (that is the point: no GPU, so no passthrough question).
   - `runtimesForMode()` (`:184`) — `ss-rlm-sandbox` ⇒ only `'docker-cpu': true`;
     everything else ⇒ `'docker-cpu': false` (no other role is GPU-less today).
   - `defaultRuntimeForRow()` (`:195`) — `ss-rlm-sandbox` ⇒ `'docker-cpu'` on
     every OS.
   - `resolveRuntime()` (`:215`) — coerce `ss-rlm-sandbox` to `'docker-cpu'` so
     stale `host`/DMR rows render on the right column.
   - `FALLBACK_MODES` (`:233`) — add the entry with all three OSes, so the row
     survives a `/api/admin/mode-catalog` outage.
   - `RESET_DEFAULTS` — add `'ss-rlm-sandbox': { minOnline: 1, idleTimeoutMin: 0 }`.
   - The `!modeAvailableOnHost` tooltip (`:818`) hardcodes the reranker's
     vllm-metal message for anything that is not `ss-ocr`. Make it mode-aware
     rather than adding a third branch to a two-way string.
6. **`prisma/schema.prisma:480-485`** — comment-only: the enumeration in the
   `runtime` doc comment lists three values and is now two short. No migration.
7. **Tests** — add to `src/components/__tests__/admin-role-assignments-ports.test.ts`:
   `portForRuntime('ss-rlm-sandbox', 'docker-cpu') === 8101`; and
   `defaultRuntimeForRow('ss-rlm-sandbox', <each os>, false) === 'docker-cpu'` so
   the disabled-row port reads 8101 on Mac rather than falling back to 11434.
   Add a `role-registry` case asserting `isRuntimeChoice('docker-model-runner')`
   is `true` — that is the regression guard for the drop-through bug — and one
   asserting `getRuntimesForHost` normalizes a stale `ss-rlm-sandbox` row.
8. **`docs/tasks/README.md`** — add the table row, as every other task has.

## Acceptance criteria

Deliberately **not** "`ss-rlm-sandbox` runs on a Mac". The image
`soundsuite/rlm-sandbox:latest` **does not exist yet** — `state.ts:216` says so
in its own comment — and the host-side callback proxy (SPEC steps 3–4) is not
built. Done here means the *assignment path* works end to end:

1. `/admin/roleassign` shows `ss-rlm-sandbox` with a **Docker (no GPU)** column
   selectable on a Mac, a Windows and a Linux sidecar, and **Port 8101** in the
   Port column (including on a disabled row).
2. Clicking it persists `runtime: 'docker-cpu'`, `minOnline: 1` in
   `HostRoleAssignment`, and survives a page reload.
3. A row that was already saved with `runtime: 'host'` or
   `'docker-model-runner'` renders on the `docker-cpu` column and resolves
   correctly **without** the operator re-clicking anything.
4. The next `/config` push produces **no** `not satisfiable … skipping` line
   for `ss-rlm-sandbox`, and the sidecar's `/api/status` reports an
   `rlm-sandbox` container entry with `config.port === 8101`.
5. `getRuntimesForHost()` round-trips `'docker-cpu'` — and a stored
   `'docker-model-runner'` row for `ss-rlm` is no longer silently rewritten.
6. **Expected and acceptable at this stage:** `docker pull
   soundsuite/rlm-sandbox:latest` fails (manifest unknown). Verify it fails
   *cleanly* — `state.pullFailCount['rlm-sandbox']` reaches 3 and the sidecar
   stops retrying (`containers.ts:546`, `handlers.ts:127`) rather than
   retry-looping a multi-GB pull forever. If it loops, that is a second defect
   and belongs in this task.

Because of (6), an operator who enables the row will see a pull failure. Say so
in the UI or the PR notes, or they will reasonably conclude the fix did not land.

## Verification status (as implemented, 2026-09-15)

**Checked, and passing:**

- `npx tsc --noEmit` — sidecar reports *No errors found*; master reports no
  errors in any touched file (the master tree has unrelated pre-existing
  errors in `next.config.ts` and several test files).
- Sidecar suite: **114/114 pass**, including 11 in
  `mode-templates-rlm-sandbox.test.ts` (8 of them new, all on the explicit-
  runtime path that previously had no coverage at all).
- Master suite, diffed against a clean `HEAD` worktree: baseline 17 failing
  suites / 89 failing tests → with this change 12 / 77. **Zero new failures**;
  every remaining failure is a subset of the baseline set and fails to *load*
  (`PrismaClientInitializationError`, missing native modules), not to assert.
  The 5-suite difference is baseline flakiness, not something this fixed.
- ESLint on the two largest changed files: the single
  `react/no-unescaped-entities` error in `admin-role-assignments.tsx` is
  **pre-existing** — confirmed identical with this change stashed.

**NOT checked — do this before believing the feature works:**

1. **No live sidecar was touched.** The `not satisfiable` log line that proves
   the original diagnosis was never observed; it was read out of
   `ws-client.ts:606`. Grep a running sidecar for it before and after
   deploying.
2. **No `/config` push was observed.** Acceptance criteria 3 and 4 (a stale
   row self-healing, and `/api/status` reporting `config.port === 8101`) are
   untested end-to-end.
3. **The container has never started**, because
   `soundsuite/rlm-sandbox:latest` still does not exist. Criterion 6 — that
   the pull fails *cleanly* at `pullFailCount >= 3` rather than retry-looping
   — is unverified, and is the most likely place for a follow-up defect.

## Risks and open questions

- **Not reproduced live.** Every claim above is read from source at the cited
  lines; nothing was exercised against a running fleet. Grep a sidecar log for
  `not satisfiable` first. If that line is absent for `ss-rlm-sandbox` on a host
  where the row is enabled, this diagnosis is wrong.
- **The seed was deliberately not changed.** `role-registry-seed.ts` still
  seeds only embedding/completion/ocr (+reranker on Linux). Adding the sandbox
  there would auto-enable a role whose image does not exist on every freshly
  registered host, producing pull failures nobody asked for. It stays opt-in.
- **The legacy registry has no sandbox entry either.**
  `fleet-router.ts:buildLegacyRegistry` only emits embedding/completion/ocr/
  reranker for pre-2.3 sidecars. `ss-rlm` is already absent for the same
  reason, so this is consistent existing behaviour — but a pre-2.3 sidecar
  cannot run the sandbox at all.
- **Widening `RuntimeChoice` touches the whole roleassign grid.** Every
  `Record<RuntimeChoice, boolean>` becomes non-exhaustive and must gain a
  `'docker-cpu':` key. That is the desired failure mode — it is how the compiler
  enumerates the call sites — but it means the diff is wider than the one-line
  port fix the request sounds like.
- **Old sidecars.** A sidecar running pre-fix code that receives
  `runtime: 'docker-cpu'` fails the inline whitelist at `ws-client.ts:598`, sets
  `runtime = undefined`, and falls through to the OS-default switch — which
  resolves `ss-rlm-sandbox` **correctly** at `:338`. Benign, and worth stating:
  the fleet degrades to working rather than breaking. Confirm against a sidecar
  that has not taken the new build before assuming it.
- **`/setup` divergence** (union copy 5) is deferred — see above.
- **Two other roles stay GPU-gated.** This adds `'docker-cpu'` for exactly one
  mode. Resist generalising `requiresGpu: false` to anything else in this task.

## References

- [`docs/SPEC-ss-rlm-sandbox.md`](../SPEC-ss-rlm-sandbox.md) — two-master contract, why the pattern is not the weight, the sandbox's security constraints (no Docker socket, no API key, no egress)
- `sideCar/src/lib/state.ts:179-243` — the registry entry and the reasoning behind `type: 'vllm'` / `requiresGpu: false`
- `sideCar/src/lib/mode-templates.ts:152-623` — `resolveMode` / `resolveModeForRuntime`
- `sideCar/src/lib/containers.ts:178,657` · `sideCar/src/lib/docker.ts:785,919` — the verified `requiresGpu` opt-out guards
- `src/lib/ai/stream-rlm.ts:307-342` — the Phase-2 sandbox fallback that needs `status: 'running'` on `:8101`
- `src/lib/db/role-registry.ts:240-300` — runtime validation and per-host runtime map
