import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getConfig } from '@/lib/db/config';
import { VectorStore } from '@/lib/vector/vector-store';
import { commitEntity } from '@/app/api/haystack/[op]/route';
import {
  loadFilingTargets,
  loadChunks,
  buildPrompt,
  extractFields,
  pickPrimary,
  pickFallback,
  resolveOrCreatePerson,
  readCurrentValue,
  valuesEqual,
  pickExcerpt,
  normalizeIsoDate,
  isLikelyValidName,
  type ChunkExcerpt,
  type ExtractedFields,
  type ResolvedFilingTarget,
} from '@/lib/tag-fill/extractor';

/**
 * Allowed haystack tag fields that an extractor may suggest for.
 * Keep in sync with the Filing schema and the Phase-2 extractor prompt.
 */
export type HaystackTagField =
  | 'filedOn'
  | 'receivedOn'
  | 'judgeRef'
  | 'movantRef'
  | 'respondentRef'
  | 'reporterRef'
  | 'fileRef';

export const HAYSTACK_TAG_FIELDS: HaystackTagField[] = [
  'filedOn',
  'receivedOn',
  'judgeRef',
  'movantRef',
  'respondentRef',
  'reporterRef',
  'fileRef',
];

/**
 * Request body for POST /api/cases/[id]/fill-haystack-tags.
 *
 * All fields are optional. By default the route scans every filing in the
 * case and proposes values for every supported field, without writing.
 */
export interface FillTagsRequest {
  /** Optional: limit to specific filing IDs. Default = all filings in case. */
  filingIds?: string[];
  /** Optional: limit to specific fields. Default = HAYSTACK_TAG_FIELDS. */
  fields?: HaystackTagField[];
  /** Default true — return suggestions without writing them. */
  dryRun?: boolean;
  /** Phase 2 — required when dryRun=false. List of (filing, field) tuples to persist. */
  accept?: Array<{ filingId: string; field: HaystackTagField }>;
}

/**
 * One proposed change for a single (filing, field) pair.
 *
 * `proposedValue` is what the extractor wants to assign. For dates this is an
 * ISO-8601 string; for *Ref fields this is a Hayson `@ref` payload (whatever
 * the Phase-2 extractor decides) — kept as `unknown` here so consumers must
 * narrow before use.
 */
export interface FillTagSuggestion {
  filingId: string;
  filingTitle: string;
  /** Field name on the Filing row. See `HaystackTagField`. */
  field: HaystackTagField | string;
  /** Present value on the row (likely null/undefined for un-tagged filings). */
  currentValue: unknown;
  /** Value the extractor wants to write (ref payload or ISO date string). */
  proposedValue: unknown;
  /** Optional human-readable form (e.g. "Hon. Roberts" for a judge ref). */
  proposedDisplay?: string;
  /** Optional excerpt from the indexed text that supports the proposal. */
  sourceExcerpt?: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Response shape for POST /api/cases/[id]/fill-haystack-tags.
 */
export interface FillTagsResponse {
  ok: true;
  /** Number of filings inspected. */
  scanned: number;
  suggestions: FillTagSuggestion[];
  /** When dryRun=false, the (filingId, field) pairs that were persisted. */
  applied?: Array<{ filingId: string; field: HaystackTagField; actionLogId: string }>;
  /** Optional info / error message. */
  note?: string;
}

export interface FillTagsErrorResponse {
  ok: false;
  error: string;
}

/**
 * POST /api/cases/[id]/fill-haystack-tags
 *
 * Phase 2: pull indexed text per filing, call the configured AI model for
 * structured extraction (date / judge / parties / reporter), resolve names
 * to Person rows (upserting when missing), and return suggestions. When
 * dryRun=false, the `accept` list selects which (filing, field) tuples to
 * persist via commitEntity. Each commit is recorded as an ActionLog row
 * with logType='tag-fill' so /revert can roll it back.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse<FillTagsResponse | FillTagsErrorResponse>> {
  try {
    const { id } = await params;

    const caseRow = await (prisma as any).case.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!caseRow) {
      return NextResponse.json({ ok: false, error: 'case_not_found' }, { status: 404 });
    }

    let body: FillTagsRequest = {};
    try {
      const raw = await request.json();
      if (raw && typeof raw === 'object') body = raw as FillTagsRequest;
    } catch {
      // empty body is fine — all fields are optional
    }

    const dryRun = body.dryRun !== false;
    const requestedFields: HaystackTagField[] = Array.isArray(body.fields) && body.fields.length > 0
      ? body.fields.filter((f) => HAYSTACK_TAG_FIELDS.includes(f as HaystackTagField))
      : HAYSTACK_TAG_FIELDS.slice();

    // ─── Resolve targets ───────────────────────────────────────────────────
    const targets = await loadFilingTargets(id, body.filingIds);

    // ─── Pick AI model ─────────────────────────────────────────────────────
    const config = await getConfig();
    const primary = pickPrimary(config);
    const fallback = pickFallback(config);
    if (!primary) {
      return NextResponse.json(
        {
          ok: false,
          error: 'ai_not_configured: set primary provider/model at /admin/aiservices',
        },
        { status: 400 },
      );
    }

    // ─── VectorStore (lazy) ────────────────────────────────────────────────
    let vectorStore: VectorStore | null = null;
    try {
      vectorStore = new VectorStore({
        dbPath: process.env.LANCEDB_PATH || './data/lancedb',
        tableName: 'chunks',
      });
      await vectorStore.initialize();
    } catch (err) {
      console.warn(
        `[tag-fill] LanceDB init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      vectorStore = null;
    }

    // ─── Per-filing extraction ─────────────────────────────────────────────
    const suggestions: FillTagSuggestion[] = [];
    const debug = body.debug === true;
    const diagnostics: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      const t0 = Date.now();
      let lastError: string | null = null;
      let suggestionCount = 0;
      try {
        const perFiling = await suggestForFiling({
          target,
          vectorStore,
          fields: requestedFields,
          primary,
          fallback,
        });
        suggestionCount = perFiling.length;
        suggestions.push(...perFiling);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[tag-fill] filing ${target.filingId} failed: ${lastError}`);
      }
      if (debug) {
        diagnostics.push({
          filingId: target.filingId,
          filingTitle: target.filingTitle,
          kind: target.kind,
          model: target.model,
          primaryDocumentId: target.primaryDocumentId,
          durationMs: Date.now() - t0,
          suggestionCount,
          error: lastError,
        });
      }
    }

    // ─── DRY RUN: return suggestions only ──────────────────────────────────
    if (dryRun) {
      const payload: Record<string, unknown> = { ok: true, scanned: targets.length, suggestions };
      if (debug) {
        payload.diagnostics = diagnostics;
        payload.vectorStoreInitialized = vectorStore !== null;
        payload.primary = { provider: primary.provider, model: primary.model };
        payload.fallback = fallback ? { provider: fallback.provider, model: fallback.model } : null;
      }
      return NextResponse.json(payload);
    }

    // ─── APPLY: persist accepted (filing, field) tuples ────────────────────
    const acceptList = Array.isArray(body.accept) ? body.accept : [];
    if (acceptList.length === 0) {
      return NextResponse.json({
        ok: true,
        scanned: targets.length,
        suggestions,
        applied: [],
        note: 'dryRun=false but accept[] is empty — no writes performed',
      });
    }

    const acceptKey = (filingId: string, field: string) => `${filingId}::${field}`;
    const acceptSet = new Set(acceptList.map((a) => acceptKey(a.filingId, a.field)));
    const suggestionByKey = new Map<string, FillTagSuggestion>();
    for (const s of suggestions) suggestionByKey.set(acceptKey(s.filingId, String(s.field)), s);
    const targetByFilingId = new Map<string, ResolvedFilingTarget>();
    for (const t of targets) targetByFilingId.set(t.filingId, t);

    const applied: Array<{ filingId: string; field: HaystackTagField; actionLogId: string }> = [];

    for (const key of acceptSet) {
      const suggestion = suggestionByKey.get(key);
      if (!suggestion) continue;
      const target = targetByFilingId.get(suggestion.filingId);
      if (!target) continue;
      const field = suggestion.field as HaystackTagField;

      // Skip fileRef writes for Motion-typed filings — Motion has no documentId
      // column and the tags-only fileRef is meaningless without it (audit §3).
      if (field === 'fileRef' && target.kind === 'motion') continue;

      const beforeValue = suggestion.currentValue ?? null;
      const afterValue = suggestion.proposedValue;

      try {
        const commitResult = await commitEntity({
          id: target.filingId,
          kind: target.kind,
          patch: { [field]: afterValue },
        });
        if (!commitResult.ok) {
          console.warn(
            `[tag-fill] commit failed filing=${target.filingId} field=${field}: ${commitResult.errGridJson}`,
          );
          continue;
        }

        const log = await (prisma as any).actionLog.create({
          data: {
            caseId: id,
            action: 'Tag fill',
            target: `${target.filingTitle} · ${field}`,
            status: 'committed',
            logType: 'tag-fill',
            detail: JSON.stringify({
              filingId: target.filingId,
              filingTitle: target.filingTitle,
              kind: target.kind,
              field,
              beforeValue,
              afterValue,
              suggestionSource: 'ai',
              model: `${primary.provider}:${primary.model}`,
            }),
          },
        });

        applied.push({ filingId: target.filingId, field, actionLogId: log.id });
      } catch (err) {
        console.warn(
          `[tag-fill] write path failed filing=${target.filingId} field=${field}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      scanned: targets.length,
      suggestions,
      applied,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'fill_haystack_tags_failed' },
      { status: 500 },
    );
  }
}

/**
 * Run the extractor for ONE filing. Returns a list of suggestions (one per
 * field that the model returned and that differs from current value).
 */
async function suggestForFiling(args: {
  target: ResolvedFilingTarget;
  vectorStore: VectorStore | null;
  fields: HaystackTagField[];
  primary: { provider: any; model: string };
  fallback: { provider: any; model: string } | null;
}): Promise<FillTagSuggestion[]> {
  const { target, vectorStore, fields, primary, fallback } = args;
  const out: FillTagSuggestion[] = [];

  // ─── fileRef — deterministic, NOT AI-extracted (audit §3) ─────────────────
  // For non-Motion kinds where the entity row exposes a documentId column,
  // propose the primary Document as fileRef whenever it differs from current.
  if (fields.includes('fileRef') && target.kind !== 'motion' && target.primaryDocumentId) {
    const current = readCurrentValue(target.row, 'fileRef');
    const proposed = { _kind: 'ref', val: target.primaryDocumentId };
    if (!valuesEqual(current, proposed)) {
      out.push({
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field: 'fileRef',
        currentValue: current ?? null,
        proposedValue: proposed,
        proposedDisplay: 'Primary document',
        confidence: 'high',
      });
    }
  }

  // If no AI-extractable fields requested, return now.
  const aiFields = fields.filter((f) => f !== 'fileRef');
  if (aiFields.length === 0) return out;

  // ─── Load chunks ──────────────────────────────────────────────────────────
  let chunks: ChunkExcerpt[] = [];
  if (target.primaryDocumentId) {
    chunks = await loadChunks(vectorStore, target.primaryDocumentId);
  }
  if (chunks.length === 0) {
    // Without indexed text we can't reliably extract anything else — return
    // whatever (if anything) the fileRef path produced.
    return out;
  }

  // ─── Build prompt + call LLM ──────────────────────────────────────────────
  const prompt = buildPrompt({
    filingTitle: target.filingTitle,
    filingType: target.filingType,
    chunks,
  });

  const llmResult = await extractFields(primary, fallback, prompt);
  if (!llmResult) return out;

  const data: ExtractedFields = llmResult.data;

  // ─── Map extracted fields → suggestions ───────────────────────────────────
  for (const field of aiFields) {
    const proposal = await mapFieldFromExtraction({
      field,
      data,
      target,
      chunks,
    });
    if (!proposal) {
      console.log(`[tag-fill] filing=${target.filingId} field=${field} → map returned null (no data or invalid)`);
      continue;
    }

    if (valuesEqual(proposal.proposedValue, proposal.currentValue)) {
      console.log(`[tag-fill] filing=${target.filingId} field=${field} → skipped (current==proposed: ${JSON.stringify(proposal.currentValue)})`);
      continue;
    }
    console.log(`[tag-fill] filing=${target.filingId} field=${field} → suggesting ${JSON.stringify(proposal.proposedValue).slice(0,80)}`);
    out.push(proposal);
  }

  return out;
}

/**
 * Translate one (field, extracted-data) pair into a FillTagSuggestion, including
 * person resolution for ref fields and ISO normalisation for dates. Returns
 * null when the model didn't supply a usable value for this field.
 */
async function mapFieldFromExtraction(args: {
  field: HaystackTagField;
  data: ExtractedFields;
  target: ResolvedFilingTarget;
  chunks: ChunkExcerpt[];
}): Promise<FillTagSuggestion | null> {
  const { field, data, target, chunks } = args;
  const current = readCurrentValue(target.row, field);

  switch (field) {
    case 'filedOn': {
      const iso = normalizeIsoDate(data.filedOn);
      if (!iso) return null;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: iso,
        proposedDisplay: iso,
        sourceExcerpt: pickExcerpt(chunks, iso) || pickExcerpt(chunks, 'FILED'),
        confidence: 'medium',
      };
    }
    case 'receivedOn': {
      const iso = normalizeIsoDate(data.receivedOn);
      if (!iso) return null;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: iso,
        proposedDisplay: iso,
        sourceExcerpt: pickExcerpt(chunks, iso),
        confidence: 'low',
      };
    }
    case 'judgeRef': {
      const name = data.judge?.name;
      if (!isLikelyValidName(name)) return null;
      const person = await resolveOrCreatePerson(name!, 'judge');
      if (!person) return null;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: { _kind: 'ref', val: person.id },
        proposedDisplay: person.displayName,
        sourceExcerpt:
          data.judge?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: (data.judge?.confidence as 'high' | 'medium' | 'low') ?? 'medium',
      };
    }
    case 'movantRef': {
      const name = data.movant?.name;
      if (!isLikelyValidName(name)) return null;
      // Movant role is contextual (not intrinsic) — pass marker=null.
      const person = await resolveOrCreatePerson(name!, null);
      if (!person) return null;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: { _kind: 'ref', val: person.id },
        proposedDisplay: person.displayName,
        sourceExcerpt: data.movant?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: 'medium',
      };
    }
    case 'respondentRef': {
      const name = data.respondent?.name;
      if (!isLikelyValidName(name)) return null;
      const person = await resolveOrCreatePerson(name!, null);
      if (!person) return null;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: { _kind: 'ref', val: person.id },
        proposedDisplay: person.displayName,
        sourceExcerpt: data.respondent?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: 'medium',
      };
    }
    case 'reporterRef': {
      const name = data.reporter?.name;
      if (!isLikelyValidName(name)) return null;
      const person = await resolveOrCreatePerson(name!, 'courtReporter');
      if (!person) return null;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: { _kind: 'ref', val: person.id },
        proposedDisplay: data.reporter?.csrNumber
          ? `${person.displayName} (CSR ${data.reporter.csrNumber})`
          : person.displayName,
        sourceExcerpt: data.reporter?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: 'high',
      };
    }
    default:
      return null;
  }
}
