#!/usr/bin/env node
/**
 * Standalone smoke test for the XETO namespace.
 *
 * Run with: `node scripts/xeto-smoke.mjs`
 *
 * Jest's CJS-by-default ts-jest pipeline can't import the ESM-only
 * `@haxall/haxall` package cleanly (its `fan.js` uses `import.meta`
 * and the package is `"type": "module"`). We can rewire jest with
 * `NODE_OPTIONS=--experimental-vm-modules` but ts-jest then needs
 * additional config. Until Agent 5's codegen pipeline lands and we
 * settle on the test runner story (Vitest vs Jest+ESM), we keep this
 * standalone smoke script alongside the colocated `*.test.ts` file
 * (which is structurally correct but currently skipped — see the
 * `describe.skip` block).
 *
 * This script exercises the same assertions the Jest test would:
 *   1. The namespace boots with all five libs loaded.
 *   2. A known-good Motion dict fits the Motion spec.
 *   3. A Motion missing the required `motion` marker does NOT fit.
 *   4. A Motion whose caseRef is a Str rather than a Ref does NOT fit
 *      (regression guard for the task #39 value conversion).
 *   5. A MotionEvent with two EventKind markers does NOT fit.
 *   6. A MotionEvent with no EventKind marker does NOT fit.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
process.env.FAN_HOME = path.join(
  projectRoot,
  'node_modules',
  '@haxall',
  'haxall',
)

const mod = await import(
  path.join(projectRoot, 'src/lib/legal/xeto-namespace.ts')
).catch(() => null)

// `.ts` import is not supported by plain node; fall back to a
// minimal inlined boot that mirrors `getNamespace()`.
async function boot() {
  if (mod && mod.getNamespace) return mod.getNamespace()
  const fan = await import('@haxall/haxall/fan.js')
  const xeto = await import('@haxall/haxall/esm/xeto.js')
  const haystack = await import('@haxall/haxall/esm/haystack.js')
  const env = xeto.XetoEnv.cur()
  const deps = fan.sys.List.make(xeto.LibDepend.type$)
  for (const n of [
    'sys',
    'ph',
    'proc.core',
    'cc.courtlens.legal',
    'proc.tx',
  ]) {
    deps.add(xeto.LibDepend.make(n))
  }
  const versions = env.repo().solveDepends(deps)
  return {
    sys: fan.sys,
    xeto,
    haystack,
    ns: env.createNamespace(versions),
  }
}

function mkDict({ sys, haystack }, obj) {
  const m = sys.Map.make(sys.Str.type$, sys.Obj.type$.toNullable())
  for (const [k, v] of Object.entries(obj)) m.set(k, v)
  return haystack.Etc.makeDict(m)
}

let passed = 0
let failed = 0
function assert(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
    passed++
  } else {
    console.log(`  FAIL ${name}`)
    failed++
  }
}

const start = Date.now()
const b = await boot()
const bootMs = Date.now() - start

const motion = b.ns.spec('cc.courtlens.legal::Motion')
const event = b.ns.spec('cc.courtlens.legal::MotionEvent')
const M = b.xeto.Marker.val()
const igRefs = mkDict(b, { ignoreRefs: M })

console.log(`xeto-smoke — namespace booted in ${bootMs} ms`)
assert('all 5 libs loaded', b.ns.libs().size() >= 5)

const goodMotion = mkDict(b, {
  motion: M,
  equip: M,
  caseRef: b.xeto.Ref.make('case-1', null),
  motionType: 'disqualify',
  siteRef: b.xeto.Ref.make('case-1', null),
})
assert('good Motion fits', b.ns.fits(goodMotion, motion, igRefs))

// This used to assert that a Motion missing `caseRef` does not fit. It never
// could: `Motion.caseRef` is declared `Ref?`, deliberately — a Motion's case
// lives in the Prisma `caseId` column (populated on all 48 rows), and only 6
// carry a `caseRef` tag, so requiring the tag would reject nearly every Motion
// write. The database owns that invariant; the spec doesn't duplicate it.
// What the spec DOES require is the `motion` marker, so assert that instead —
// same intent (a structurally invalid Motion is rejected), against a slot that
// is actually mandatory.
const noMarkerMotion = mkDict(b, {
  equip: M,
  caseRef: b.xeto.Ref.make('case-1', null),
  motionType: 'disqualify',
  siteRef: b.xeto.Ref.make('case-1', null),
})
assert(
  'Motion missing the `motion` marker does not fit',
  !b.ns.fits(noMarkerMotion, motion, igRefs),
)

// Pins the type-checker behaviour that task #39 was built around: a ref slot
// holding a plain Str does not fit, which is exactly why `dict()` has to coerce
// '@id' strings into Fantom Refs. Note this builds dicts with the local
// `mkDict`, so it pins the requirement, not the coercion itself — the test that
// exercises `dict()` lives in the mirrored jest suite.
const strRefMotion = mkDict(b, {
  motion: M,
  equip: M,
  caseRef: 'case-1',
  motionType: 'disqualify',
  siteRef: b.xeto.Ref.make('case-1', null),
})
assert(
  'Motion with caseRef as a Str (not a Ref) does not fit',
  !b.ns.fits(strRefMotion, motion, igRefs),
)

const conflictEvent = mkDict(b, {
  motionEvent: M,
  point: M,
  motionRef: b.xeto.Ref.make('m-1', null),
  caseRef: b.xeto.Ref.make('case-1', null),
  received: M,
  filed: M,
  occurredOn: b.sys.DateTime.now(),
  equipRef: b.xeto.Ref.make('m-1', null),
})
assert(
  'conflicting EventKind (received+filed) does not fit',
  !b.ns.fits(conflictEvent, event, igRefs),
)

const noKindEvent = mkDict(b, {
  motionEvent: M,
  point: M,
  motionRef: b.xeto.Ref.make('m-1', null),
  caseRef: b.xeto.Ref.make('case-1', null),
  occurredOn: b.sys.DateTime.now(),
  equipRef: b.xeto.Ref.make('m-1', null),
})
assert(
  'MotionEvent with no EventKind marker does not fit',
  !b.ns.fits(noKindEvent, event, igRefs),
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
