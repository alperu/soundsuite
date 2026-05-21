/**
 * Persona dedup — match an extracted candidate against the existing Person
 * pool. Scores 0..1 with a discrete reason tag for UX.
 *
 * Used by `extract.ts` and the admin manual-define path.
 */

import { prisma } from '@/lib/db/prisma'
import { normalizeName, nameTokens } from './regex-patterns'

export type DedupReason = 'bar' | 'email' | 'name-similar' | 'name-tokens'

export interface DedupMatch {
  personId: string
  displayName: string
  score: number
  reason: DedupReason
}

export interface DedupCandidateInput {
  displayName: string
  barNumber?: string
  email?: string
}

interface PersonLite {
  id: string
  displayName: string
  email: string | null
  barNumber: string | null
}

/** Minimal Levenshtein distance (iterative, O(n*m) space O(min)). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  // Ensure a is the shorter
  if (a.length > b.length) {
    const tmp = a
    a = b
    b = tmp
  }
  let prev = new Array(a.length + 1)
  let curr = new Array(a.length + 1)
  for (let i = 0; i <= a.length; i++) prev[i] = i
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[i] = Math.min(
        curr[i - 1] + 1, // insertion
        prev[i] + 1, // deletion
        prev[i - 1] + cost, // substitution
      )
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[a.length]
}

/** Jaccard similarity on lowercased token sets. */
export function tokenSetScore(a: string, b: string): number {
  const ta = new Set(nameTokens(a))
  const tb = new Set(nameTokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return inter / union
}

/**
 * Find dedup matches for a candidate against the existing Person table.
 * Returns top 3 by score descending. Score 1.0 = certain (bar/email match);
 * 0.7-0.99 = very likely; 0.5-0.69 = plausible; below 0.5 omitted.
 */
export async function findDedupMatches(
  candidate: DedupCandidateInput,
  poolOverride?: PersonLite[],
): Promise<DedupMatch[]> {
  const pool: PersonLite[] =
    poolOverride ??
    (await prisma.person.findMany({
      select: { id: true, displayName: true, email: true, barNumber: true },
    }))

  const matches: DedupMatch[] = []
  const nameNorm = normalizeName(candidate.displayName)

  for (const p of pool) {
    // 1) Bar number exact (highest confidence)
    if (
      candidate.barNumber &&
      p.barNumber &&
      candidate.barNumber.replace(/\D/g, '') === p.barNumber.replace(/\D/g, '')
    ) {
      matches.push({
        personId: p.id,
        displayName: p.displayName,
        score: 1.0,
        reason: 'bar',
      })
      continue
    }
    // 2) Email exact
    if (
      candidate.email &&
      p.email &&
      candidate.email.toLowerCase() === p.email.toLowerCase()
    ) {
      matches.push({
        personId: p.id,
        displayName: p.displayName,
        score: 0.95,
        reason: 'email',
      })
      continue
    }
    // 3) Levenshtein on normalised displayName
    const pNorm = normalizeName(p.displayName)
    if (pNorm && nameNorm) {
      const dist = levenshtein(pNorm, nameNorm)
      if (dist <= 2) {
        // Score scales with length: a 2-char edit on a 20-char name is closer
        // to identical than on a 6-char name.
        const maxLen = Math.max(pNorm.length, nameNorm.length)
        const score = Math.max(0.7, 1 - dist / Math.max(maxLen, 1))
        matches.push({
          personId: p.id,
          displayName: p.displayName,
          score,
          reason: 'name-similar',
        })
        continue
      }
    }
    // 4) Token-set Jaccard
    const tokScore = tokenSetScore(p.displayName, candidate.displayName)
    if (tokScore >= 0.5) {
      matches.push({
        personId: p.id,
        displayName: p.displayName,
        score: 0.5 + tokScore * 0.3, // 0.5..0.8
        reason: 'name-tokens',
      })
    }
  }

  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, 3)
}
