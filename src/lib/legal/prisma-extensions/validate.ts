/**
 * Prisma client extension: XETO write-path validation.
 *
 * Wraps every `create / update / upsert / createMany` on the
 * legal-domain models and validates the `tags` field against the
 * matching XETO spec via `Namespace.fits()`. A miss is logged and, when
 * `XETO_VALIDATION_ENFORCE=1`, throws before the SQL hits — see `ENFORCE`
 * below for why blocking is off by default.
 *
 * This is the **unbypassable** validation choke point — replaces the
 * older `repo.writeTagged()` free function (which callers could route
 * around by going directly to `prisma.motion.create(...)`).
 *
 * @see docs/xeto-haystack-research.md §12.2 (Prisma extension)
 */

import { Prisma } from '@prisma/client'

import { validateTags } from '@/lib/legal/xeto-namespace'

/** Models whose writes carry a XETO-validated `tags` field. */
export const TAG_MODELS = new Set([
  'Case',
  'Motion',
  'MotionEvent',
  'MotionAttachment',
  'Person',
  'PersonRole',
  'Document',
  'Hearing',
])

/**
 * Does a failed validation block the write, or just log?
 *
 * Advisory by default, and that default is load-bearing. Until task #39 the
 * Hayson-encoded tag dicts never survived conversion, so `fits()` threw,
 * `validateTags` soft-passed, and this gate had never once fired against real
 * data — 0 of 80 rows. Fixing the conversion makes it fire for the first time,
 * and any legacy row the specs disagree with would start returning a 500 on
 * the user's next edit of a record they didn't break.
 *
 * So: log every miss, block none. Flip `XETO_VALIDATION_ENFORCE=1` once the
 * corpus validates clean (see scripts/probe-validation-triage.ts for the
 * current miss list) — nothing else has to change.
 */
const ENFORCE = process.env.XETO_VALIDATION_ENFORCE === '1'

const WRITE_OPS = new Set([
  'create',
  'update',
  'upsert',
  'createMany',
] as const)

/**
 * Type-erase the args shape — the `query` callback receives an
 * effectively-unknown payload at the `$allModels` level. We probe for
 * a `data.tags` field and validate iff one is present.
 */
function extractTagDict(args: unknown): unknown {
  if (!args || typeof args !== 'object') return undefined
  const data = (args as { data?: unknown }).data
  if (!data || typeof data !== 'object') return undefined
  // Upsert has both `create` and `update`. Validate the `create`
  // payload primarily; the update tags are validated on their own
  // through the `update` op path (Prisma fires the extension on
  // every leaf op). For `createMany`, tags arrives as an array; we
  // validate each element.
  if (Array.isArray((data as { data?: unknown[] }).data)) {
    return (data as { data: unknown[] }).data
  }
  return (data as { tags?: unknown }).tags
}

/**
 * The subtype discriminator for this write, when the payload carries one.
 * `MotionAttachment` writes name their kind in `data.attachmentKind`;
 * `commitEntity` re-sends the stored value on tag updates precisely so the
 * validator can see it here (see `@/lib/haystack/commit`).
 */
function extractDiscriminator(args: unknown, row: unknown): string | undefined {
  const fromRow = (row as { attachmentKind?: unknown } | null)?.attachmentKind
  if (typeof fromRow === 'string') return fromRow
  const data = (args as { data?: { attachmentKind?: unknown } } | null)?.data
  return typeof data?.attachmentKind === 'string' ? data.attachmentKind : undefined
}

/**
 * The gate itself, exported so it can be exercised without a database.
 * `Prisma.defineExtension` returns an opaque callable, so a handler defined
 * inline is unreachable from a test — and whether a validation miss blocks
 * the write is exactly the behaviour that needs proving.
 */
export async function validateWriteOperation({
  model,
  operation,
  args,
  query,
}: {
  model?: string
  operation: string
  args: unknown
  query: (args: unknown) => Promise<unknown>
}): Promise<unknown> {
  if (!model || !TAG_MODELS.has(model)) return query(args)
  if (!WRITE_OPS.has(operation as (typeof WRITE_OPS extends Set<infer T> ? T : never))) {
    return query(args)
  }

  const candidate = extractTagDict(args)
  if (candidate === undefined || candidate === null) {
    // No tags field — nothing to validate.
    return query(args)
  }

  const rows = Array.isArray(candidate) ? candidate : [candidate]
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    // For `createMany` the per-row payload is the whole object;
    // for `create` / `update` / `upsert` we already drilled into
    // `data.tags` above.
    const tagDict = Array.isArray(candidate)
      ? (row as { tags?: unknown }).tags
      : row
    if (!tagDict) continue
    const result = await validateTags(
      model,
      tagDict,
      extractDiscriminator(args, Array.isArray(candidate) ? row : null),
    )
    if (!result.ok) {
      // Log the rejected dict + structured errors so the user can
      // tell WHAT failed and WHY without re-deriving it from a
      // toast string. Goes to logs/dashboard.log; surfaces in the
      // dev-server stdout too.
      try {
        // eslint-disable-next-line no-console
        console.error(
          `[xeto-validate] ${ENFORCE ? 'REJECTED' : 'ADVISORY'} ${model}.${operation}\n` +
            `  errors: ${result.errors.join(' | ')}\n` +
            `  dict:   ${JSON.stringify(tagDict, null, 2).slice(0, 2000)}`,
        )
      } catch {
        /* never let logging itself throw */
      }
      if (!ENFORCE) continue
      const err = new Error(
        `XETO validation failed for ${model}.${operation}: ${result.errors.join('; ')}`,
      )
      // Stash the structured errors on the Error so the API route
      // can surface them to the toast/UI verbatim.
      ;(err as Error & { xetoErrors?: string[]; xetoDict?: unknown }).xetoErrors = result.errors
      ;(err as Error & { xetoErrors?: string[]; xetoDict?: unknown }).xetoDict = tagDict
      throw err
    }
  }

  return query(args)
}

export const xetoValidate = Prisma.defineExtension({
  name: 'xeto-validate',
  query: {
    $allModels: {
      $allOperations: ({ model, operation, args, query }) =>
        validateWriteOperation({
          model,
          operation,
          args,
          query: query as (a: unknown) => Promise<unknown>,
        }),
    },
  },
})
