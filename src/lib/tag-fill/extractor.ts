/**
 * Tag-fill extractor — Phase 2 implementation.
 *
 * Pulls indexed text chunks for a Filing's primary Document, asks the
 * configured AI model to extract structured haystack tag values, resolves
 * Person names to Person ids (upserting when no match is found), and
 * returns one suggestion per (filing, field) pair where the model's
 * proposal differs from the current value.
 *
 * Pure read on LanceDB; writes (commit + ActionLog) live in the route.
 */

import { prisma } from '@/lib/db/prisma';
import { VectorStore } from '@/lib/vector/vector-store';
import { completeAI, AIMessage } from '@/lib/ai/ai-provider';
import { AIProviderKey } from '@/lib/ai/models';
import { AppConfig } from '@/lib/db/config';
import { classifyFilingEntityKind } from '@/lib/filings/classify-entity-kind';

/**
 * Allowed haystack tag fields. Mirrored from the route file so this module
 * stays free of route-side imports (Next.js bundles route files differently).
 */
export type HaystackTagField =
  | 'filedOn'
  | 'receivedOn'
  | 'judgeRef'
  | 'movantRef'
  | 'respondentRef'
  | 'reporterRef'
  | 'fileRef';

// ─── kind → Prisma model name ────────────────────────────────────────────────
//
// Mirrors KIND_MODEL_MAP from src/app/api/haystack/[op]/route.ts. We can't
// import that directly without dragging the whole opCommit graph into a
// utility module, so we inline the subset we need (the per-filing-type
// kinds all resolve to `motionAttachment`).
const KIND_MODEL_MAP: Record<string, string> = {
  motion: 'motion',
  motionAttachment: 'motionAttachment',
  clerksRecord: 'clerksRecord',
  reportersRecord: 'reportersRecord',
  // Every PER_FILING_TYPE_KINDS entry maps to motionAttachment for the row,
  // but the commit kind we pass to commitEntity stays the per-filing-type kind
  // so commitEntity routes attachmentKind correctly.
  notice: 'motionAttachment',
  letter: 'motionAttachment',
  order: 'motionAttachment',
  proposedOrder: 'motionAttachment',
  petition: 'motionAttachment',
  affidavit: 'motionAttachment',
  subpoena: 'motionAttachment',
  brief: 'motionAttachment',
  response: 'motionAttachment',
  reply: 'motionAttachment',
  judgment: 'motionAttachment',
  decree: 'motionAttachment',
  transcript: 'motionAttachment',
  settlement: 'motionAttachment',
  billOfReview: 'motionAttachment',
  returnOfService: 'motionAttachment',
  demandLetter: 'motionAttachment',
  objection: 'motionAttachment',
  request: 'motionAttachment',
  supplement: 'motionAttachment',
  designation: 'motionAttachment',
  other: 'motionAttachment',
};

export interface ResolvedFilingTarget {
  filingId: string;
  filingTitle: string;
  /** EntityKind used as commitEntity kind (e.g. 'motion', 'brief', 'reportersRecord') */
  kind: string;
  /** Prisma model name (e.g. 'motion', 'motionAttachment'). */
  model: string;
  /** Existing entity row, or null if one hasn't been materialised yet. */
  row: Record<string, unknown> | null;
  /** Primary Document id (largest text + filingId match), or null. */
  primaryDocumentId: string | null;
  /** Filing.filingType — passed to the LLM prompt for context. */
  filingType: string;
}

export interface ExtractedFields {
  filedOn?: string | null;
  receivedOn?: string | null;
  judge?: { name: string; confidence?: 'high' | 'medium' | 'low'; evidenceQuote?: string } | null;
  movant?: { name: string; evidenceQuote?: string } | null;
  respondent?: { name: string; evidenceQuote?: string } | null;
  reporter?: { name: string; csrNumber?: string; evidenceQuote?: string } | null;
}

export interface ChunkExcerpt {
  text: string;
  pageNumber: number;
  chunkIndex: number;
}

// ─── Public: load filing target rows ─────────────────────────────────────────

export function kindToModel(kind: string): string | null {
  return KIND_MODEL_MAP[kind] ?? null;
}

export async function loadFilingTargets(
  caseId: string,
  filingIds?: string[],
): Promise<ResolvedFilingTarget[]> {
  const where: { caseId: string; id?: { in: string[] } } = { caseId };
  if (filingIds && filingIds.length > 0) where.id = { in: filingIds };

  const filings = await (prisma as any).filing.findMany({
    where,
    select: { id: true, title: true, filingType: true },
    take: 50,
  });

  const targets: ResolvedFilingTarget[] = [];
  for (const f of filings) {
    const cls = classifyFilingEntityKind(f.filingType);
    const kind = cls.entityKind;
    const model = KIND_MODEL_MAP[kind];
    if (!model) continue; // unsupported kind — skip silently

    // Entity rows mirror filing.id by convention (see ensureMotion*ForFiling).
    let row: Record<string, unknown> | null = null;
    try {
      row = await (prisma as any)[model].findUnique({ where: { id: f.id } });
    } catch {
      row = null;
    }

    // Primary Document = highest-pageCount Document on this Filing (rough
    // proxy for "main filing PDF" vs. small attachments). Tie-break by most
    // recently updated.
    let primaryDocumentId: string | null = null;
    try {
      const docs = await (prisma as any).document.findMany({
        where: { filingId: f.id },
        select: { id: true, pageCount: true, updatedAt: true, createdAt: true },
      });
      if (docs.length === 1) {
        primaryDocumentId = docs[0].id;
      } else if (docs.length > 1) {
        docs.sort((a: any, b: any) => {
          const pa = Number(a.pageCount ?? 0);
          const pb = Number(b.pageCount ?? 0);
          if (pb !== pa) return pb - pa;
          return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
        });
        primaryDocumentId = docs[0].id;
      }
    } catch (err) {
      console.warn(`[tag-fill] loadFilingTargets: document.findMany failed for filing=${f.id}: ${err instanceof Error ? err.message : String(err)}`);
      primaryDocumentId = null;
    }

    targets.push({
      filingId: f.id,
      filingTitle: f.title,
      kind,
      model,
      row,
      primaryDocumentId,
      filingType: f.filingType,
    });
  }

  return targets;
}

// ─── Public: read chunks for a document (cap at ~6000 chars / 12 chunks) ────

export async function loadChunks(
  vectorStore: VectorStore | null,
  documentId: string,
  maxChars = 6000,
  maxChunks = 12,
): Promise<ChunkExcerpt[]> {
  if (!vectorStore || !documentId) return [];
  try {
    // Direct fetch by documentId — vectorStore.search({filter:{documentId}})
    // without a vector/text query returns [] (it requires a query to drive
    // ranking). findByDocument bypasses that and just filters the table.
    const results = await vectorStore.findByDocument(documentId, 60);

    // Prefer chunks containing the highest-signal patterns first; fall back
    // to natural page order. This keeps the prompt small but biased toward
    // the lines the audit (§2) flagged as load-bearing.
    const KEYWORDS = [
      /\bFILED\b/i,
      /\bSIGNED\b/i,
      /\bHonorable\b/i,
      /\bJudge\s+Presiding\b/i,
      /Movant'?s/i,
      /\/s\//,
      /\bCSR\b/i,
      /\bOn\s+the\s+\d+(?:st|nd|rd|th)?\s+day\s+of\b/i,
    ];
    const scored = results
      .map((r) => ({
        text: r.text || '',
        pageNumber: r.metadata.pageNumber ?? 0,
        chunkIndex: r.metadata.chunkIndex ?? 0,
        keywordHits: KEYWORDS.reduce((n, re) => n + (re.test(r.text || '') ? 1 : 0), 0),
        // The first two pages of a filing carry the caption + cover signature
        // (high-signal). Bias toward them.
        coverBias: (r.metadata.pageNumber ?? 99) <= 2 ? 1 : 0,
      }))
      .filter((r) => r.text.trim().length > 0);

    scored.sort((a, b) => {
      const sa = a.keywordHits + a.coverBias;
      const sb = b.keywordHits + b.coverBias;
      if (sb !== sa) return sb - sa;
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      return a.chunkIndex - b.chunkIndex;
    });

    const picked: ChunkExcerpt[] = [];
    let total = 0;
    for (const r of scored) {
      if (picked.length >= maxChunks) break;
      if (total + r.text.length > maxChars && picked.length > 0) break;
      picked.push({ text: r.text, pageNumber: r.pageNumber, chunkIndex: r.chunkIndex });
      total += r.text.length;
    }
    // Re-sort the chosen ones by page order so the prompt reads naturally.
    picked.sort((a, b) => a.pageNumber - b.pageNumber || a.chunkIndex - b.chunkIndex);
    return picked;
  } catch {
    return [];
  }
}

// ─── Public: build the LLM prompt ────────────────────────────────────────────

/**
 * The actual prompt sent to the model. Returned as `{system, user}` so the
 * caller can plug it into completeAI without rebuilding the structure.
 */
export function buildPrompt(args: {
  filingTitle: string;
  filingType: string;
  chunks: ChunkExcerpt[];
}): { system: string; user: string } {
  const system =
    `You are extracting structured metadata from a single legal filing's ` +
    `indexed text excerpts. Output STRICT JSON only — no markdown, no prose. ` +
    `For each field, include a value ONLY if you can back it with a quote from ` +
    `the excerpts. When in doubt, return null. Names must be the full natural ` +
    `name as written ("KEVIN D. HENDERSON", "James A. Vaught"), never roles ` +
    `like "THE COURT" or "PRESIDING JUDGE".\n\n` +
    `JSON schema:\n` +
    `{\n` +
    `  "filedOn":   "YYYY-MM-DD" | null,    // clerk file-stamp date if visible\n` +
    `  "receivedOn":"YYYY-MM-DD" | null,    // separate "received" date if any\n` +
    `  "judge":     { "name": "...", "confidence": "high"|"medium"|"low", "evidenceQuote": "..." } | null,\n` +
    `  "movant":    { "name": "...", "evidenceQuote": "..." } | null,\n` +
    `  "respondent":{ "name": "...", "evidenceQuote": "..." } | null,\n` +
    `  "reporter":  { "name": "...", "csrNumber": "...", "evidenceQuote": "..." } | null\n` +
    `}\n` +
    `\nRefuse to guess. If two pieces of evidence conflict, prefer the cover/caption.`;

  const numbered = args.chunks
    .map((c, i) => `[${i + 1}] (p.${c.pageNumber})\n${c.text}`)
    .join('\n\n---\n\n');

  const user =
    `Filing type: ${args.filingType}\n` +
    `Filing title: ${args.filingTitle}\n\n` +
    `Excerpts:\n${numbered || '(no excerpts available)'}\n\n` +
    `Return the JSON object now.`;

  return { system, user };
}

// ─── Public: model selection + invocation with optional fallback ─────────────

export interface ModelSelection {
  provider: AIProviderKey;
  model: string;
}

export function pickPrimary(config: AppConfig): ModelSelection | null {
  if (!config.aiPrimaryProvider || !config.aiPrimaryModel) return null;
  return {
    provider: config.aiPrimaryProvider as AIProviderKey,
    model: config.aiPrimaryModel,
  };
}

export function pickFallback(config: AppConfig): ModelSelection | null {
  if (!config.aiFallbackEnabled) return null;
  if (!config.aiFallbackProvider || !config.aiFallbackModel) return null;
  return {
    provider: config.aiFallbackProvider as AIProviderKey,
    model: config.aiFallbackModel,
  };
}

/**
 * Call the configured AI model for one filing, parse JSON, retry once with
 * the configured fallback if the primary is Ollama and fails. Returns
 * `null` on any failure (caller skips the filing).
 */
export async function extractFields(
  primary: ModelSelection,
  fallback: ModelSelection | null,
  prompt: { system: string; user: string },
): Promise<{ data: ExtractedFields; modelUsed: string } | null> {
  const attempts: ModelSelection[] = [primary];
  // Spec: "If primary is Ollama (local) and fails, fall back to cloud only
  // when fallbackEnabled is true." — single retry, only when primary is ollama.
  if (primary.provider === 'ollama' && fallback) attempts.push(fallback);

  let lastError: unknown = null;
  for (const sel of attempts) {
    try {
      const messages: AIMessage[] = [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ];
      const response = await completeAI({
        provider: sel.provider,
        model: sel.model,
        messages,
        // The schema below has 6 top-level fields, each up to ~150 tokens of
        // payload (name + evidenceQuote). Qwen-class local models can emit
        // 800-1500 tokens of structured JSON. 1024 was clipping responses
        // mid-object → JSON parse failure → zero suggestions returned.
        maxTokens: 3072,
        temperature: 0.1,
        jsonMode: true,
        // Disable Qwen3's <think> mode — for structured extraction we want the
        // model to go straight to the JSON. With thinking enabled Qwen burns
        // the entire token budget inside <think>...</think>, then the strip
        // regex leaves us with an empty string (the closing tag never arrived).
        thinking: false,
        jsonSchema: {
          type: 'object',
          properties: {
            filedOn: { type: ['string', 'null'] },
            receivedOn: { type: ['string', 'null'] },
            judge: {
              type: ['object', 'null'],
              properties: {
                name: { type: 'string' },
                confidence: { type: 'string' },
                evidenceQuote: { type: 'string' },
              },
            },
            movant: {
              type: ['object', 'null'],
              properties: { name: { type: 'string' }, evidenceQuote: { type: 'string' } },
            },
            respondent: {
              type: ['object', 'null'],
              properties: { name: { type: 'string' }, evidenceQuote: { type: 'string' } },
            },
            reporter: {
              type: ['object', 'null'],
              properties: {
                name: { type: 'string' },
                csrNumber: { type: 'string' },
                evidenceQuote: { type: 'string' },
              },
            },
          },
        },
      });
      const parsed = parseJsonLoose(response.content);
      if (parsed) {
        const present = Object.entries(parsed)
          .filter(([, v]) => v != null)
          .map(([k]) => k);
        console.log(`[tag-fill] extractFields ok — model=${sel.provider}:${sel.model} extracted=[${present.join(',')}]`);
        return { data: parsed, modelUsed: `${sel.provider}:${sel.model}` };
      }
      lastError = new Error('non-json response');
      console.warn(
        `[tag-fill] non-json response (provider=${sel.provider} model=${sel.model}) — first 240 chars: ${(response.content || '').slice(0, 240)}`,
      );
    } catch (err) {
      lastError = err;
      console.warn(
        `[tag-fill] extractFields throw (provider=${sel.provider} model=${sel.model}): ${err instanceof Error ? err.message : String(err)}`,
      );
      // continue to fallback if applicable
    }
  }
  console.warn(
    `[tag-fill] extractFields gave up — lastError=${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
  return null;
}

function parseJsonLoose(raw: string): ExtractedFields | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* fall through */ }
  // Greedy brace match
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    if (depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// ─── Public: Person resolution (lookup, else upsert) ─────────────────────────

const NAME_BLACKLIST = new Set([
  'the court', 'presiding judge', 'judge presiding', 'judge', 'movant',
  'respondent', 'petitioner', 'plaintiff', 'defendant', 'court', 'clerk',
  'court reporter', 'pro se', 'the honorable',
]);

export function isLikelyValidName(raw: string | undefined | null): boolean {
  if (!raw || typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (trimmed.length < 3 || trimmed.length > 120) return false;
  const lower = trimmed.toLowerCase().replace(/[.,]/g, '').trim();
  if (NAME_BLACKLIST.has(lower)) return false;
  // Require at least two whitespace-separated tokens with letters.
  const tokens = trimmed.split(/\s+/).filter((t) => /[A-Za-z]/.test(t));
  if (tokens.length < 2) return false;
  // /s/ initials-only ("/s/ A.B.") get filtered out — token must include
  // at least two letters somewhere.
  const lettersTotal = trimmed.replace(/[^A-Za-z]/g, '').length;
  if (lettersTotal < 4) return false;
  return true;
}

export type PersonMarker = 'judge' | 'courtReporter' | null;

export async function resolveOrCreatePerson(
  name: string,
  marker: PersonMarker,
): Promise<{ id: string; displayName: string; created: boolean } | null> {
  if (!isLikelyValidName(name)) return null;
  const cleanName = name.trim();

  // Case-insensitive substring match — prefer rows that already carry the
  // expected intrinsic marker.
  const allCandidates: Array<{ id: string; displayName: string; tags: any }> =
    await (prisma as any).person.findMany({
      where: { displayName: { contains: cleanName.split(/\s+/)[0] } },
      take: 25,
    });

  const lowerName = cleanName.toLowerCase();
  const ranked = allCandidates
    .map((p) => {
      const tags = (p.tags ?? {}) as Record<string, unknown>;
      const dn = (p.displayName ?? '').toLowerCase();
      let score = 0;
      if (dn === lowerName) score += 100;
      else if (dn.includes(lowerName) || lowerName.includes(dn)) score += 40;
      if (marker && tags[marker] === true) score += 20;
      return { p, score };
    })
    .filter((r) => r.score >= 40)
    .sort((a, b) => b.score - a.score);

  if (ranked.length > 0) {
    return { id: ranked[0].p.id, displayName: ranked[0].p.displayName, created: false };
  }

  // No match — upsert. Markers per audit §2.7 / brief §3e:
  //   judge   → { person: true, judge: true }
  //   reporter→ { person: true, courtReporter: true }
  //   else    → { person: true }   (movant / respondent are contextual)
  const tags: Record<string, boolean> = { person: true };
  if (marker === 'judge') tags.judge = true;
  if (marker === 'courtReporter') tags.courtReporter = true;

  try {
    const created = await (prisma as any).person.create({
      data: { displayName: cleanName, tags },
    });
    return { id: created.id, displayName: created.displayName, created: true };
  } catch (err) {
    console.warn(
      `[tag-fill] Person upsert failed name=${JSON.stringify(cleanName)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

// ─── Public: read current value for a target field (column + tags merge) ────

/**
 * Returns the row's effective value for `field`, checking both the explicit
 * column (e.g. Motion.judgeId) and the tags JSON (e.g. tags.judgeRef). Used
 * to suppress no-op suggestions per advisor guidance.
 */
export function readCurrentValue(
  row: Record<string, unknown> | null,
  field: HaystackTagField,
): unknown {
  if (!row) return null;
  const tags = (row.tags ?? {}) as Record<string, unknown>;

  // Column-side aliases for the *Ref fields.
  const COLUMN_ALIASES: Partial<Record<HaystackTagField, string[]>> = {
    judgeRef: ['judgeId'],
    movantRef: ['movantId'],
    respondentRef: ['respondentId'],
    reporterRef: ['reporterId'],
    fileRef: ['documentId'],
    filedOn: ['filedOn'],
    receivedOn: [],
  };

  const aliases = COLUMN_ALIASES[field] ?? [];
  for (const col of aliases) {
    const v = row[col];
    if (v != null && v !== '') return v;
  }
  const tagVal = tags[field];
  if (tagVal != null) return tagVal;
  return null;
}

/** Cheap structural equality for ref-or-date proposals. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  // Ref shape comparison
  if (typeof a === 'object' && typeof b === 'object') {
    const ar = (a as any).val ?? (a as any).id;
    const br = (b as any).val ?? (b as any).id;
    if (ar && br && String(ar) === String(br)) return true;
  }
  // Date string normalisation (ISO prefix)
  if (typeof a === 'string' && typeof b === 'string') {
    if (a.slice(0, 10) === b.slice(0, 10)) return true;
  }
  // Column value (raw id) vs ref payload
  if (typeof a === 'string' && typeof b === 'object') {
    const br = (b as any).val ?? (b as any).id;
    if (br && String(br) === a) return true;
  }
  if (typeof b === 'string' && typeof a === 'object') {
    const ar = (a as any).val ?? (a as any).id;
    if (ar && String(ar) === b) return true;
  }
  return false;
}

// ─── Public: pick the best supporting excerpt for a value ────────────────────

export function pickExcerpt(
  chunks: ChunkExcerpt[],
  needle: string | null | undefined,
): string | undefined {
  if (!needle || chunks.length === 0) return chunks[0]?.text.slice(0, 280);
  const n = needle.trim().toLowerCase();
  for (const c of chunks) {
    if ((c.text ?? '').toLowerCase().includes(n)) {
      return c.text.slice(0, 280);
    }
  }
  return chunks[0]?.text.slice(0, 280);
}

// ─── Public: date string sanity ──────────────────────────────────────────────

export function normalizeIsoDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Already ISO YYYY-MM-DD
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
    if (!isNaN(dt.getTime())) return `${y}-${m}-${d}`;
  }
  // M/D/YYYY tolerance
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const m = us[1].padStart(2, '0');
    const d = us[2].padStart(2, '0');
    return `${us[3]}-${m}-${d}`;
  }
  return null;
}
