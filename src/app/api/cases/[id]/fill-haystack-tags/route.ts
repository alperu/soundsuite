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
  /**
   * Required when `dryRun=false`. Each entry carries everything the server
   * needs to commit a single (filing, field) — the apply path does NOT re-run
   * the LLM extractor. The client passes back the exact `proposedValue` /
   * `personSeed` from the dryRun response, so the commit is deterministic and
   * cheap (no embedding, no extraction).
   *
   * For person-ref fields the client typically sends `proposedValue: null` +
   * a `personSeed { name, marker }`; the server resolves-or-creates the Person
   * at apply-time.
   */
  accept?: Array<{
    filingId: string;
    field: HaystackTagField;
    proposedValue?: unknown;
    personSeed?: { name: string; marker: 'judge' | 'courtReporter' | null };
    /** Optional — used only for the ActionLog `beforeValue`. The server
     * re-reads the DB row for the authoritative current value before writing. */
    currentValue?: unknown;
  }>;
  /** When true, response includes per-filing diagnostics (durationMs, primaryDocumentId, error). */
  debug?: boolean;
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
  /** Value the extractor wants to write (ref payload or ISO date string). When
   * a person ref is proposed but the underlying Person doesn't exist yet, this
   * stays null and `personSeed` carries the name to upsert at apply time. */
  proposedValue: unknown;
  /** Optional human-readable form (e.g. "Hon. Roberts" for a judge ref). */
  proposedDisplay?: string;
  /** Optional excerpt from the indexed text that supports the proposal. */
  sourceExcerpt?: string;
  confidence: 'high' | 'medium' | 'low';
  /** When set, accepting the suggestion will resolve-or-create a Person with
   * this name + intrinsic marker, and the resulting id becomes the ref value.
   * Keeps dryRun writes-free: no Person rows are upserted until the user
   * explicitly accepts. */
  personSeed?: { name: string; marker: 'judge' | 'courtReporter' | null };
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
    const debug = body.debug === true;
    // fileRef is managed by the ingestion pipeline (Document.filePath +
    // FK on the entity's documentId column). The "Fix paths" toolbar action
    // handles rebases on rename. AI proposals for fileRef were noisy and
    // duplicative — exclude from the default field set. Callers can still
    // request it explicitly via `fields:['fileRef']`.
    const defaultFields = HAYSTACK_TAG_FIELDS.filter((f) => f !== 'fileRef');
    const requestedFields: HaystackTagField[] = Array.isArray(body.fields) && body.fields.length > 0
      ? body.fields.filter((f) => HAYSTACK_TAG_FIELDS.includes(f as HaystackTagField))
      : defaultFields;

    // ─── Pick AI model (only needed for dryRun; apply path uses no LLM) ────
    const config = await getConfig();
    const primary = pickPrimary(config);
    const fallback = pickFallback(config);
    if (dryRun && !primary) {
      return NextResponse.json(
        {
          ok: false,
          error: 'ai_not_configured: set primary provider/model at /admin/aiservices',
        },
        { status: 400 },
      );
    }

    // ════════════════════════════════════════════════════════════════════════
    // APPLY PATH — skip the LLM entirely. The client already has the
    // suggestions from a prior dryRun and passes back proposedValue/personSeed
    // in each accept[] entry. We only need to resolve refs + commit.
    // ════════════════════════════════════════════════════════════════════════
    if (!dryRun) {
      const acceptList = Array.isArray(body.accept) ? body.accept : [];
      if (acceptList.length === 0) {
        return NextResponse.json({
          ok: true,
          scanned: 0,
          suggestions: [],
          applied: [],
          note: 'dryRun=false but accept[] is empty — no writes performed',
        });
      }

      // Limit targets to the filings actually mentioned in accept[].
      const acceptFilingIds = Array.from(new Set(acceptList.map((a) => a.filingId)));
      const targets = await loadFilingTargets(id, acceptFilingIds);
      const targetByFilingId = new Map<string, ResolvedFilingTarget>();
      for (const t of targets) targetByFilingId.set(t.filingId, t);

      const applied: Array<{ filingId: string; field: HaystackTagField; actionLogId: string }> = [];
      const modelTag = primary ? `${primary.provider}:${primary.model}` : 'apply-only';

      const writeAttemptLog = async (args: {
        target: ResolvedFilingTarget;
        field: string;
        status: string;
        beforeValue: unknown;
        afterValue: unknown;
        errorMessage?: string;
      }) => {
        return (prisma as any).actionLog.create({
          data: {
            caseId: id,
            action: 'Tag fill',
            target: `${args.target.filingTitle} · ${args.field}`,
            status: args.status,
            logType: 'tag-fill',
            detail: JSON.stringify({
              filingId: args.target.filingId,
              filingTitle: args.target.filingTitle,
              kind: args.target.kind,
              field: args.field,
              beforeValue: args.beforeValue,
              afterValue: args.afterValue,
              suggestionSource: 'ai',
              model: modelTag,
              ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
            }),
          },
        });
      };

      console.log(`[tag-fill] APPLY case=${id} accepted=${acceptList.length} (no LLM re-run)`);

      for (const entry of acceptList) {
        const field = entry.field as HaystackTagField;
        if (!HAYSTACK_TAG_FIELDS.includes(field)) {
          console.warn(`[tag-fill] APPLY rejected ${entry.filingId}::${field}: unknown field`);
          continue;
        }
        const target = targetByFilingId.get(entry.filingId);
        if (!target) {
          console.warn(`[tag-fill] APPLY filing=${entry.filingId} field=${field} → target not found`);
          continue;
        }

        // Re-read the authoritative current value from the DB. Don't trust the
        // client's currentValue — it's only used as a hint.
        const beforeValue = readCurrentValue(target.row, field) ?? null;

        if (field === 'fileRef' && target.kind === 'motion') {
          console.warn(`[tag-fill] APPLY skipped filing=${target.filingId} field=fileRef: motion kind has no documentId`);
          await writeAttemptLog({
            target, field, status: 'skipped', beforeValue,
            afterValue: entry.proposedValue ?? null,
            errorMessage: 'fileRef is not applicable to motion-kind filings',
          }).catch(() => undefined);
          continue;
        }

        if (entry.proposedValue == null && !entry.personSeed) {
          console.warn(`[tag-fill] APPLY filing=${target.filingId} field=${field} → no proposedValue or personSeed`);
          await writeAttemptLog({
            target, field, status: 'failed', beforeValue, afterValue: null,
            errorMessage: 'No proposedValue or personSeed in accept[] entry',
          }).catch(() => undefined);
          continue;
        }

        let afterValue: unknown = entry.proposedValue;
        if (afterValue == null && entry.personSeed) {
          console.log(`[tag-fill] APPLY resolving person name="${entry.personSeed.name}" marker=${entry.personSeed.marker ?? 'none'}`);
          const person = await resolveOrCreatePerson(
            entry.personSeed.name,
            entry.personSeed.marker,
          );
          if (!person) {
            console.warn(`[tag-fill] APPLY personSeed resolve failed filing=${target.filingId} field=${field} name="${entry.personSeed.name}"`);
            await writeAttemptLog({
              target, field, status: 'failed', beforeValue, afterValue: null,
              errorMessage: `Could not resolve or create Person "${entry.personSeed.name}"`,
            }).catch(() => undefined);
            continue;
          }
          afterValue = { _kind: 'ref', val: person.id };
          console.log(`[tag-fill] APPLY person resolved id=${person.id}`);
        }

        const displayAfter = JSON.stringify(afterValue).slice(0, 80);
        console.log(`[tag-fill] APPLY trying filing="${target.filingTitle}" field=${field} → ${displayAfter}`);

        try {
          const commitResult = await commitEntity({
            id: target.filingId,
            kind: target.kind,
            patch: { [field]: afterValue },
          });
          if (!commitResult.ok) {
            console.warn(`[tag-fill] APPLY commit failed filing=${target.filingId} field=${field}: ${commitResult.errGridJson}`);
            await writeAttemptLog({
              target, field, status: 'failed', beforeValue, afterValue,
              errorMessage: `commitEntity rejected: ${commitResult.errGridJson ?? 'unknown'}`,
            }).catch(() => undefined);
            continue;
          }
          const log = await writeAttemptLog({
            target, field, status: 'committed', beforeValue, afterValue,
          });
          console.log(`[tag-fill] APPLY committed filing=${target.filingId} field=${field} actionLogId=${log.id}`);
          applied.push({ filingId: target.filingId, field, actionLogId: log.id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tag-fill] APPLY write path failed filing=${target.filingId} field=${field}: ${msg}`);
          await writeAttemptLog({
            target, field, status: 'failed', beforeValue, afterValue,
            errorMessage: msg,
          }).catch(() => undefined);
        }
      }

      console.log(`[tag-fill] APPLY done case=${id} committed=${applied.length}/${acceptList.length}`);

      return NextResponse.json({
        ok: true,
        scanned: targets.length,
        suggestions: [],
        applied,
      });
    }

    // ════════════════════════════════════════════════════════════════════════
    // DRY-RUN PATH — full extractor pass.
    // ════════════════════════════════════════════════════════════════════════

    // ─── Resolve targets ───────────────────────────────────────────────────
    const targets = await loadFilingTargets(id, body.filingIds);

    // Diagnostic log helper — writes to the same ActionLog table the
    // client polls. Always best-effort; never throws back to caller.
    const writeDiagLog = (target: ResolvedFilingTarget | null, status: string, step: string, detail: Record<string, unknown>) => {
      void (prisma as any).actionLog.create({
        data: {
          caseId: id,
          action: 'Tag fill',
          target: target ? `${target.filingTitle} · ${step}` : `(case) · ${step}`,
          status,
          logType: 'tag-fill',
          detail: JSON.stringify({
            step,
            ...(target ? { filingId: target.filingId, filingTitle: target.filingTitle, kind: target.kind } : {}),
            ...detail,
          }),
        },
      }).catch(() => undefined);
    };

    writeDiagLog(null, 'pending', 'dryRun-start', {
      filings: targets.length,
      filingIds: targets.map((t) => t.filingId),
    });

    // ─── VectorStore (lazy) ────────────────────────────────────────────────
    let vectorStore: VectorStore | null = null;
    try {
      vectorStore = new VectorStore({
        dbPath: process.env.LANCEDB_PATH || './data/lancedb',
        tableName: 'chunks',
      });
      await vectorStore.initialize();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tag-fill] LanceDB init failed: ${msg}`);
      writeDiagLog(null, 'partial', 'vectorstore-unavailable', { errorMessage: msg });
      vectorStore = null;
    }

    // ─── Per-filing extraction ─────────────────────────────────────────────
    const suggestions: FillTagSuggestion[] = [];
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
          primary: primary!,
          fallback,
        });
        suggestionCount = perFiling.length;
        suggestions.push(...perFiling);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[tag-fill] filing ${target.filingId} failed: ${lastError}`);
      }
      writeDiagLog(
        target,
        lastError ? 'error' : suggestionCount > 0 ? 'success' : 'partial',
        'detect',
        {
          candidates: suggestionCount,
          fields: suggestions.filter((s) => s.filingId === target.filingId).map((s) => s.field),
          durationMs: Date.now() - t0,
          ...(lastError ? { errorMessage: lastError } : {}),
        },
      );
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

    {
      const payload: FillTagsResponse & {
        diagnostics?: unknown;
        vectorStoreInitialized?: boolean;
        primary?: unknown;
        fallback?: unknown;
      } = { ok: true, scanned: targets.length, suggestions };
      if (debug) {
        payload.diagnostics = diagnostics;
        payload.vectorStoreInitialized = vectorStore !== null;
        payload.primary = primary ? { provider: primary.provider, model: primary.model } : null;
        payload.fallback = fallback ? { provider: fallback.provider, model: fallback.model } : null;
      }
      return NextResponse.json(payload);
    }

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
/**
 * Deterministic `filedOn` detection — runs before the LLM. Two sources:
 *   1. Parent Filing.filingDate (Prisma column) — authoritative when set.
 *   2. File-stamp regex against the first few chunks (clerk's office filing
 *      stamps follow a small set of formats: "FILED <date>", "Filed for
 *      Record on <date>", Texas District-Clerk stamps, etc.).
 *
 * Returns null when no source produces a date. The chunk-regex path returns
 * a `medium` confidence; the DB path returns `high` since it's already
 * authoritative on the Filing record.
 */
async function detectFiledOnDeterministic(
  target: ResolvedFilingTarget,
  chunks: ChunkExcerpt[],
): Promise<{ iso: string; source: string; confidence: 'high' | 'medium' } | null> {
  // 1. DB fallback — Filing.filingDate is the canonical value if set.
  try {
    const filing = await (prisma as any).filing.findUnique({
      where: { id: target.filingId },
      select: { filingDate: true },
    });
    if (filing?.filingDate) {
      const iso =
        filing.filingDate instanceof Date
          ? filing.filingDate.toISOString().slice(0, 10)
          : String(filing.filingDate).slice(0, 10);
      return { iso, source: `Filing.filingDate=${iso}`, confidence: 'high' };
    }
  } catch {
    /* best-effort — fall through to regex */
  }

  // 2. Regex over first chunks. Match the most common clerk-stamp shapes.
  //    Order matters: try the most specific patterns first.
  const stampPatterns: Array<{ re: RegExp; label: string }> = [
    { re: /\bFiled\s+for\s+Record\s+(?:on\s+)?(\d{1,2}\/\d{1,2}\/\d{4})/i, label: 'Filed for Record' },
    { re: /\bFiled\s+for\s+Record\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})/i, label: 'Filed for Record' },
    { re: /\bFILED\s+(?:on\s+)?(\d{1,2}\/\d{1,2}\/\d{4})/i, label: 'FILED' },
    { re: /\bFILED\s+(?:on\s+)?(\d{4}-\d{2}-\d{2})/i, label: 'FILED' },
    { re: /\bFILED:\s+(\d{1,2}\/\d{1,2}\/\d{4})/i, label: 'FILED:' },
    { re: /\bFILED\s+IN\s+THE\s+\w[\w\s]*?\s+(\d{1,2}\/\d{1,2}\/\d{4})/i, label: 'FILED IN' },
    { re: /\bCourt\s+Filing\s+Date:?\s+(\d{1,2}\/\d{1,2}\/\d{4})/i, label: 'Court Filing Date' },
    { re: /\bCourt\s+Filing\s+Date:?\s+(\d{4}-\d{2}-\d{2})/i, label: 'Court Filing Date' },
    // Texas DC stamp: usually three-line — capture date alongside the
    // "DISTRICT CLERK" or "Velva L. Price" / "Anne Lorentzen" name nearby.
    { re: /(\d{1,2}\/\d{1,2}\/\d{4})\s+\d{1,2}:\d{2}\s+[AP]M\s+(?:DISTRICT\s+CLERK|VELVA|ANNE\s+LORENTZEN)/i, label: 'DC stamp' },
  ];

  const scanText = chunks.slice(0, 4).map((c) => c.text).join('\n');
  if (!scanText.trim()) return null;

  for (const { re, label } of stampPatterns) {
    const m = re.exec(scanText);
    if (!m) continue;
    const raw = m[1];
    const iso = normalizeIsoDate(raw);
    if (!iso) continue;
    // Pull the surrounding ±60 chars as the source excerpt.
    const start = Math.max(0, (m.index ?? 0) - 60);
    const end = Math.min(scanText.length, (m.index ?? 0) + m[0].length + 60);
    const source = `${label}: …${scanText.slice(start, end).trim().replace(/\s+/g, ' ')}…`;
    return { iso, source, confidence: 'medium' };
  }

  return null;
}

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
  let aiFields = fields.filter((f) => f !== 'fileRef');
  if (aiFields.length === 0) return out;

  // ─── Load chunks ──────────────────────────────────────────────────────────
  let chunks: ChunkExcerpt[] = [];
  if (target.primaryDocumentId) {
    chunks = await loadChunks(vectorStore, target.primaryDocumentId);
  }

  // ─── Deterministic `filedOn` ─────────────────────────────────────────────
  // The LLM is unreliable for date stamps — they're tiny, often in headers,
  // and the model loses them under longer chunks. Run a regex pass against
  // the first few chunks AND check the parent Filing.filingDate column. If
  // we get a date, emit the suggestion now and drop filedOn from the AI
  // list so the LLM doesn't waste tokens on it.
  if (aiFields.includes('filedOn')) {
    const detected = await detectFiledOnDeterministic(target, chunks);
    if (detected) {
      const current = readCurrentValue(target.row, 'filedOn');
      const iso = normalizeIsoDate(detected.iso) ?? detected.iso;
      if (!valuesEqual(current, iso)) {
        out.push({
          filingId: target.filingId,
          filingTitle: target.filingTitle,
          field: 'filedOn',
          currentValue: current ?? null,
          proposedValue: iso,
          proposedDisplay: iso,
          sourceExcerpt: detected.source,
          confidence: detected.confidence,
        });
        aiFields = aiFields.filter((f) => f !== 'filedOn');
      }
    }
  }

  if (chunks.length === 0 || aiFields.length === 0) {
    // Without indexed text we can't reliably extract anything else — return
    // whatever (if anything) the deterministic paths produced.
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

    // For ref fields with a deferred personSeed, proposedValue is intentionally
    // null at suggest-time (Person upsert happens at apply-time). Skipping via
    // valuesEqual(null, null)=true would drop every person-ref proposal — and,
    // on the apply re-run, would silently filter out accepted rows so they
    // never reach the commit loop.
    if (!proposal.personSeed && valuesEqual(proposal.proposedValue, proposal.currentValue)) {
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
      // Defer Person upsert to apply-time so dryRun stays write-free.
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: null,
        proposedDisplay: name!,
        personSeed: { name: name!, marker: 'judge' },
        sourceExcerpt:
          data.judge?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: (data.judge?.confidence as 'high' | 'medium' | 'low') ?? 'medium',
      };
    }
    case 'movantRef': {
      const name = data.movant?.name;
      if (!isLikelyValidName(name)) return null;
      // Movant role is contextual (not intrinsic) — no intrinsic marker.
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: null,
        proposedDisplay: name!,
        personSeed: { name: name!, marker: null },
        sourceExcerpt: data.movant?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: 'medium',
      };
    }
    case 'respondentRef': {
      const name = data.respondent?.name;
      if (!isLikelyValidName(name)) return null;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: null,
        proposedDisplay: name!,
        personSeed: { name: name!, marker: null },
        sourceExcerpt: data.respondent?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: 'medium',
      };
    }
    case 'reporterRef': {
      const name = data.reporter?.name;
      if (!isLikelyValidName(name)) return null;
      const display = data.reporter?.csrNumber
        ? `${name} (CSR ${data.reporter.csrNumber})`
        : name!;
      return {
        filingId: target.filingId,
        filingTitle: target.filingTitle,
        field,
        currentValue: current,
        proposedValue: null,
        proposedDisplay: display,
        personSeed: { name: name!, marker: 'courtReporter' },
        sourceExcerpt: data.reporter?.evidenceQuote ?? pickExcerpt(chunks, name),
        confidence: 'high',
      };
    }
    default:
      return null;
  }
}
