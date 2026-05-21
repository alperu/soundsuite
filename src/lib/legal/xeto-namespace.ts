/**
 * XETO namespace singleton.
 *
 * Loads the standard `sys` + `ph` libs from `@haxall/haxall`'s bundled
 * lib path plus our three custom libs (`proc.core`, `cc.courtlens.legal`,
 * `proc.tx`) discovered from `<workDir>/src/xeto/<libname>/`. Booting
 * the namespace takes ~200–500 ms; we cache it as a module-level
 * singleton — mirrors the pattern used in `src/lib/db/prisma.ts`.
 *
 * **Server-side only.** `@haxall/haxall` is ESM-only and ships ~13 MB
 * of untreeshakable Fantom JS. Never import this module from a
 * `'use client'` component. The package is declared in
 * `serverExternalPackages` in `next.config.ts`.
 *
 * @see docs/xeto-haystack-research.md §3a (Haxall surface)
 * @see docs/xeto-haystack-research.md §4.0 (the eight core specs)
 */

// `@haxall/haxall` is ESM-only and uses `import.meta`. We import it
// via a runtime `await import(...)` wrapped in `new Function` so that
// ts-jest / Next.js webpack do not statically rewrite the spec to a
// `require()` — that rewrite turns the ESM module into a CJS lookup,
// and the package's `fan.js` then fails with
// "Cannot use 'import.meta' outside a module" inside Jest's
// transformer. The Function indirection keeps the call truly dynamic.
//
// At Next.js server runtime this still resolves correctly because the
// route handler / server component is already running as ESM (verified
// by the `serverExternalPackages` entries in `next.config.ts`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dynImport: <T>(spec: string) => Promise<T> = new Function(
  's',
  'return import(s);',
) as <T>(spec: string) => Promise<T>

const LIB_NAMES = [
  'sys',
  'ph',
  'proc.core',
  'cc.courtlens.legal',
  'proc.tx',
]

type Spec = unknown
type Dict = unknown

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMod = any

interface XetoBoot {
  sys: AnyMod
  xeto: AnyMod
  haystack: AnyMod
  ns: AnyMod
}

const globalForXeto = globalThis as unknown as {
  __xetoBoot: XetoBoot | undefined
  __xetoBootPromise: Promise<XetoBoot> | undefined
}

async function loadHaxallModules(): Promise<{
  sys: AnyMod
  xeto: AnyMod
  haystack: AnyMod
}> {
  // Override any inherited FAN_HOME before importing @haxall/haxall/fan.js.
  // The user's shell may set FAN_HOME to a local haxall checkout (e.g.
  // ~/fantom or ~/haxall) that is missing the bundled fantom pods. Without
  // this override, fan.js throws `ArgErr {}` at boot and the Next.js server
  // crashes — exactly the failure that took the dashboard offline on
  // 2026-05-21. Always point at the npm package root.
  const path = await dynImport<typeof import('node:path')>('node:path')
  const haxallRoot = path.resolve(
    process.cwd(),
    'node_modules/@haxall/haxall',
  )
  process.env.FAN_HOME = haxallRoot
  const fan = await dynImport<{ sys: AnyMod }>('@haxall/haxall/fan.js')
  const xetoMod = await dynImport<AnyMod>('@haxall/haxall/esm/xeto.js')
  const haystackMod = await dynImport<AnyMod>(
    '@haxall/haxall/esm/haystack.js',
  )
  return { sys: fan.sys, xeto: xetoMod, haystack: haystackMod }
}

function buildNamespace(sys: AnyMod, xeto: AnyMod): AnyMod {
  const env = xeto.XetoEnv.cur()
  const deps = sys.List.make(xeto.LibDepend.type$)
  for (const name of LIB_NAMES) {
    deps.add(xeto.LibDepend.make(name))
  }
  const versions = env.repo().solveDepends(deps)
  return env.createNamespace(versions)
}

/**
 * Get (or boot) the XETO namespace + helper modules.
 *
 * First call costs ~200–500 ms (lib parse + dependency solve). All
 * subsequent calls return the cached singleton in microseconds.
 *
 * The boot procedure:
 *  1. Dynamic-import `@haxall/haxall`'s ESM entry points.
 *  2. `XetoEnv.cur()` — process-wide environment honoring `FAN_HOME`.
 *  3. `env.repo().solveDepends(deps)` — resolve the dependency graph.
 *  4. `env.createNamespace(versions)` — load the libs lazily.
 *
 * The repo discovers source libs at `<workDir>/src/xeto/<lib>/lib.xeto`
 * and pre-built libs at `<homeDir>/lib/xeto/<lib>/<lib>-<version>.xetolib`.
 * No compilation step is required; the namespace loads sources on
 * demand the first time a spec is asked for.
 */
export async function getNamespace(): Promise<XetoBoot> {
  if (globalForXeto.__xetoBoot) return globalForXeto.__xetoBoot
  if (!globalForXeto.__xetoBootPromise) {
    globalForXeto.__xetoBootPromise = (async () => {
      const mods = await loadHaxallModules()
      const ns = buildNamespace(mods.sys, mods.xeto)
      const boot: XetoBoot = { ...mods, ns }
      globalForXeto.__xetoBoot = boot
      return boot
    })()
  }
  return globalForXeto.__xetoBootPromise
}

/**
 * Build a Haystack `Dict` from a plain JS object.
 *
 * Markers are conventionally the `xeto.Marker` singleton; refs use
 * `xeto.Ref.make(id, null)`. We accept the underlying singletons plus
 * primitives (string/number/boolean/Date) and the sugar value `true`
 * (means "marker present" when the caller does not have the Marker
 * singleton handy).
 */
export function dict(boot: XetoBoot, obj: Record<string, unknown>): Dict {
  const { sys, xeto, haystack } = boot
  const map = sys.Map.make(sys.Str.type$, sys.Obj.type$.toNullable())
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (v === true) {
      map.set(k, xeto.Marker.val())
    } else {
      map.set(k, v)
    }
  }
  return haystack.Etc.makeDict(map)
}

/** Convenience: build a Haystack `Ref` from a string id. */
export function ref(boot: XetoBoot, id: string): unknown {
  return boot.xeto.Ref.make(id, null)
}

/** Convenience: the singleton Haystack `Marker`. */
export function marker(boot: XetoBoot): unknown {
  return boot.xeto.Marker.val()
}

/**
 * Resolve a spec qname → Spec object. Throws if not found.
 *
 * Use the `lib::Name` form (e.g. `cc.courtlens.legal::Motion`).
 */
export function specOf(boot: XetoBoot, qname: string): Spec {
  const s = boot.ns.spec(qname)
  if (!s) throw new Error(`XETO spec not found: ${qname}`)
  return s
}

/**
 * Map a TAG_MODELS-style model name (`'Motion'`, `'MotionEvent'`, ...)
 * to its XETO qname in `cc.courtlens.legal`. Returning `null` means
 * "no XETO spec for this model yet" — the Prisma extension treats
 * that as a pass-through.
 */
const MODEL_TO_QNAME: Record<string, string | null> = {
  Case: 'cc.courtlens.legal::Case',
  Motion: 'cc.courtlens.legal::Motion',
  MotionEvent: 'cc.courtlens.legal::MotionEvent',
  MotionAttachment: 'cc.courtlens.legal::MotionAttachment',
  Hearing: 'cc.courtlens.legal::Hearing',
  Person: 'cc.courtlens.legal::Person',
  PersonRole: 'cc.courtlens.legal::PersonRole',
  // Document is not yet a XETO-validated model — placeholder until we
  // author the spec for it. `null` skips validation.
  Document: null,
}

export function qnameForModel(model: string): string | null {
  return MODEL_TO_QNAME[model] ?? null
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * Validate a tag dict against the spec for the given Prisma model.
 *
 * Async because the namespace boots lazily on first call. After the
 * first hit it returns in microseconds.
 *
 * Returns `{ ok: true, errors: [] }` on success.
 *
 * The check uses `ns.fits()` with `ignoreRefs:true` so that an
 * unresolved Ref (target not yet inserted in the database) does not
 * fail validation — refs are validated separately at commit time via
 * Prisma's foreign-key constraints + the ref registry.
 */
export async function validateTags(
  model: string,
  tagDict: Record<string, unknown> | unknown,
): Promise<ValidationResult> {
  const qname = qnameForModel(model)
  if (!qname) return { ok: true, errors: [] }
  const boot = await getNamespace()
  const targetSpec = specOf(boot, qname)

  const d =
    tagDict &&
    typeof tagDict === 'object' &&
    !(tagDict as { has?: unknown }).has
      ? dict(boot, tagDict as Record<string, unknown>)
      : tagDict

  const opts = dict(boot, { ignoreRefs: true })
  const ok = boot.ns.fits(d, targetSpec, opts) as boolean
  if (ok) return { ok: true, errors: [] }

  const errors: string[] = [`tags do not fit ${qname}`]
  try {
    const report = boot.ns.validate(d, targetSpec, opts)
    errors.push(String(report))
  } catch {
    // ns.validate() throws unless inside an XetoContext; the boolean
    // from fits() is the load-bearing check.
  }
  return { ok: false, errors }
}

/**
 * Synchronous validation wrapper for code paths that have already
 * awaited {@link getNamespace} once. Throws if the namespace is not
 * yet booted.
 */
export function validateTagsSync(
  model: string,
  tagDict: Record<string, unknown> | unknown,
): ValidationResult {
  const boot = globalForXeto.__xetoBoot
  if (!boot) {
    throw new Error(
      'validateTagsSync called before getNamespace() — boot the namespace first',
    )
  }
  const qname = qnameForModel(model)
  if (!qname) return { ok: true, errors: [] }
  const targetSpec = specOf(boot, qname)
  const d =
    tagDict &&
    typeof tagDict === 'object' &&
    !(tagDict as { has?: unknown }).has
      ? dict(boot, tagDict as Record<string, unknown>)
      : tagDict
  const opts = dict(boot, { ignoreRefs: true })
  const ok = boot.ns.fits(d, targetSpec, opts) as boolean
  if (ok) return { ok: true, errors: [] }
  return { ok: false, errors: [`tags do not fit ${qname}`] }
}
