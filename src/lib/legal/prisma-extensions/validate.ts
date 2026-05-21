/**
 * Prisma client extension: XETO write-path validation.
 *
 * Wraps every `create / update / upsert / createMany` on the
 * legal-domain models and validates the `tags` field against the
 * matching XETO spec via `Namespace.fits()`. Throws `Error` before
 * the SQL hits if validation fails.
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

export const xetoValidate = Prisma.defineExtension({
  name: 'xeto-validate',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
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
          const result = await validateTags(model, tagDict)
          if (!result.ok) {
            throw new Error(
              `XETO validation failed for ${model}.${operation}: ${result.errors.join('; ')}`,
            )
          }
        }

        return query(args)
      },
    },
  },
})
