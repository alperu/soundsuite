/**
 * Smoke test for the XETO namespace singleton.
 *
 * Boots `sys / ph / proc.core / cc.courtlens.legal / proc.tx`, then
 * exercises `validateTags()` against a Motion dict and a MotionEvent
 * dict. Does NOT touch Prisma — Agent 1's tables aren't part of this
 * branch.
 *
 * Boot cost: ~200–500 ms on first run. The Jest timeout in
 * `jest.config.js` is 30 s, so we have plenty of headroom.
 */

import path from 'node:path'

// FAN_HOME must point at the package root so the bundled `ph`/`sys`
// libs at `<FAN_HOME>/lib/xeto/<lib>/<lib>-5.0.0.xetolib` are
// discoverable. The user's shell often sets FAN_HOME to a haxall
// checkout — override here.
const packageFanHome = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'node_modules',
  '@haxall',
  'haxall',
)
process.env.FAN_HOME = packageFanHome

// `@haxall/haxall` is ESM-only (`"type": "module"`, `import.meta`).
// ts-jest's default CJS pipeline can't load it cleanly; even with
// `NODE_OPTIONS=--experimental-vm-modules` the package's `fan.js`
// trips `ReferenceError: exports is not defined`. Until we either
// switch this repo to Vitest or land a Jest ESM transform, the
// equivalent assertions live in `scripts/xeto-smoke.mjs` and run
// outside jest:
//
//   node scripts/xeto-smoke.mjs   // 5/5 pass
//
// The describe block below is the structural mirror; once the runner
// story is settled we remove the `.skip`.
describe.skip('xeto-namespace', () => {
  let mod: typeof import('../xeto-namespace')

  beforeAll(async () => {
    mod = await import('../xeto-namespace')
    // Force boot so the first test doesn't pay the cost.
    await mod.getNamespace()
  })

  test('boots the namespace with all five libs', async () => {
    const boot = await mod.getNamespace()
    expect(boot.ns.libs().size()).toBeGreaterThanOrEqual(5)
  })

  test('validates a known-good Motion dict (fits → true)', async () => {
    const boot = await mod.getNamespace()
    const good = mod.dict(boot, {
      motion: true,
      equip: true,
      caseRef: mod.ref(boot, 'case-1'),
      motionType: 'disqualify',
      // ph::Equip requires siteRef in addition to our caseRef.
      siteRef: mod.ref(boot, 'case-1'),
    })
    const result = await mod.validateTags('Motion', good)
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  // This used to assert that omitting `caseRef` fails. It cannot:
  // `Motion.caseRef` is `Ref?` on purpose — a Motion's case lives in the
  // Prisma `caseId` column (set on every row), and only a handful of rows
  // carry the tag, so requiring it would reject nearly every Motion write.
  // The `motion` marker is the slot that really is mandatory, so it carries
  // the same intent. Mirrored in scripts/xeto-smoke.mjs.
  test('rejects a Motion dict missing the required `motion` marker (fits → false)', async () => {
    const boot = await mod.getNamespace()
    const bad = mod.dict(boot, {
      // `motion` marker OMITTED — required by cc.courtlens.legal::Motion
      equip: true,
      caseRef: mod.ref(boot, 'case-1'),
      motionType: 'disqualify',
      siteRef: mod.ref(boot, 'case-1'),
    })
    const result = await mod.validateTags('Motion', bad)
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  // Regression guard for task #39: `dict()` coerces '@id' strings on ref keys
  // into Fantom Refs. If that regresses a Str reaches the type checker, no
  // ref-bearing dict fits any more, and validation goes quietly inert again.
  test('coerces a plain "@id" string on a ref key into a Ref (fits → true)', async () => {
    const boot = await mod.getNamespace()
    const good = mod.dict(boot, {
      motion: true,
      equip: true,
      caseRef: '@case-1',
      motionType: 'disqualify',
      siteRef: '@case-1',
    })
    const result = await mod.validateTags('Motion', good)
    expect(result.ok).toBe(true)
  })

  test('rejects a MotionEvent with conflicting EventKind choice markers', async () => {
    // EventKind is an exclusive Choice — `received` and `filed` both
    // present must fail.
    const boot = await mod.getNamespace()
    const conflict = mod.dict(boot, {
      motionEvent: true,
      point: true,
      motionRef: mod.ref(boot, 'm-1'),
      caseRef: mod.ref(boot, 'case-1'),
      received: true,
      filed: true,
      occurredOn: new Date().toISOString(),
      equipRef: mod.ref(boot, 'm-1'),
    })
    const result = await mod.validateTags('MotionEvent', conflict)
    expect(result.ok).toBe(false)
  })

  test('rejects a MotionEvent with no EventKind choice marker at all', async () => {
    const boot = await mod.getNamespace()
    const noKind = mod.dict(boot, {
      motionEvent: true,
      point: true,
      motionRef: mod.ref(boot, 'm-1'),
      caseRef: mod.ref(boot, 'case-1'),
      // No `received` / `filed` / `responded` / ... marker present.
      occurredOn: new Date().toISOString(),
      equipRef: mod.ref(boot, 'm-1'),
    })
    const result = await mod.validateTags('MotionEvent', noKind)
    expect(result.ok).toBe(false)
  })
})
