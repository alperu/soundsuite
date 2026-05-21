#!/usr/bin/env node
/**
 * Mini-test exercising the production `validateTags()` code path
 * (xeto-namespace.ts) — the one called by the Prisma extension.
 *
 * Confirms that task #7's fix (importing fan_indexed_props / fan_mime /
 * fan_units up-front) means `ns.fits()` no longer throws `NullErr` for
 * our `cc.courtlens.legal` specs, so the soft-fail passthrough is no
 * longer triggered.
 *
 * Pre-fix behavior: every call returned `{ ok: true, errors: [] }`
 * with the warning `[xeto] validation passthrough for X (haxall
 * internal error: sys::NullErr: Coerce to non-null)`.
 *
 * Post-fix behavior: valid dicts return ok=true; invalid dicts return
 * ok=false with a real error report.
 *
 * Run: `node scripts/_validate-via-prod-path.mjs`
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const { validateTags, getNamespace, dict, ref } = await import(
  path.join(projectRoot, 'src/lib/legal/xeto-namespace.ts')
)

const boot = await getNamespace()
const sys = boot.sys

const dt = (iso) => sys.DateTime.fromStr(iso)

let passed = 0
let failed = 0
function assert(name, cond, extra) {
  if (cond) { console.log(`  ok   ${name}`); passed++ }
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failed++ }
}

// Case — valid
{
  const r = await validateTags('Case', {
    case: true,
    site: true,
    causeNo: '24CV0001',
    jurisdictionRef: ref(boot, 'tx'),
    filedOn: dt('2025-07-09T00:00:00Z UTC'),
  })
  assert('Case valid → ok', r.ok === true, JSON.stringify(r.errors))
}

// Case — missing required causeNo
{
  const r = await validateTags('Case', {
    case: true,
    site: true,
    jurisdictionRef: ref(boot, 'tx'),
  })
  assert('Case missing causeNo → not ok', r.ok === false)
}

// Motion — valid
{
  const r = await validateTags('Motion', {
    motion: true,
    equip: true,
    caseRef: ref(boot, 'case-1'),
    motionType: 'disqualify',
  })
  assert('Motion valid → ok', r.ok === true, JSON.stringify(r.errors))
}

// MotionEvent — valid with one EventKind
{
  const r = await validateTags('MotionEvent', {
    motionEvent: true,
    point: true,
    motionRef: ref(boot, 'm-1'),
    caseRef: ref(boot, 'case-1'),
    received: true,
    occurredOn: dt('2025-07-09T00:00:00Z UTC'),
  })
  assert('MotionEvent valid (received) → ok', r.ok === true, JSON.stringify(r.errors))
}

// MotionEvent — conflicting EventKind (received + filed)
{
  const r = await validateTags('MotionEvent', {
    motionEvent: true,
    point: true,
    motionRef: ref(boot, 'm-1'),
    caseRef: ref(boot, 'case-1'),
    received: true,
    filed: true,
    occurredOn: dt('2025-07-09T00:00:00Z UTC'),
  })
  assert('MotionEvent received+filed → not ok', r.ok === false)
}

// MotionEvent — no EventKind marker
{
  const r = await validateTags('MotionEvent', {
    motionEvent: true,
    point: true,
    motionRef: ref(boot, 'm-1'),
    caseRef: ref(boot, 'case-1'),
    occurredOn: dt('2025-07-09T00:00:00Z UTC'),
  })
  assert('MotionEvent no EventKind → not ok', r.ok === false)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
