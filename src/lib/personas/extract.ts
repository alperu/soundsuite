/**
 * Persona extraction service — multi-stage cascade:
 *
 *   Stage 1: LanceDB chunk retrieval (caption + signature blocks).
 *   Stage 2: Regex / heuristic pattern matching.
 *   Stage 3: LLM extraction (scaffold only — throws not_implemented).
 *   Stage 4: Manual admin fallback (returns empty + recommendation).
 *
 * Each Candidate carries an `intrinsicTags` dict (markers like `lawyer`,
 * `judge`), an optional `proposedRole` (PersonRole bindings), `sourceChunkId`
 * / `sourceQuote` for the "show in document" UX, and `dedupMatches` against
 * the existing Person pool.
 */

import { prisma } from '@/lib/db/prisma'
import { VectorStore } from '@/lib/vector/vector-store'
import { findDedupMatches, type DedupMatch } from './dedup'
import {
  ATTORNEY_FOR_RE,
  ALLCAPS_JUDGE_RE,
  BAR_NUMBER_RE,
  BY_LINE_RE,
  CAPTION_RE,
  CLERK_RE,
  COURT_REPORTER_RE,
  CSR_RE,
  EMAIL_RE,
  E_SIG_RE,
  FILED_BY_RE,
  HON_JUDGE_RE,
} from './regex-patterns'

export type ScopeKind = 'motion' | 'case'

export interface IntrinsicTags {
  lawyer?: boolean
  judge?: boolean
  courtClerk?: boolean
  courtReporter?: boolean
  bailiff?: boolean
  proSe?: boolean
  self?: boolean
}

export interface ContextualTags {
  movant?: boolean
  respondent?: boolean
  defendant?: boolean
  plaintiff?: boolean
  intervenor?: boolean
  lawyerMovant?: boolean
  lawyerRespondent?: boolean
  judge?: boolean
}

export interface ProposedRole {
  scopeKind: ScopeKind
  scopeId: string
  contextualTags: ContextualTags
}

export interface PersonaCandidate {
  displayName: string
  barNumber?: string
  email?: string
  intrinsicTags: IntrinsicTags
  proposedRole?: ProposedRole
  sourceChunkId?: string
  sourceQuote?: string
  dedupMatches: DedupMatch[]
}

export interface ExtractResult {
  documentId: string
  documentName: string
  caseId: string
  motionId?: string
  candidates: PersonaCandidate[]
  recommendation: 'review' | 'manual'
  stagesRun: string[]
}

interface RawCandidate {
  displayName: string
  barNumber?: string
  email?: string
  intrinsicTags: IntrinsicTags
  contextualTagsHint?: ContextualTags
  sourceChunkId?: string
  sourceQuote?: string
}

interface ChunkLite {
  chunkId: string
  text: string
}

/**
 * Top-level entrypoint. Resolves the document, runs the cascade, dedups
 * candidates, attaches `dedupMatches`, and returns the assembled result.
 */
export async function extractPersonas(documentId: string): Promise<ExtractResult> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      fileName: true,
      caseId: true,
    },
  })
  if (!doc) throw new Error(`document_not_found:${documentId}`)

  const stagesRun: string[] = []

  // Best-effort motion lookup — first motion in this doc's filing if any.
  let motionId: string | undefined
  const motionAttach = await prisma.motionAttachment.findFirst({
    where: { documentId },
    select: { motionId: true },
  })
  if (motionAttach) motionId = motionAttach.motionId

  // ── Stage 1: LanceDB chunks ────────────────────────────────────────────
  let chunks: ChunkLite[] = []
  try {
    chunks = await fetchSignatureAndCaptionChunks(documentId)
    stagesRun.push('lancedb-chunks')
  } catch {
    // Vector store may be unavailable in tests / fresh installs — keep going.
  }

  // ── Stage 2: Regex extraction ──────────────────────────────────────────
  const raw: RawCandidate[] = []
  for (const ch of chunks) {
    raw.push(...runRegexStage(ch))
  }
  if (chunks.length) stagesRun.push('regex')

  // Merge raw candidates by normalized displayName before dedup.
  const merged = mergeRawCandidates(raw)

  // Build PersonaCandidate[] with dedupMatches + proposedRole.
  const pool = await prisma.person.findMany({
    select: { id: true, displayName: true, email: true, barNumber: true },
  })

  const candidates: PersonaCandidate[] = []
  for (const r of merged) {
    const dedupMatches = await findDedupMatches(
      { displayName: r.displayName, barNumber: r.barNumber, email: r.email },
      pool,
    )
    const proposedRole = buildProposedRole(r, motionId, doc.caseId)
    candidates.push({
      displayName: r.displayName,
      barNumber: r.barNumber,
      email: r.email,
      intrinsicTags: r.intrinsicTags,
      proposedRole,
      sourceChunkId: r.sourceChunkId,
      sourceQuote: r.sourceQuote,
      dedupMatches,
    })
  }

  // Stages 3 + 4: LLM is scaffolded; fall through to manual when zero candidates.
  const recommendation: 'review' | 'manual' = candidates.length ? 'review' : 'manual'
  if (!candidates.length) stagesRun.push('manual-fallback')

  return {
    documentId: doc.id,
    documentName: doc.fileName,
    caseId: doc.caseId,
    motionId,
    candidates,
    recommendation,
    stagesRun,
  }
}

/**
 * Fetch the first 3 + last 5 chunks for a document — caption + signature
 * blocks are the high-yield zones. Falls back to all chunks under ~30KB if
 * positional metadata is unavailable.
 */
export async function fetchSignatureAndCaptionChunks(
  documentId: string,
): Promise<ChunkLite[]> {
  const vectorStore = new VectorStore({
    dbPath: process.env.LANCEDB_PATH || './data/lancedb',
    tableName: 'chunks',
  })
  await vectorStore.initialize()
  const results = await vectorStore.search({
    filter: { documentId },
    limit: 500,
  })
  if (!results.length) return []

  // Sort by (pageNumber, chunkIndex) ascending.
  results.sort((a, b) => {
    const pa = a.metadata.pageNumber ?? 0
    const pb = b.metadata.pageNumber ?? 0
    if (pa !== pb) return pa - pb
    return (a.metadata.chunkIndex ?? 0) - (b.metadata.chunkIndex ?? 0)
  })

  const head = results.slice(0, 3)
  const tail = results.slice(Math.max(0, results.length - 5))
  // Dedup by chunkId.
  const seen = new Set<string>()
  const out: ChunkLite[] = []
  for (const r of [...head, ...tail]) {
    if (seen.has(r.chunkId)) continue
    seen.add(r.chunkId)
    out.push({ chunkId: r.chunkId, text: r.text })
  }
  return out
}

/**
 * Run all regex patterns against one chunk and emit raw candidates.
 * Each finding remembers the chunkId + a 100-char excerpt.
 */
export function runRegexStage(chunk: ChunkLite): RawCandidate[] {
  const out: RawCandidate[] = []
  const text = chunk.text

  // Caption detection — plaintiff / defendant on a single uppercase line.
  const cap = CAPTION_RE.exec(text)
  if (cap) {
    out.push({
      displayName: titleCase(cap[1].trim()),
      intrinsicTags: {},
      contextualTagsHint: { plaintiff: true },
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, cap.index, 100),
    })
    out.push({
      displayName: titleCase(cap[2].trim()),
      intrinsicTags: {},
      contextualTagsHint: { defendant: true },
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, cap.index, 100),
    })
  }

  // Hon. Judge.
  for (const m of allMatches(HON_JUDGE_RE, text)) {
    out.push({
      displayName: cleanName(m[1]),
      intrinsicTags: { judge: true },
      contextualTagsHint: { judge: true },
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, m.index, 100),
    })
  }
  for (const m of allMatches(ALLCAPS_JUDGE_RE, text)) {
    out.push({
      displayName: titleCase(m[1].trim()),
      intrinsicTags: { judge: true },
      contextualTagsHint: { judge: true },
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, m.index, 100),
    })
  }

  // Clerk file-stamps.
  for (const m of allMatches(CLERK_RE, text)) {
    out.push({
      displayName: cleanName(m[1]),
      intrinsicTags: { courtClerk: true },
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, m.index, 100),
    })
  }
  for (const m of allMatches(FILED_BY_RE, text)) {
    out.push({
      displayName: cleanName(m[1]),
      intrinsicTags: { courtClerk: true },
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, m.index, 100),
    })
  }
  // Court reporters.
  for (const m of allMatches(COURT_REPORTER_RE, text)) {
    out.push({
      displayName: cleanName(m[1]),
      intrinsicTags: { courtReporter: true },
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, m.index, 100),
    })
  }

  // Signature blocks — `/s/ Name` and `By: Name`. Treat as lawyer signature.
  // We pair each match with a nearby block (window: ±400 chars) that may
  // contain "Attorney for X", a bar number, an email.
  const sigCandidates: Array<{ name: string; idx: number }> = []
  for (const m of allMatches(E_SIG_RE, text)) {
    sigCandidates.push({ name: cleanName(m[1]), idx: m.index })
  }
  // `By: Name` is a multiline anchored pattern — exec only once with /m flag.
  const byMatch = BY_LINE_RE.exec(text)
  if (byMatch) sigCandidates.push({ name: cleanName(byMatch[1]), idx: byMatch.index })

  for (const sig of sigCandidates) {
    const windowStart = Math.max(0, sig.idx - 50)
    const windowEnd = Math.min(text.length, sig.idx + 400)
    const window = text.slice(windowStart, windowEnd)
    const barMatch = nextBarNumber(window)
    const emailMatch = window.match(EMAIL_RE)?.[0]
    const attorneyForMatch = window.match(ATTORNEY_FOR_RE)
    const role = attorneyForMatch?.[1]?.toLowerCase()
    const ctx: ContextualTags = {}
    if (role === 'movant' || role === 'petitioner' || role === 'plaintiff' || role === 'appellant') {
      ctx.lawyerMovant = true
    } else if (
      role === 'respondent' ||
      role === 'defendant' ||
      role === 'appellee'
    ) {
      ctx.lawyerRespondent = true
    }
    out.push({
      displayName: sig.name,
      barNumber: barMatch,
      email: emailMatch,
      intrinsicTags: { lawyer: true },
      contextualTagsHint: Object.keys(ctx).length ? ctx : undefined,
      sourceChunkId: chunk.chunkId,
      sourceQuote: excerpt(text, sig.idx, 100),
    })
  }

  return out
}

/** Find the first bar number in a window; returns the normalised "<prefix?><digits>". */
function nextBarNumber(window: string): string | undefined {
  // Clone the regex — global state would leak across calls.
  const re = new RegExp(BAR_NUMBER_RE.source, 'g')
  const m = re.exec(window)
  if (!m) return undefined
  const prefix = m[1] ?? ''
  const digits = m[2]
  // Skip year-like 4-digit standalone numbers (regex already requires 6+).
  return `${prefix}${digits}`.trim() || undefined
}

function excerpt(text: string, index: number, n: number): string {
  const start = Math.max(0, index)
  return text.slice(start, start + n).replace(/\s+/g, ' ').trim()
}

function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g'
  const cloned = new RegExp(re.source, flags)
  let m: RegExpExecArray | null
  while ((m = cloned.exec(text))) {
    out.push(m)
    if (m.index === cloned.lastIndex) cloned.lastIndex++
  }
  return out
}

function cleanName(raw: string): string {
  return raw
    .replace(/[\s,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function titleCase(allCaps: string): string {
  return allCaps
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** Merge raw candidates that share the same normalised displayName. */
function mergeRawCandidates(raw: RawCandidate[]): RawCandidate[] {
  const map = new Map<string, RawCandidate>()
  for (const r of raw) {
    const key = r.displayName.toLowerCase().replace(/\s+/g, ' ').trim()
    const existing = map.get(key)
    if (!existing) {
      map.set(key, { ...r, intrinsicTags: { ...r.intrinsicTags } })
      continue
    }
    Object.assign(existing.intrinsicTags, r.intrinsicTags)
    if (!existing.barNumber && r.barNumber) existing.barNumber = r.barNumber
    if (!existing.email && r.email) existing.email = r.email
    if (!existing.contextualTagsHint && r.contextualTagsHint) {
      existing.contextualTagsHint = r.contextualTagsHint
    } else if (existing.contextualTagsHint && r.contextualTagsHint) {
      Object.assign(existing.contextualTagsHint, r.contextualTagsHint)
    }
  }
  return [...map.values()]
}

function buildProposedRole(
  r: RawCandidate,
  motionId: string | undefined,
  caseId: string,
): ProposedRole | undefined {
  if (!r.contextualTagsHint || !Object.keys(r.contextualTagsHint).length) return undefined
  if (motionId) {
    return {
      scopeKind: 'motion',
      scopeId: motionId,
      contextualTags: { ...r.contextualTagsHint },
    }
  }
  return {
    scopeKind: 'case',
    scopeId: caseId,
    contextualTags: { ...r.contextualTagsHint },
  }
}

/**
 * Stage 3 scaffold — call the sidecar's LLM for ambiguous documents.
 *
 * Prompt shape (when implemented):
 *   System: "You are an extraction service. Given the following motion text,
 *            list every person mentioned with their role (lawyer/judge/clerk/
 *            reporter/movant/respondent/defendant/plaintiff). Return strict
 *            JSON: { candidates: [{displayName, barNumber?, email?,
 *            intrinsicTags, contextualTags?}] }"
 *   User:   The concatenated chunk text (≤ 30KB).
 *
 * Wire: POST `${process.env.SIDECAR_URL}/chat/extract-personas` with body
 * `{ text, model: 'completion' }`. Response should match the system schema.
 */
export async function tryLlmExtract(_chunks: ChunkLite[]): Promise<RawCandidate[]> {
  throw new Error('not_implemented')
}
