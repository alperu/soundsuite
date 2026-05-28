/**
 * fileRef ⇔ documentId sync helper.
 *
 * Enforces the invariant: for any Filing-style entity row that exposes a
 * `documentId` FK column, the haystack `tags.fileRef` tag must reference the
 * same Document (`{_kind:'ref', val: <documentId>}`) or both must be null.
 *
 * Used inside `commitEntity` (haystack route) so every write — whether from
 * the panel, tag-fill APPLY, or the one-shot backfill script — emits a
 * column+tag pair that already satisfies the invariant.
 *
 * Pure utility — no DB, no Prisma. Trivially testable with mocked patches.
 */

/**
 * Models that expose a `documentId` FK column. The read path in the haystack
 * route synthesizes `fileRef = ref(row.documentId)` for exactly these tables,
 * so persisted divergence between column + tag breaks the invariant.
 *
 * `motion` is NOT included — Motion has no documentId column.
 * `hearing.transcriptDocumentId` is a separate concern (not surfaced as
 * fileRef in the read path), so it's also excluded.
 */
export const FILEREF_MODELS: ReadonlySet<string> = new Set([
  'motionEvent',
  'motionAttachment',
  'clerksRecord',
  'reportersRecord',
]);

/**
 * Pick the "primary" Document for a Filing from a candidate list.
 *
 * Used by the fileRef backfill (pass 2) to choose which Document to mirror
 * into an entity row's `documentId` column when the row is still unlinked.
 *
 * Ordering: highest `pageCount` first (null treated as -1), then most-recent
 * `updatedAt`, then most-recent `createdAt`. Returns `null` if the list is
 * empty.
 *
 * Pure function — no DB access. The caller supplies the candidate set
 * (typically `Document.findMany({where:{filingId: <id>}})`).
 */
export interface PrimaryDocCandidate {
  id: string;
  pageCount: number | null;
  updatedAt: Date;
  createdAt: Date;
}

export function pickPrimaryDocument(
  candidates: readonly PrimaryDocCandidate[],
): PrimaryDocCandidate | null {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => {
    const pcA = a.pageCount ?? -1;
    const pcB = b.pageCount ?? -1;
    if (pcB !== pcA) return pcB - pcA;
    const uA = a.updatedAt.getTime();
    const uB = b.updatedAt.getTime();
    if (uB !== uA) return uB - uA;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  return sorted[0];
}

/**
 * Build the commitEntity patch that links an unlinked entity row to its
 * primary Document. Returns `null` when there's no Document to link to
 * (caller should skip).
 *
 * The patch only sets `fileRef`; `enforceFileRefSync` (invoked inside
 * `commitEntity`) mirrors that into the `documentId` column automatically.
 */
export function buildFileRefLinkPatch(
  candidates: readonly PrimaryDocCandidate[],
): { fileRef: { _kind: 'ref'; val: string } } | null {
  const primary = pickPrimaryDocument(candidates);
  if (!primary) return null;
  return { fileRef: { _kind: 'ref', val: primary.id } };
}

/** Extract a ref id from a Hayson `@ref` payload or a bare string. */
function refId(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v || null;
  if (typeof v === 'object') {
    const o = v as { val?: unknown; id?: unknown };
    const inner = o.val ?? o.id;
    return typeof inner === 'string' && inner ? inner : null;
  }
  return null;
}

/**
 * Enforce the `fileRef ⇔ documentId` invariant on a single commit patch.
 *
 * Mutates `columnPatch` and `tagPatch` in place. Idempotent: rows already
 * satisfying the invariant produce an equal-shape rewrite (canonical ref
 * payload), which the surrounding tag-merge logic will treat as a no-op.
 *
 * Behavior:
 *  - If `columnPatch.documentId` is set:
 *      - non-null string → set `tagPatch.fileRef = {_kind:'ref', val:<id>}`
 *      - null            → set `tagPatch.fileRef = null` (drops the tag on merge)
 *  - Else if `tagPatch.fileRef` is set:
 *      - ref with id     → mirror to `columnPatch.documentId = <id>`,
 *                          normalize tag to canonical ref shape
 *      - null            → mirror to `columnPatch.documentId = null`
 *  - Else: no-op.
 *
 * Models without a documentId column are no-ops regardless of patch contents.
 */
export function enforceFileRefSync(
  model: string,
  columnPatch: Record<string, unknown>,
  tagPatch: Record<string, unknown>,
): void {
  if (!FILEREF_MODELS.has(model)) return;

  const hasColKey = Object.prototype.hasOwnProperty.call(columnPatch, 'documentId');
  const hasTagKey = Object.prototype.hasOwnProperty.call(tagPatch, 'fileRef');

  if (hasColKey) {
    const docId = columnPatch.documentId;
    if (docId == null) {
      tagPatch.fileRef = null;
    } else if (typeof docId === 'string' && docId) {
      tagPatch.fileRef = { _kind: 'ref', val: docId };
    }
    return;
  }

  if (hasTagKey) {
    const id = refId(tagPatch.fileRef);
    columnPatch.documentId = id;
    if (id) {
      tagPatch.fileRef = { _kind: 'ref', val: id };
    } else {
      tagPatch.fileRef = null;
    }
  }
}
