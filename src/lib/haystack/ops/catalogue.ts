/**
 * Vendor op catalogue — the one place a Sound Suite (`ss*`) Haystack op is
 * described (docs/PLAN-haystack-mcp-agentic-etl.md §6.1–6.3).
 *
 * Every entry drives three surfaces from the same description:
 *   - the `ops` grid (`params` / `doc` / `ssExposure` columns) so a Haystack
 *     client can discover what an op takes;
 *   - the HTTP adapter in `api/haystack/[op]/route.ts`, which coerces query or
 *     body parameters against `params` before calling the plain function;
 *   - the MCP bridge (`lib/mcp/tools/haystack-ops.ts`), which generates one
 *     tool per op with `params` as its JSON schema.
 *
 * Registration is not exposure. `exposure` says what class of op this is;
 * `runVendorOp` enforces the write gate and the bridge decides profiles from
 * it. An op that deletes, or bulk-writes without enumerating what it touches,
 * does not belong here at all.
 */

export type OpParamType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';

export interface OpParam {
  type: OpParamType;
  description: string;
  required?: boolean;
  /** For `array`: element type. */
  items?: { type: OpParamType };
  /** Documented default; the op applies it, the schema only advertises it. */
  default?: unknown;
  enum?: string[];
}

/**
 * `read`  — writes nothing; both MCP profiles.
 * `write` — mutates rows; routed profile only, and only when the process runs
 *           with `SS_HAYSTACK_WRITE=1` (the same-origin browser proxy is
 *           exempt: the operator at the keyboard is the review gate).
 * `llm`   — reads files and calls a model; costs money; routed only. Writes
 *           nothing itself — its `*Apply` twin is a `write`.
 */
export type OpExposure = 'read' | 'write' | 'llm';

export interface VendorOpSpec {
  name: string;
  dis: string;
  doc: string;
  exposure: OpExposure;
  params: Record<string, OpParam>;
}

const CASE_ID: OpParam = {
  type: 'string',
  description: 'Case id (bare or `@id`). Get ids from `ssScopeGraph` with no arguments.',
};
const LIMIT = (def: number, max: number): OpParam => ({
  type: 'integer',
  description: `Max rows to return (default ${def}, max ${max}). Meta counts are always for the whole set, never for the page.`,
  default: def,
});
const OFFSET: OpParam = { type: 'integer', description: 'Rows to skip (default 0).', default: 0 };
const DRY_RUN: OpParam = {
  type: 'boolean',
  description: 'Default true: report what WOULD change and write nothing. Pass false to apply.',
  default: true,
};

export const VENDOR_OPS: readonly VendorOpSpec[] = [
  // ── read ──────────────────────────────────────────────────────────────────
  {
    name: 'ssScopeGraph',
    dis: 'Scope graph — summary per case, or one case drilled to filings',
    doc:
      'Without caseId: one row per case with filing/document/indexed/unfiled counts and ' +
      '`unconnected` (filings whose DEFINING slot is empty — the worklist size). With caseId: ' +
      'one row per filing with primaryKind, entityKinds, filingDate, doc counts and the refs it ' +
      'holds as bare ids. Never the whole canvas payload — meta carries totals, rows page.',
    exposure: 'read',
    params: { caseId: { ...CASE_ID, required: false }, limit: LIMIT(200, 1000), offset: OFFSET },
  },
  {
    name: 'ssWorklist',
    dis: 'Judgment queue — filings whose defining link is empty, with the deterministic suggestion',
    doc:
      'The queue the ETL loop works from. A row is a filing whose defining slot is empty ' +
      '(respondingTo for a response, replyingTo for a reply, resolves for an order, motionRef for ' +
      'the rest; motions never appear — they are roots). `suggestion` is the same deterministic ' +
      'pick the browser workbench pre-fills (same case, filed after, shared title words) with its ' +
      'reasons and margin, or null with `noCandidateReason`. Nothing here writes; confirming a ' +
      'suggestion is a separate, gated call.',
    exposure: 'read',
    params: {
      caseId: { ...CASE_ID, required: false },
      onlySuggested: { type: 'boolean', description: 'Return only rows the suggester could answer.', default: false },
      limit: LIMIT(100, 500),
      offset: OFFSET,
    },
  },
  {
    name: 'ssFolderSurvey',
    dis: 'Files on disk vs Document rows for a case, matched by path then SHA-256',
    doc:
      'Walks Case.path for PDFs and reconciles against Document rows. Dispositions: `known` ' +
      '(path matches a row; status shown), `moved` (path unknown but the hash matches a row whose ' +
      'stored path is gone — the watcher heals these), `new` (not in the database), `orphaned` ' +
      '(row whose file is missing on disk), `ignored` (operator tombstone). Also reports nested ' +
      'case folders under this path — a real hazard, the watcher attributes by first prefix match. ' +
      'Writes nothing. Hashing only runs for paths the database does not know.',
    exposure: 'read',
    params: {
      caseId: { ...CASE_ID, required: true },
      limit: LIMIT(200, 2000),
      offset: OFFSET,
      disposition: {
        type: 'string',
        description: 'Filter rows to one disposition.',
        enum: ['known', 'moved', 'new', 'orphaned', 'ignored'],
      },
    },
  },
  {
    name: 'ssIngestStatus',
    dis: 'Per-case document status counts, parser coverage, and errored documents',
    doc:
      'One row per case (or the one case asked for): counts by status ' +
      '(DISCOVERED / QUEUED / PROCESSING / INDEXED / ERROR), how many INDEXED rows carry a ' +
      'parserVersion (structured parse) and how many predate it. With caseId the errored ' +
      'documents are listed with their errorMessage. ERROR is terminal — the worker has no retry; ' +
      '`ssRequeueErrored` is the capped way back in.',
    exposure: 'read',
    params: { caseId: { ...CASE_ID, required: false }, limit: LIMIT(100, 1000), offset: OFFSET },
  },
  {
    name: 'ssReadCase',
    dis: 'One case as a grid: meta carries the truth, rows carry the documents',
    doc:
      'Meta: case fields plus discovered/queued/processing/indexed/errored/structured counts, ' +
      'filings, unfiled documents and `unconnected` (defining-slot-empty filings). Rows: one per ' +
      'document with status, filingId, the filing\'s kind, parserVersion (null = ingested before ' +
      'structured parsing, distinct from not ingested), errorMessage and readiness band. Every ' +
      'count in meta is for the whole case even when rows are paged.',
    exposure: 'read',
    params: {
      caseId: { ...CASE_ID, required: true },
      status: { type: 'string', description: 'Filter rows to one Document status.', enum: ['DISCOVERED', 'QUEUED', 'PROCESSING', 'INDEXED', 'ERROR'] },
      limit: LIMIT(200, 2000),
      offset: OFFSET,
    },
  },

  // ── write (gated) ─────────────────────────────────────────────────────────
  {
    name: 'ssCaseEnsure',
    dis: 'Find-or-create a Case; the folder registration',
    doc:
      'Idempotent on `path`, then on `caseNumber`. Creating the Case IS registering the folder: ' +
      'the file watcher is built from Case.path rows and starts discovering PDFs under it. The path ' +
      'must exist as a directory on the server. A caseNumber already bound to a different path is ' +
      'reported as a conflict and nothing is written. dryRun=true (default) reports found / ' +
      'would-create without writing. Writes carry an `ssProvenance` tag.',
    exposure: 'write',
    params: {
      path: { type: 'string', description: 'Absolute folder path on the server.', required: true },
      name: { type: 'string', description: 'Display name. Defaults to the folder basename.' },
      caseNumber: { type: 'string', description: 'Cause / docket number.' },
      jurisdiction: { type: 'string', description: 'Court or jurisdiction label.' },
      county: { type: 'string', description: 'County.' },
      state: { type: 'string', description: 'State.' },
      dryRun: DRY_RUN,
    },
  },
  {
    name: 'ssPromoteDiscovered',
    dis: 'DISCOVERED → QUEUED, bounded, plan-then-apply',
    doc:
      'The step nobody realises is manual: the watcher discovers, nothing promotes. Plans a ' +
      'bounded set (limit is required) from one case, or from the case with the smallest backlog ' +
      'when caseId is omitted (wave order — a systemic failure then shows on tens of documents, not ' +
      'hundreds). dryRun=true returns the plan; dryRun=false applies exactly that selection. ' +
      'Promotion is unfiled (filingId untouched) so a permanently failing document is bounded ' +
      'rather than retried on every restart.',
    exposure: 'write',
    params: {
      caseId: { ...CASE_ID, required: false },
      limit: { type: 'integer', description: 'Max documents to promote. Required — no call promotes the whole backlog by omission.', required: true },
      dryRun: DRY_RUN,
    },
  },
  {
    name: 'ssRequeueErrored',
    dis: 'ERROR → QUEUED, bounded, plan-then-apply',
    doc:
      'Re-drives terminal ERROR documents, clearing errorMessage. Capped by `limit` on purpose: an ' +
      'OCR-not-ready failure pauses every worker for 30 s, so re-driving a permanently broken ' +
      'document degrades throughput for all of them. dryRun=true lists what would be requeued.',
    exposure: 'write',
    params: {
      caseId: { ...CASE_ID, required: false },
      limit: { type: 'integer', description: 'Max documents to requeue. Required.', required: true },
      dryRun: DRY_RUN,
    },
  },

  // ── auto-ingestion (LLM plan, gated apply) ────────────────────────────────
  {
    name: 'ssAutoIngestPlan',
    dis: 'Read the PDFs in a folder and propose case identity, kinds, titles, folders and links',
    doc:
      'Given a folder path: walks it for PDFs, extracts the FIRST TWO PAGES of each, and asks the ' +
      'model (OpenRouter, default deepseek/deepseek-v4.1-flash) for (1) the case identity from the ' +
      'caption block of a sample — court, cause number, parties, with the excerpt as evidence, and ' +
      'disagreement reported rather than resolved; (2) per file, WHAT / WHO / WHEN: kind (motion, ' +
      'notice, response, reply, order, …) and a clean title; which side filed it and who signed; ' +
      'the filed date from the CLERK\'S FILE STAMP (e-file header or "FILED … District Clerk"), the ' +
      'signature date separately, and the stamp text as evidence; plus which motion a ' +
      'response/reply/order answers, by title; (3) a target subfolder per file for the clean-up. ' +
      'Every file is also run through the deterministic regex detector so the two can be compared. ' +
      'Writes nothing and moves nothing. The result is the input to `ssAutoIngestApply`.',
    exposure: 'llm',
    params: {
      path: { type: 'string', description: 'Absolute folder path on the server.', required: true },
      model: { type: 'string', description: 'OpenRouter model id. Default deepseek/deepseek-v4.1-flash.' },
      maxFiles: { type: 'integer', description: 'Cap on PDFs read (default 60, max 400). The folder is still surveyed in full.', default: 60 },
      sampleForCase: { type: 'integer', description: 'How many files feed the case-identity call (default 5).', default: 5 },
      excerptChars: { type: 'integer', description: 'Characters of first-two-page text per file sent to the model (default 1500, max 6000).', default: 1500 },
    },
  },
  {
    name: 'ssAutoIngestApply',
    dis: 'Apply an accepted auto-ingest plan: case, folders, filings, entities, links, queue',
    doc:
      'Takes the plan returned by `ssAutoIngestPlan` — as reviewed, with unwanted items removed. ' +
      'Never re-runs the model: what was reviewed is exactly what is written. Steps, each ' +
      'idempotent: ensure the Case (path registration); optionally move each file into its ' +
      'target subfolder (`organize`), updating the Document row path so the watcher sees a rename, ' +
      'not a new file; create the Filing (slug-deduplicated) and materialise its entity row through ' +
      'ensure-filing and write the who/when it read as tags (filedOn, signedOn, and filedBy / author / ' +
      'stampEvidence under one `ssEtl` tag); attach the Document and promote DISCOVERED → QUEUED; write accepted ' +
      'respondingTo / replyingTo / resolves links through commitEntity with an ssProvenance tag. ' +
      'Links are only written where the plan named a target that resolved to a filing created or ' +
      'found in this run. dryRun=true (default) reports every step without writing.',
    exposure: 'write',
    params: {
      plan: { type: 'object', description: 'The reviewed plan object from ssAutoIngestPlan (rows[0].plan).', required: true },
      organize: { type: 'boolean', description: 'Move files into per-kind subfolders as the plan proposes (default false).', default: false },
      queue: { type: 'boolean', description: 'Promote attached documents to QUEUED (default true).', default: true },
      dryRun: DRY_RUN,
    },
  },
];

export const VENDOR_OP_NAMES = VENDOR_OPS.map((o) => o.name);

export function vendorOpSpec(name: string): VendorOpSpec | undefined {
  return VENDOR_OPS.find((o) => o.name === name);
}

/**
 * Parameter descriptions for the STANDARD ops, so the `ops` grid describes
 * every row the same way. Standard ops carry no `exposure` gate here — `commit`
 * is the exception the plan calls out (§6.3) and is deliberately NOT bridged.
 */
export const STANDARD_OP_PARAMS: Record<string, { doc: string; params: Record<string, OpParam> }> = {
  about: { doc: 'Server identity.', params: {} },
  ops: { doc: 'This grid: every op with its parameters.', params: {} },
  libs: { doc: 'Loaded XETO libs.', params: {} },
  defs: { doc: 'XETO defs — the tag vocabulary.', params: {} },
  filetypes: { doc: 'Supported wire formats.', params: {} },
  nav: { doc: 'Hierarchical navigation.', params: { navId: { type: 'string', description: 'Node to expand; omit for the root.' } } },
  read: {
    doc: 'Read entities by Haystack filter or by id.',
    params: {
      filter: { type: 'string', description: 'Haystack filter with an entity marker (motion, notice, case, person, court, …).', required: true },
      id: { type: 'string', description: 'Direct id lookup (`@id`); the filter then only names the kind.' },
      limit: { type: 'integer', description: 'Max rows.' },
    },
  },
  close: { doc: 'No-op; no session state.', params: {} },
  commit: {
    doc: 'Write an entity. Arbitrary patch — NOT bridged to MCP (see plan §8.5).',
    params: {
      id: { type: 'string', description: '`@id` to update, or "new" to create.', required: true },
      kind: { type: 'string', description: 'Entity kind.', required: true },
      patch: { type: 'object', description: 'Column and tag values.', required: true },
    },
  },
};

/** JSON-Schema shape for a spec's params — what the MCP bridge advertises. */
export function paramsToJsonSchema(params: Record<string, OpParam>): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, p] of Object.entries(params)) {
    const schema: Record<string, unknown> = { type: p.type, description: p.description };
    if (p.items) schema.items = { type: p.items.type };
    if (p.enum) schema.enum = p.enum;
    if (p.default !== undefined) schema.default = p.default;
    properties[name] = schema;
    if (p.required) required.push(name);
  }
  return { type: 'object', properties, required };
}
