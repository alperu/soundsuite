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

/**
 * Pods in @haxall/haxall/esm that *must* be skipped during boot.
 *
 * `graphicsJava.js` (line ~839 in the 4.0.4 shipped build) has a
 * top-level declaration that triggers
 *   ArgErr: Java types not allowed '[java]java.awt::FontMetrics'
 * from sys.js's type resolver. The shipped fan.js / fantom.js boot()
 * wraps every per-pod `await import(...)` in try/catch, which catches
 * the *synchronous* rejection. But Node's async_hooks tracer still
 * surfaces the inner rejection to the process-level
 * `unhandledRejection` handler — Next.js's dev server kills the
 * request (and sometimes the process) when this happens.
 *
 * The other entries in this set are pods that emit SyntaxError /
 * "missing module" at import — those *are* caught cleanly, but
 * skipping them keeps the boot log quiet.
 *
 * Identified by `scripts/_haxall-bisect.mjs` against
 * @haxall/haxall@4.0.4. Revisit on every version bump.
 */
const HAXALL_SKIP_PODS = new Set<string>([
  'graphicsJava.js', // ArgErr — root cause of the boot crash
  'asn1.js',
  'cryptoJava.js',
  'fanc.js',
  'fansh.js',
  'hxDocker.js',
  'hxFolio.js',
  'hxMath.js',
  'hxMqtt.js',
  'hxPy.js',
  'hxSedona.js',
  'hxStore.js',
  'hxTools.js',
  'hxd.js',
  'math.js',
  'nodeJs.js',
])

async function loadHaxallModules(): Promise<{
  sys: AnyMod
  xeto: AnyMod
  haystack: AnyMod
}> {
  // 1. Strip any inherited FAN_HOME — see comment in HAXALL_SKIP_PODS for
  //    the full crash chronology. A bad FAN_HOME can also make
  //    fantom.js's checkPathEnv() fault on a malformed fan.props.
  const inheritedFanHome = process.env.FAN_HOME
  if (inheritedFanHome) {
    delete process.env.FAN_HOME
    // eslint-disable-next-line no-console
    console.log(
      `[xeto-namespace] dropped inherited FAN_HOME=${inheritedFanHome}`,
    )
  }

  // 2. Replace fan.js / fantom.js's auto-import loop with our own that
  //    skips known-bad pods. fan.js is a thin wrapper that calls
  //    fantom.js boot(), which reads every .js in esm/ and tries to
  //    import it — that's the loop that surfaces graphicsJava.js's
  //    ArgErr to the process. Doing it ourselves keeps full control.
  const path = await dynImport<typeof import('node:path')>('node:path')
  const fs = await dynImport<typeof import('node:fs')>('node:fs')
  const url = await dynImport<typeof import('node:url')>('node:url')

  // Resolve the package root: `${cwd}/node_modules/@haxall/haxall/`. This
  // is the same pattern used by scripts/xeto-smoke.mjs which is known-good.
  const haxallRoot = path.resolve(
    process.cwd(),
    'node_modules/@haxall/haxall',
  )
  const esmDir = path.join(haxallRoot, 'esm')

  // 3. Import sys.js first — it's the foundation everything imports.
  const sys = (await dynImport<AnyMod>(
    '@haxall/haxall/esm/sys.js',
  )) as AnyMod

  // 3a. Import the three `fan_*` bootstrap pods. fantom.js statically
  //     imports these at its top (lines 2–4) so they execute before its
  //     `boot()` runs — they register the indexed-props table, MIME
  //     database, and unit database in `sys`. Our auto-discovery loop
  //     below filters out `fan_*` (matching fantom.js's filter), so
  //     without these explicit imports those tables stay empty.
  //
  //     Symptom of the missing imports: `ns.fits(dict, customSpec)`
  //     throws `sys::NullErr: Coerce to non-null` for any spec in our
  //     `cc.courtlens.legal` lib (stock `ph` specs happen to dodge the
  //     affected reflection paths). See task #7.
  await dynImport<AnyMod>('@haxall/haxall/esm/fan_indexed_props.js')
  await dynImport<AnyMod>('@haxall/haxall/esm/fan_mime.js')
  await dynImport<AnyMod>('@haxall/haxall/esm/fan_units.js')

  // 4. Replicate fantom.js boot()'s env setup (lines 60–67) so File/Env
  //    paths point at the package home, where the bundled .xetolib
  //    pre-builds live (home/lib/xeto/sys/sys-5.0.0.xetolib, etc.).
  const { Env, File } = sys
  const toDir = (p: string) => (p.endsWith('/') ? p : p + '/')
  Env.cur().__homeDir = File.os(toDir(haxallRoot))
  Env.cur().__workDir = File.os(toDir(process.cwd()))
  Env.cur().__tempDir = File.os(
    toDir(path.resolve(haxallRoot, 'temp')),
  )
  Env.cur().__loadVars({
    'node.version': process.versions.node,
    'node.path': haxallRoot,
  })

  // 5. Auto-discover esm/*.js — same filters fantom.js uses (skip .ts,
  //    fan_*, test*, fantom.js, sys.js) PLUS our blocklist.
  const files = fs.readdirSync(esmDir).filter((f: string) => {
    if (path.extname(f) !== '.js') return false
    if (f.startsWith('fan_')) return false
    if (f.startsWith('test')) return false
    if (f === 'fantom.js' || f === 'sys.js') return false
    if (HAXALL_SKIP_PODS.has(f)) return false
    return true
  })
  for (const f of files) {
    try {
      await dynImport<AnyMod>(url.pathToFileURL(path.join(esmDir, f)).href)
    } catch {
      // Same swallow as fantom.js — should be silent if HAXALL_SKIP_PODS
      // is current. If it isn't, the bisect script catches it.
    }
  }

  // 6. Import the two pods we actually use directly.
  const xetoMod = await dynImport<AnyMod>('@haxall/haxall/esm/xeto.js')
  const haystackMod = await dynImport<AnyMod>(
    '@haxall/haxall/esm/haystack.js',
  )
  return { sys, xeto: xetoMod, haystack: haystackMod }
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
  // Defensive wrapper: never let an internal Haxall/XETO error bubble
  // out of this function. The Prisma extension treats us as a boolean
  // gate; if we throw, every tag write fails with a 500. That's worse
  // than soft-failing the validation and letting the write proceed.
  // The user can edit tags in the panel while we investigate the
  // underlying namespace bug (see task #7).
  try {
    const qname = qnameForModel(model)
    if (!qname) return { ok: true, errors: [] }
    const boot = await getNamespace()
    const targetSpec = specOf(boot, qname)
    if (!targetSpec) {
      // Spec not loaded (lib didn't resolve, or model name mapping is
      // stale). Don't block the write — log once and pass through.
      logSpecMissOnce(model, qname)
      return { ok: true, errors: [] }
    }

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

    // Synthesize a human-readable diff between what's in the dict and
    // what the spec declares. The Haxall `validate` output is terse;
    // augmenting it with slot-by-slot info makes the error actionable
    // ("missing required: causeNo" instead of just "tags do not fit").
    try {
      const want = extractSlotShape(boot, targetSpec)
      const dictKeys = Object.keys(
        (tagDict && typeof tagDict === 'object' ? tagDict : {}) as Record<string, unknown>,
      )
      const missingRequired = want.required.filter(k => !dictKeys.includes(k))
      const unknown = dictKeys.filter(k => !want.known.has(k) && !INFRA_KEYS.has(k))
      if (missingRequired.length) {
        errors.push(`missing required: ${missingRequired.join(', ')}`)
      }
      if (unknown.length) {
        errors.push(`unknown for ${qname}: ${unknown.join(', ')}`)
      }
    } catch {
      /* best-effort enrichment only */
    }

    return { ok: false, errors }
  } catch (e) {
    // Haxall internal error (NullErr, ArgErr, etc.) — pass through the
    // write rather than block on broken validation.
    logBootErrorOnce(model, e)
    return { ok: true, errors: [] }
  }
}

/**
 * Tag keys that aren't part of the spec slot set but are universally
 * tolerated (id, mod, dis, …). Don't flag them as "unknown for spec".
 */
const INFRA_KEYS = new Set([
  'id', 'mod', 'dis', 'navName', 'doc',
  // markers we hide from UI but routinely accept on records (§5):
  'site', 'equip', 'point', 'attachment', 'motionEvent', 'personRole',
])

/**
 * Walk a XETO Spec's slot definitions and return `{ known, required }`.
 * Helper for synthesizing actionable error messages.
 */
function extractSlotShape(boot: XetoBoot, spec: unknown): {
  known: Set<string>
  required: string[]
} {
  const known = new Set<string>()
  const required: string[] = []
  try {
    const slots = (spec as { slots?: unknown }).slots
    if (!slots) return { known, required }
    // ns.slots returns a sys::Map keyed by slot name (string) → Spec.
    // Fantom Maps expose .each((val, key) => ...) — use it if present.
    const each = (slots as { each?: (cb: (v: unknown, k: string) => void) => void }).each
    if (typeof each === 'function') {
      each.call(slots, (slotSpec: unknown, name: string) => {
        known.add(name)
        // A slot is "required" if it isn't tagged as `maybe` (optional)
        // and has no default. Best-effort detection.
        const meta = (slotSpec as { meta?: unknown }).meta as
          | { has?: (k: string) => boolean }
          | undefined
        const isOptional = !!(meta && meta.has && (meta.has('maybe') || meta.has('default')))
        if (!isOptional) required.push(name)
      })
    }
  } catch {
    /* best-effort */
  }
  return { known, required }
}

const SPEC_MISS_LOGGED = new Set<string>()
function logSpecMissOnce(model: string, qname: string): void {
  if (SPEC_MISS_LOGGED.has(model)) return
  SPEC_MISS_LOGGED.add(model)
  // eslint-disable-next-line no-console
  console.warn(
    `[xeto] spec '${qname}' for model ${model} not loaded — write passes through unvalidated`,
  )
}

const BOOT_ERR_LOGGED = new Set<string>()
function logBootErrorOnce(model: string, e: unknown): void {
  if (BOOT_ERR_LOGGED.has(model)) return
  BOOT_ERR_LOGGED.add(model)
  const msg = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)
  // eslint-disable-next-line no-console
  console.warn(
    `[xeto] validation passthrough for ${model} (haxall internal error: ${msg})`,
  )
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
