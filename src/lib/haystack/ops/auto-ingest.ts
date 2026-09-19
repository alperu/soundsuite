/**
 * `ssAutoIngestPlan` / `ssAutoIngestApply` — model-driven auto-ingestion of a
 * folder (docs/PLAN-haystack-mcp-agentic-etl.md §5, and the operator's
 * follow-up: "give a path, look into the PDFs, suggest what to ingest and how
 * to map it, clean the folder up into folders").
 *
 * Two ops, one contract, copied from the tag-fill pipeline (§7.3):
 *
 *   PLAN   reads the folder and the first pages of each PDF, asks the model
 *          (OpenRouter, default deepseek/deepseek-v4.1-flash) for the case
 *          identity and a per-file classification, and runs the deterministic
 *          regex detector beside it. It writes nothing and moves nothing. The
 *          result carries evidence (the excerpt each verdict came from), a
 *          coarse confidence, and — where it disagrees with the detector — both
 *          answers, so a reviewer can argue with it.
 *
 *   APPLY  takes the plan back, as reviewed, and never re-runs the model. What
 *          was reviewed is exactly what is written. Each step is idempotent:
 *          the Case is found or created, a file already in its target folder
 *          is not moved, a Filing with the same slug is reused, entity rows go
 *          through `ensure-filing`, a Document known by hash is attached rather
 *          than duplicated, and a link is written only when its target resolved
 *          to a filing in this run.
 *
 * What the model is NOT asked to do: decide anything about a draft (§7.5 —
 * detection stays with the conservative detector at ingestion), touch a file
 * outside the folder, or delete anything.
 */
import path from 'path';
import fs from 'fs/promises';
import { callLLMJson } from '@/lib/mcp/tools/ai-helper';
import type { ToolExecutionContext } from '@/lib/mcp/tool-types';
import { detectFiling, quickExtractHeader, FILING_TYPES } from '@/services/filing-detector';
import { classifyFilingEntityKind } from '@/lib/filings/classify-entity-kind';
import { commitEntity } from '@/lib/haystack/commit';
import {
  ensureClerksRecordForFiling,
  ensureMotionAttachmentForFiling,
  ensureMotionForFiling,
  ensureReportersRecordForFiling,
} from '@/lib/haystack/ensure-filing';
import { OpError, provenanceTag, type OpContext, type OpResult } from './types';
import { assertDirectory, sha256File, walkPdfs, type WalkedFile } from './fs-walk';

export const DEFAULT_AUTO_INGEST_MODEL = 'deepseek/deepseek-v4.1-flash';
const AUTO_INGEST_PROVIDER = 'openrouter';
/**
 * Only the first two pages reach the model. The caption block, the clerk's
 * file stamp (top or margin of page 1) and, for short filings, the signature
 * block are all there; page three onward is argument the planner has no use
 * for and would pay for on every file.
 */
export const AUTO_INGEST_PAGES = 2;

export type Confidence = 'high' | 'medium' | 'low';

export interface PlannedCase {
  /** A Case already registered at exactly this path, if any. */
  existingCaseId: string | null;
  name: string;
  caseNumber: string | null;
  court: string | null;
  parties: string[];
  county: string | null;
  state: string | null;
  confidence: Confidence;
  evidence: string;
  /** Cause numbers the sampled files disagreed on. Non-empty means the folder
   *  may hold more than one case; the plan reports it rather than picking. */
  disagreement: Array<{ caseNumber: string; files: string[] }>;
}

export interface PlannedFile {
  path: string;
  name: string;
  relDir: string;
  size: number;
  hash: string | null;
  existing: { documentId: string; status: string; filingId: string | null; caseId: string } | null;
  /** The deterministic regex tier's answer, for comparison. */
  detector: { filingType: string; title: string; confidence: number };
  /** Canonical filing type string (one of FILING_TYPES). */
  filingType: string;
  /** Tag-panel entity kind derived from `filingType`. */
  kind: string;
  title: string;
  /** WHEN: the clerk's file stamp date (e-file "Filed" line, "FILED … District
   *  Clerk", "Envelope No." block), else null. Never the signature date. */
  filedOn: string | null;
  /** The date in the signature block, when different from the file stamp. */
  signedOn: string | null;
  /** WHO, by role: which side filed it — as printed in the caption or the
   *  signature block ("Attorney for Respondent"), or `court` for an order. */
  filedBy: 'plaintiff' | 'defendant' | 'petitioner' | 'respondent' | 'movant' | 'court' | 'third-party' | 'unknown';
  /** WHO, by name: the attorney, party or judge who signed, as printed. */
  author: string | null;
  /** The verbatim stamp text the dates came from, so the reviewer can check. */
  stampEvidence: string | null;
  confidence: Confidence;
  evidence: string;
  /** True when the model and the detector named different filing types. */
  disagreesWithDetector: boolean;
  /** For a response / reply / order: the motion it answers, as the model
   *  named it, and the file in this plan it resolved to (or null). */
  answersTitle: string | null;
  answersPath: string | null;
  /** Proposed subfolder relative to the case root. */
  targetDir: string;
  /** Reviewer switch. Apply skips rows with `accepted: false`. */
  accepted: boolean;
  /** Why the model could not read this file, when it could not. */
  readError?: string;
}

export interface AutoIngestPlan {
  version: 1;
  createdAt: string;
  model: string;
  path: string;
  case: PlannedCase;
  files: PlannedFile[];
  /** PDFs found but not read because of `maxFiles`. Surveyed, not planned. */
  unplanned: Array<{ path: string; name: string }>;
  warnings: string[];
}

// ── folder layout ────────────────────────────────────────────────────────────

/** Where each filing type goes when the folder is tidied. */
export function targetDirFor(filingType: string): string {
  switch (filingType) {
    case 'Motion': return 'Motions';
    case 'Notice': return 'Notices';
    case 'Response': return 'Responses';
    case 'Reply': return 'Replies';
    case 'Order': case 'Judgment': case 'Decree': return 'Orders';
    case "Clerk's Record": case "Reporter's Record": case 'Transcript': return 'Records';
    case 'Petition': return 'Petitions';
    case 'Brief': return 'Briefs';
    case 'Affidavit': case 'Subpoena': case 'Return of Service': return 'Service and Affidavits';
    case 'Letter': case 'Demand Letter': return 'Correspondence';
    default: return 'Other';
  }
}

// ── model I/O ────────────────────────────────────────────────────────────────

const CANONICAL_TYPES = new Set<string>(FILING_TYPES);

function asConfidence(v: unknown): Confidence {
  return v === 'high' || v === 'medium' || v === 'low' ? v : 'low';
}
function asText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
function asYmd(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function canonicalType(v: unknown): string {
  const raw = asText(v, 40);
  if (CANONICAL_TYPES.has(raw)) return raw;
  const lc = raw.toLowerCase().replace(/[’']/g, "'");
  for (const t of FILING_TYPES) if (t.toLowerCase() === lc) return t;
  return 'Other';
}

const CASE_SYSTEM =
  'You read the caption block of court filings. Given excerpts from several PDFs in one folder, ' +
  'identify the case they belong to. Answer ONLY with JSON: {"caseNumber": string|null, ' +
  '"court": string|null, "parties": string[], "caseName": string|null, "county": string|null, ' +
  '"state": string|null, "confidence": "high"|"medium"|"low", "evidence": string, ' +
  '"perFile": [{"file": string, "caseNumber": string|null}]}. `evidence` is a short verbatim ' +
  'quote of the caption you relied on. If the files carry different cause numbers, list each ' +
  'in perFile exactly as printed and do not pick one. Never invent a number that is not in the text.';

const FILED_BY = ['plaintiff', 'defendant', 'petitioner', 'respondent', 'movant', 'court', 'third-party', 'unknown'] as const;

const CLASSIFY_SYSTEM =
  'You read the FIRST TWO PAGES of court filings and answer three questions per file: WHAT it is, ' +
  'WHO filed it, WHEN it was filed. For each item answer with one object: ' +
  '{"index": number, ' +
  '"filingType": one of the allowed types exactly as written, ' +
  '"title": a clean document title as it would appear on a docket (no cause number, no file suffixes), ' +
  '"filedBy": one of plaintiff|defendant|petitioner|respondent|movant|court|third-party|unknown — the SIDE that ' +
  'filed it, read from the caption ("Respondent\'s Motion…") or the signature block ("Attorney for Petitioner"); ' +
  'an order, judgment or decree signed by a judge is "court", ' +
  '"author": the attorney, party or judge who signed it, as printed, or null, ' +
  '"filedOn": "YYYY-MM-DD" from the CLERK\'S FILE STAMP — an e-filing header ("Filed: 1/2/2026 3:04 PM", ' +
  '"Envelope No.", "Accepted by"), or a stamp like "FILED … District Clerk" — or null when no stamp is present; ' +
  'never use the signature date here, ' +
  '"signedOn": "YYYY-MM-DD" from the signature block or null, ' +
  '"stampEvidence": the verbatim stamp or header line the dates came from, or null, ' +
  '"confidence": "high"|"medium"|"low", ' +
  '"evidence": a short verbatim quote that supports filingType, ' +
  '"answersTitle": for a Response, Reply, Objection, Order, Judgment or Decree the title of the motion it ' +
  'answers or rules on as printed, else null}. ' +
  'Respond ONLY with JSON: {"items": [...]}. Allowed types: ' + FILING_TYPES.join(' | ') + '. Use "Other" when unsure. ' +
  'Never invent a date, a name or a number that is not in the text.';

interface CaseIdentityAnswer {
  caseNumber?: unknown; court?: unknown; parties?: unknown; caseName?: unknown;
  county?: unknown; state?: unknown; confidence?: unknown; evidence?: unknown;
  perFile?: Array<{ file?: unknown; caseNumber?: unknown }>;
}
interface ClassifyAnswer {
  items?: Array<{
    index?: unknown; filingType?: unknown; title?: unknown; filedOn?: unknown; signedOn?: unknown;
    filedBy?: unknown; author?: unknown; stampEvidence?: unknown;
    confidence?: unknown; evidence?: unknown; answersTitle?: unknown;
  }>;
}

function asFiledBy(v: unknown): PlannedFile['filedBy'] {
  const s = asText(v, 20).toLowerCase();
  return (FILED_BY as readonly string[]).includes(s) ? (s as PlannedFile['filedBy']) : 'unknown';
}

interface Extracted {
  file: WalkedFile;
  excerpt: string;
  readError?: string;
  detector: PlannedFile['detector'];
}

async function extractOne(file: WalkedFile, excerptChars: number): Promise<Extracted> {
  let excerpt = '';
  let readError: string | undefined;
  try {
    excerpt = (await quickExtractHeader(file.path, AUTO_INGEST_PAGES)).replace(/\s+/g, ' ').trim().slice(0, excerptChars);
    if (!excerpt) readError = 'no extractable text on the first two pages (scanned? OCR runs at ingestion)';
  } catch (err) {
    readError = `could not read PDF: ${(err as Error).message}`;
  }
  let detector: PlannedFile['detector'] = { filingType: 'Other', title: file.name.replace(/\.pdf$/i, ''), confidence: 0 };
  try {
    const d = await detectFiling(file.path);
    detector = { filingType: d.filingType, title: d.title, confidence: d.confidence };
  } catch { /* the detector is a comparison, not a requirement */ }
  return { file, excerpt, readError, detector };
}

async function identifyCase(
  sample: Extracted[],
  llm: { model: string; context?: ToolExecutionContext },
): Promise<Omit<PlannedCase, 'existingCaseId' | 'name'> & { caseName: string | null }> {
  const usable = sample.filter((s) => s.excerpt);
  if (usable.length === 0) {
    return {
      caseName: null, caseNumber: null, court: null, parties: [], county: null, state: null,
      confidence: 'low', evidence: '', disagreement: [],
    };
  }
  const user = usable
    .map((s, i) => `### File ${i + 1}: ${s.file.name}\n${s.excerpt.slice(0, 1200)}`)
    .join('\n\n');
  const answer = await callLLMJson<CaseIdentityAnswer>(CASE_SYSTEM, user, {
    provider: AUTO_INGEST_PROVIDER, model: llm.model, temperature: 0, maxTokens: 1200, context: llm.context,
  });

  const perFile = Array.isArray(answer.perFile) ? answer.perFile : [];
  const byNumber = new Map<string, string[]>();
  for (const p of perFile) {
    const n = asText(p?.caseNumber, 60);
    if (!n) continue;
    const list = byNumber.get(n) ?? [];
    list.push(asText(p?.file, 200));
    byNumber.set(n, list);
  }
  const disagreement = byNumber.size > 1
    ? [...byNumber.entries()].map(([caseNumber, files]) => ({ caseNumber, files }))
    : [];

  return {
    caseName: asText(answer.caseName, 200) || null,
    caseNumber: asText(answer.caseNumber, 60) || null,
    court: asText(answer.court, 200) || null,
    parties: Array.isArray(answer.parties) ? answer.parties.map((p) => asText(p, 120)).filter(Boolean).slice(0, 12) : [],
    county: asText(answer.county, 80) || null,
    state: asText(answer.state, 80) || null,
    confidence: disagreement.length ? 'low' : asConfidence(answer.confidence),
    evidence: asText(answer.evidence, 400),
    disagreement,
  };
}

async function classifyBatch(
  batch: Extracted[],
  llm: { model: string; context?: ToolExecutionContext },
): Promise<Map<number, ClassifyAnswer['items'] extends (infer T)[] | undefined ? T : never>> {
  const user = batch
    .map((s, i) =>
      `### Item ${i}\nfile: ${s.file.name}\nfolder: ${s.file.relDir || '(root)'}\n` +
      `detector guess: ${s.detector.filingType} (${Math.round(s.detector.confidence * 100)}%) — "${s.detector.title}"\n` +
      `text: ${s.excerpt || '(none)'}`,
    )
    .join('\n\n');
  const answer = await callLLMJson<ClassifyAnswer>(CLASSIFY_SYSTEM, user, {
    provider: AUTO_INGEST_PROVIDER, model: llm.model, temperature: 0, maxTokens: 400 * batch.length + 200, context: llm.context,
  });
  const out = new Map<number, NonNullable<ClassifyAnswer['items']>[number]>();
  for (const item of Array.isArray(answer.items) ? answer.items : []) {
    const idx = typeof item?.index === 'number' ? item.index : Number(item?.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < batch.length) out.set(idx, item);
  }
  return out;
}

// ── link resolution (deterministic, title overlap) ───────────────────────────

const STOP = new Set(['motion', 'to', 'the', 'of', 'for', 'and', 'in', 'on', 'a', 'an', 'order', 'response', 'reply', 'notice', 'request', 'court', 'plaintiff', 'defendant', 'petitioner', 'respondent', 're', 'no', 'case', 'cause', 'filed', 'amended', 'first', 'second', 'third']);
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
/** Best motion in the plan for a title the model named, or null on a tie. */
export function resolveAnswerTarget(answersTitle: string, motions: Array<{ path: string; title: string }>): string | null {
  const want = tokens(answersTitle);
  if (want.size === 0) return null;
  const scored = motions
    .map((m) => {
      const have = tokens(m.title);
      let shared = 0;
      for (const w of want) if (have.has(w)) shared += 1;
      return { path: m.path, score: shared / Math.max(1, want.size) };
    })
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.2) return null;
  return scored[0].path;
}

const ANSWERING_TYPES = new Set(['Response', 'Reply', 'Objection', 'Order', 'Judgment', 'Decree']);

// ── PLAN ─────────────────────────────────────────────────────────────────────

export interface AutoIngestPlanParams {
  path: string;
  model?: string;
  maxFiles?: number;
  sampleForCase?: number;
  excerptChars?: number;
}

export async function ssAutoIngestPlan(
  ctx: OpContext,
  params: AutoIngestPlanParams,
  llmContext?: ToolExecutionContext,
): Promise<OpResult> {
  let root: string;
  try {
    root = await assertDirectory(String(params.path ?? ''));
  } catch (err) {
    throw new OpError('INVALID_PARAMS', (err as Error).message);
  }
  const model = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : DEFAULT_AUTO_INGEST_MODEL;
  const maxFiles = Math.min(400, Math.max(1, Math.floor(params.maxFiles ?? 60)));
  const sampleN = Math.min(10, Math.max(1, Math.floor(params.sampleForCase ?? 5)));
  const excerptChars = Math.min(6000, Math.max(300, Math.floor(params.excerptChars ?? 1500)));
  const llm = { model, context: llmContext };
  const warnings: string[] = [];

  const all = await walkPdfs(root);
  const planned = all.slice(0, maxFiles);
  const unplanned = all.slice(maxFiles).map((f) => ({ path: f.path, name: f.name }));
  if (unplanned.length) warnings.push(`${unplanned.length} PDF(s) beyond maxFiles=${maxFiles} were surveyed but not read; raise maxFiles or run again after applying.`);

  // What the database already knows, by path and by hash.
  const [existingCase, byPath] = await Promise.all([
    ctx.prisma.case.findUnique({ where: { path: root }, select: { id: true, name: true, caseNumber: true } }),
    ctx.prisma.document.findMany({
      where: { filePath: { in: planned.map((f) => f.path) } },
      select: { id: true, filePath: true, hash: true, status: true, filingId: true, caseId: true },
    }),
  ]);
  const docByPath = new Map(byPath.map((d) => [d.filePath, d]));
  const hashes = new Map<string, string>();
  for (const f of planned) {
    const known = docByPath.get(f.path);
    if (known) { hashes.set(f.path, known.hash); continue; }
    try { hashes.set(f.path, await sha256File(f.path)); } catch { /* reported below */ }
  }
  const unknownHashes = [...planned].filter((f) => !docByPath.has(f.path)).map((f) => hashes.get(f.path)).filter((h): h is string => !!h);
  const byHash = unknownHashes.length
    ? await ctx.prisma.document.findMany({ where: { hash: { in: unknownHashes } }, select: { id: true, filePath: true, hash: true, status: true, filingId: true, caseId: true } })
    : [];
  const docByHash = new Map(byHash.map((d) => [d.hash, d]));

  // Read every planned file once.
  const extracted: Extracted[] = [];
  for (const f of planned) extracted.push(await extractOne(f, excerptChars));
  const unreadable = extracted.filter((e) => e.readError).length;
  if (unreadable) warnings.push(`${unreadable} file(s) had no readable first-page text; their classification rests on filename and folder only.`);

  // 1. Case identity from a sample: prefer files with text, spread across folders.
  const sample = extracted.filter((e) => e.excerpt).slice(0, sampleN);
  const identity = await identifyCase(sample, llm);
  if (identity.disagreement.length) {
    warnings.push(`Sampled files carry ${identity.disagreement.length} different cause numbers — this folder may hold more than one case. Nothing was chosen; review case.disagreement.`);
  }
  if (!identity.caseNumber) warnings.push('No cause number could be read from the sampled captions; the case would be created without one.');

  // 2. Per-file classification in batches.
  const classified = new Map<string, NonNullable<ClassifyAnswer['items']>[number]>();
  const BATCH = 8;
  for (let i = 0; i < extracted.length; i += BATCH) {
    const batch = extracted.slice(i, i + BATCH);
    try {
      const answers = await classifyBatch(batch, llm);
      answers.forEach((item, idx) => classified.set(batch[idx].file.path, item));
    } catch (err) {
      warnings.push(`Classification batch ${i / BATCH + 1} failed (${(err as Error).message}); those files fall back to the detector.`);
    }
  }

  const files: PlannedFile[] = extracted.map((e) => {
    const item = classified.get(e.file.path);
    const filingType = item ? canonicalType(item.filingType) : e.detector.filingType;
    const title = item ? asText(item.title, 200) || e.detector.title : e.detector.title;
    const existing = docByPath.get(e.file.path) ?? (hashes.get(e.file.path) ? docByHash.get(hashes.get(e.file.path)!) : undefined);
    const answersTitle = item && ANSWERING_TYPES.has(filingType) ? asText(item.answersTitle, 200) || null : null;
    return {
      path: e.file.path,
      name: e.file.name,
      relDir: e.file.relDir,
      size: e.file.size,
      hash: hashes.get(e.file.path) ?? null,
      existing: existing ? { documentId: existing.id, status: existing.status, filingId: existing.filingId, caseId: existing.caseId } : null,
      detector: e.detector,
      filingType,
      kind: classifyFilingEntityKind(filingType).entityKind,
      title,
      filedOn: item ? asYmd(item.filedOn) : null,
      signedOn: item ? asYmd(item.signedOn) : null,
      filedBy: item ? asFiledBy(item.filedBy) : 'unknown',
      author: item ? asText(item.author, 120) || null : null,
      stampEvidence: item ? asText(item.stampEvidence, 240) || null : null,
      confidence: item ? asConfidence(item.confidence) : (e.detector.confidence >= 0.75 ? 'medium' : 'low'),
      evidence: item ? asText(item.evidence, 300) : (e.detector.confidence > 0 ? 'regex detector on filename/header' : ''),
      disagreesWithDetector: !!item && filingType !== e.detector.filingType,
      answersTitle,
      answersPath: null,
      targetDir: targetDirFor(filingType),
      accepted: true,
      ...(e.readError ? { readError: e.readError } : {}),
    };
  });

  // 3. Resolve "answers" to a motion in this plan, deterministically.
  const motions = files.filter((f) => f.filingType === 'Motion').map((f) => ({ path: f.path, title: f.title }));
  for (const f of files) {
    if (!f.answersTitle) continue;
    f.answersPath = resolveAnswerTarget(f.answersTitle, motions);
  }

  const lowConfidence = files.filter((f) => f.confidence === 'low').length;
  if (lowConfidence) warnings.push(`${lowConfidence} file(s) classified with low confidence — review before applying.`);
  const noStamp = files.filter((f) => !f.readError && !f.filedOn).length;
  if (noStamp) warnings.push(`${noStamp} file(s) carry no clerk's file stamp on the first two pages; filedOn is null for them (a signature date is NOT a filing date).`);
  const disagreements = files.filter((f) => f.disagreesWithDetector).length;

  const plan: AutoIngestPlan = {
    version: 1,
    createdAt: new Date().toISOString(),
    model,
    path: root,
    case: {
      existingCaseId: existingCase?.id ?? null,
      name: existingCase?.name ?? identity.caseName ?? path.basename(root),
      caseNumber: existingCase?.caseNumber ?? identity.caseNumber,
      court: identity.court,
      parties: identity.parties,
      county: identity.county,
      state: identity.state,
      confidence: identity.confidence,
      evidence: identity.evidence,
      disagreement: identity.disagreement,
    },
    files,
    unplanned,
    warnings,
  };

  const byType: Record<string, number> = {};
  for (const f of files) byType[f.filingType] = (byType[f.filingType] ?? 0) + 1;

  return {
    meta: {
      path: root,
      model,
      existingCase: existingCase?.id ?? null,
      caseNumber: plan.case.caseNumber,
      caseConfidence: plan.case.confidence,
      filesOnDisk: all.length,
      planned: files.length,
      unplanned: unplanned.length,
      alreadyInDatabase: files.filter((f) => f.existing).length,
      lowConfidence,
      disagreesWithDetector: disagreements,
      linksResolved: files.filter((f) => f.answersPath).length,
      linksUnresolved: files.filter((f) => f.answersTitle && !f.answersPath).length,
      withFileStamp: files.filter((f) => f.filedOn).length,
      pagesRead: AUTO_INGEST_PAGES,
      byType,
      byFiledBy: files.reduce<Record<string, number>>((acc, f) => { acc[f.filedBy] = (acc[f.filedBy] ?? 0) + 1; return acc; }, {}),
      warnings,
      note: 'Nothing was written or moved. Review rows[0].plan (set accepted:false on any file, edit titles/types) and pass it to ssAutoIngestApply.',
    },
    rows: [{ plan }],
  };
}

// ── APPLY ────────────────────────────────────────────────────────────────────

export interface AutoIngestApplyParams {
  plan: AutoIngestPlan;
  organize?: boolean;
  queue?: boolean;
  dryRun?: boolean;
}

interface ApplyRow {
  path: string;
  name: string;
  filingType: string;
  title: string;
  movedTo: string | null;
  filing: string | null;
  filingAction: 'found' | 'created' | 'would-create' | 'skipped';
  entity: string | null;
  document: string | null;
  documentAction: string;
  link: string | null;
  linkAction: string;
  warnings: string[];
}

function slugify(filingType: string, title: string): string {
  return `${filingType}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function validatePlan(raw: unknown): AutoIngestPlan {
  const p = raw as AutoIngestPlan;
  if (!p || typeof p !== 'object' || p.version !== 1 || typeof p.path !== 'string' || !Array.isArray(p.files) || !p.case) {
    throw new OpError('INVALID_PARAMS', 'plan must be the object returned by ssAutoIngestPlan (version 1, with path, case and files)');
  }
  for (const f of p.files) {
    if (typeof f?.path !== 'string' || typeof f?.filingType !== 'string' || typeof f?.title !== 'string') {
      throw new OpError('INVALID_PARAMS', `plan.files entry is missing path/filingType/title: ${JSON.stringify(f).slice(0, 120)}`);
    }
    if (!f.path.startsWith(p.path)) throw new OpError('INVALID_PARAMS', `plan file is outside the plan folder: ${f.path}`);
    if (!CANONICAL_TYPES.has(f.filingType)) throw new OpError('INVALID_PARAMS', `unknown filingType "${f.filingType}" for ${f.name}`);
  }
  return p;
}

/** Which ref slot a filing of this type writes toward the motion it answers. */
export function linkSlotFor(filingType: string): 'respondingTo' | 'replyingTo' | 'resolves' | 'motionRef' {
  if (filingType === 'Response' || filingType === 'Objection') return 'respondingTo';
  if (filingType === 'Reply') return 'replyingTo';
  if (filingType === 'Order' || filingType === 'Judgment' || filingType === 'Decree') return 'resolves';
  return 'motionRef';
}

export async function ssAutoIngestApply(ctx: OpContext, params: AutoIngestApplyParams): Promise<OpResult<ApplyRow>> {
  const plan = validatePlan(params.plan);
  const dryRun = params.dryRun !== false;
  const organize = params.organize === true;
  const queue = params.queue !== false;
  const prisma = ctx.prisma;
  const provenance = provenanceTag({ ...ctx.actor, model: plan.model }, 'ssAutoIngestApply');

  let root: string;
  try {
    root = await assertDirectory(plan.path);
  } catch (err) {
    throw new OpError('INVALID_PARAMS', (err as Error).message);
  }

  // Step 1 — the Case. Found by path, else created through the same commit the
  // plus button uses. The plan's identity fields become the row.
  let caseId = plan.case.existingCaseId;
  let caseAction: string;
  const existing = await prisma.case.findUnique({ where: { path: root }, select: { id: true } });
  if (existing) {
    caseId = existing.id;
    caseAction = 'found';
  } else if (dryRun) {
    caseAction = 'would-create';
  } else {
    const result = await commitEntity({
      id: null,
      kind: 'case',
      patch: {
        name: plan.case.name || path.basename(root),
        path: root,
        ...(plan.case.caseNumber ? { caseNumber: plan.case.caseNumber } : {}),
        ...(plan.case.court ? { jurisdiction: plan.case.court } : {}),
        ...(plan.case.county ? { county: plan.case.county } : {}),
        ...(plan.case.state ? { state: plan.case.state } : {}),
        ...provenance,
      },
    });
    if (!result.ok) {
      const parsed = JSON.parse(result.errGridJson) as { meta?: { dis?: string } };
      throw new OpError('EXECUTION_ERROR', `case create failed: ${parsed?.meta?.dis ?? 'unknown'}`);
    }
    caseId = String((result.row as { id: string }).id);
    caseAction = 'created';
  }

  const rows: ApplyRow[] = [];
  const filingByPath = new Map<string, string>();
  const accepted = plan.files.filter((f) => f.accepted !== false);
  const skipped = plan.files.length - accepted.length;

  // Step 2 — per file: move, filing, entity, document.
  for (const f of accepted) {
    const warnings: string[] = [];
    let currentPath = f.path;
    let movedTo: string | null = null;

    // 2a. Organise: move into the target subfolder unless already there.
    if (organize) {
      const destDir = path.join(root, f.targetDir || targetDirFor(f.filingType));
      const dest = path.join(destDir, f.name);
      if (path.dirname(currentPath) !== destDir) {
        let destTaken = false;
        try { await fs.access(dest); destTaken = true; } catch { /* free */ }
        if (destTaken) {
          warnings.push(`not moved: ${dest} already exists`);
        } else if (dryRun) {
          movedTo = dest;
        } else {
          try {
            await fs.mkdir(destDir, { recursive: true });
            await fs.rename(currentPath, dest);
            // Tell the database before the watcher does, so the row is a
            // rename and not a duplicate-then-orphan.
            await prisma.document.updateMany({ where: { filePath: currentPath }, data: { filePath: dest } });
            movedTo = dest;
            currentPath = dest;
          } catch (err) {
            warnings.push(`move failed: ${(err as Error).message}`);
          }
        }
      }
    }

    // 2b. Filing: slug-deduplicated within the case.
    let filingId: string | null = null;
    let filingAction: ApplyRow['filingAction'] = 'skipped';
    if (caseId) {
      const slug = slugify(f.filingType, f.title);
      const found = await prisma.filing.findUnique({ where: { caseId_slug: { caseId, slug } }, select: { id: true } });
      if (found) {
        filingId = found.id;
        filingAction = 'found';
      } else if (dryRun) {
        filingAction = 'would-create';
      } else {
        const created = await prisma.filing.create({
          data: {
            caseId,
            filingType: f.filingType,
            title: f.title,
            slug,
            filingDate: f.filedOn ? new Date(f.filedOn) : null,
          },
          select: { id: true },
        });
        filingId = created.id;
        filingAction = 'created';
      }
    } else {
      filingAction = 'would-create';
    }
    if (filingId) filingByPath.set(f.path, filingId);

    // 2c. Entity row through ensure-filing — never a raw create for the 22 kinds (§8.5).
    // Then the who/when the model read, as tags: `filedOn` / `signedOn` are
    // real spec slots (the tag-fill extractor writes the same two); the rest
    // goes under one namespaced `ssEtl` tag so no invented slot name can
    // collide with the vocabulary.
    let entity: string | null = null;
    if (filingId && !dryRun) {
      const { entityKind, attachmentKindHint } = classifyFilingEntityKind(f.filingType);
      try {
        if (entityKind === 'motion') { await ensureMotionForFiling(filingId); entity = 'motion'; }
        else if (entityKind === 'clerksRecord') { await ensureClerksRecordForFiling(filingId); entity = 'clerksRecord'; }
        else if (entityKind === 'reportersRecord') { await ensureReportersRecordForFiling(filingId); entity = 'reportersRecord'; }
        else { await ensureMotionAttachmentForFiling(filingId, attachmentKindHint ?? entityKind); entity = entityKind; }

        const tagPatch: Record<string, unknown> = {};
        if (f.filedOn) tagPatch.filedOn = f.filedOn;
        if (f.signedOn) tagPatch.signedOn = f.signedOn;
        const etl: Record<string, unknown> = {};
        if (f.filedBy && f.filedBy !== 'unknown') etl.filedBy = f.filedBy;
        if (f.author) etl.author = f.author;
        if (f.stampEvidence) etl.stampEvidence = f.stampEvidence;
        if (Object.keys(etl).length) tagPatch.ssEtl = etl;
        if (Object.keys(tagPatch).length) {
          const r = await commitEntity({ id: filingId, kind: entityKind, patch: { ...tagPatch, ...provenance } });
          if (!r.ok) warnings.push('who/when tags not written: ' + ((JSON.parse(r.errGridJson) as { meta?: { dis?: string } })?.meta?.dis ?? 'unknown'));
        }
      } catch (err) {
        warnings.push(`entity row not materialised: ${(err as Error).message}`);
      }
    } else if (filingId || filingAction === 'would-create') {
      entity = `would-ensure ${classifyFilingEntityKind(f.filingType).entityKind}`;
    }

    // 2d. Document: attach by hash (the watcher's key), else by path, else create.
    let documentId: string | null = null;
    let documentAction = 'skipped';
    let hash = f.hash;
    if (!hash) {
      try { hash = await sha256File(currentPath); } catch (err) { warnings.push(`unreadable: ${(err as Error).message}`); }
    }
    if (hash && caseId) {
      const doc =
        (await prisma.document.findUnique({ where: { hash }, select: { id: true, status: true, filingId: true, caseId: true, filePath: true } })) ??
        (await prisma.document.findUnique({ where: { filePath: currentPath }, select: { id: true, status: true, filingId: true, caseId: true, filePath: true } }));
      if (doc) {
        documentId = doc.id;
        const data: Record<string, unknown> = {};
        if (doc.caseId !== caseId) warnings.push(`document belongs to another case (${doc.caseId}); not re-homed`);
        else {
          if (!doc.filingId && filingId) data.filingId = filingId;
          else if (doc.filingId && filingId && doc.filingId !== filingId) warnings.push(`document already filed under ${doc.filingId}; filing not changed`);
          if (doc.filePath !== currentPath) data.filePath = currentPath;
          if (queue && doc.status === 'DISCOVERED') data.status = 'QUEUED';
          if (f.filingType) data.documentType = f.filingType;
        }
        const verbs = [
          data.filingId ? 'attach' : null,
          data.status ? 'queue' : null,
          data.filePath ? 'repath' : null,
        ].filter(Boolean);
        documentAction = verbs.length ? (dryRun ? `would-${verbs.join('+')}` : verbs.join('+')) : 'unchanged';
        if (!dryRun && Object.keys(data).length) await prisma.document.update({ where: { id: doc.id }, data });
      } else if (dryRun) {
        documentAction = queue ? 'would-create QUEUED' : 'would-create DISCOVERED';
      } else {
        const created = await prisma.document.create({
          data: {
            caseId,
            filingId,
            filePath: currentPath,
            fileName: f.name,
            hash,
            status: queue ? 'QUEUED' : 'DISCOVERED',
            documentType: f.filingType,
          },
          select: { id: true },
        });
        documentId = created.id;
        documentAction = queue ? 'created QUEUED' : 'created DISCOVERED';
      }
    } else if (dryRun && !caseId) {
      documentAction = queue ? 'would-create QUEUED' : 'would-create DISCOVERED';
    }

    rows.push({
      path: f.path, name: f.name, filingType: f.filingType, title: f.title, movedTo,
      filing: filingId, filingAction, entity, document: documentId, documentAction,
      link: null, linkAction: f.answersPath ? 'pending' : (f.answersTitle ? 'unresolved target' : 'none'),
      warnings,
    });
  }

  // Step 3 — links, only where the target resolved to a filing in this run.
  let linksWritten = 0;
  for (const row of rows) {
    const f = accepted.find((x) => x.path === row.path)!;
    if (!f.answersPath) continue;
    const targetFiling = filingByPath.get(f.answersPath);
    const sourceFiling = filingByPath.get(f.path);
    const slot = linkSlotFor(f.filingType);
    if (!targetFiling || !sourceFiling) {
      row.linkAction = dryRun ? `would-write ${slot} after filings exist` : 'target filing not created in this run';
      continue;
    }
    row.link = `${slot} → ${targetFiling}`;
    if (dryRun) { row.linkAction = `would-write ${slot}`; continue; }
    const kind = classifyFilingEntityKind(f.filingType).entityKind;
    // A ref tag with an FK column must write the column too, or the graph is
    // true only in JSON (§8.5). Only motionRef has one on an attachment.
    const patch: Record<string, unknown> = { [slot]: targetFiling, ...provenance };
    if (slot === 'motionRef' && kind !== 'motion') patch.motionId = targetFiling;
    const result = await commitEntity({ id: sourceFiling, kind, patch });
    if (result.ok) { row.linkAction = `wrote ${slot}`; linksWritten += 1; }
    else {
      const parsed = JSON.parse(result.errGridJson) as { meta?: { dis?: string } };
      row.linkAction = `link failed: ${parsed?.meta?.dis ?? 'unknown'}`;
    }
  }

  return {
    meta: {
      dryRun,
      organize,
      queue,
      case: caseId,
      caseAction,
      files: plan.files.length,
      accepted: accepted.length,
      skippedByReviewer: skipped,
      filingsCreated: rows.filter((r) => r.filingAction === 'created').length,
      filingsFound: rows.filter((r) => r.filingAction === 'found').length,
      documentsCreated: rows.filter((r) => r.documentAction.startsWith('created')).length,
      documentsUpdated: rows.filter((r) => ['attach', 'queue', 'repath'].some((v) => r.documentAction.includes(v)) && !r.documentAction.startsWith('would')).length,
      moved: rows.filter((r) => r.movedTo && !dryRun).length,
      linksWritten,
      rowsWithWarnings: rows.filter((r) => r.warnings.length).length,
      note: dryRun
        ? 'Dry run: nothing was written or moved. Pass dryRun=false to apply this exact plan.'
        : 'Applied. Ingestion runs in the parsing worker; poll ssIngestStatus for progress.',
    },
    rows,
  };
}
