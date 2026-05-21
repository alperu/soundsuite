/**
 * @jest-environment node
 */
import { findDedupMatches, levenshtein, tokenSetScore } from '../dedup'

const pool = [
  { id: 'p1', displayName: 'John Smith', email: 'john@firm.com', barNumber: 'TX12345678' },
  { id: 'p2', displayName: 'Jane Doe', email: null, barNumber: null },
  { id: 'p3', displayName: 'Patricia M. Garcia', email: 'pmg@court.gov', barNumber: null },
]

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0)
  })
  it('counts one substitution', () => {
    expect(levenshtein('john', 'jon')).toBe(1)
  })
  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
  })
})

describe('tokenSetScore', () => {
  it('returns 1 for identical token sets', () => {
    expect(tokenSetScore('John Smith', 'Smith John')).toBe(1)
  })
  it('partial overlap', () => {
    expect(tokenSetScore('John Q Smith', 'John Smith')).toBeGreaterThan(0.4)
  })
})

describe('findDedupMatches', () => {
  it('exact bar match scores 1.0', async () => {
    const matches = await findDedupMatches(
      { displayName: 'Different Name', barNumber: 'TX12345678' },
      pool,
    )
    expect(matches[0]?.reason).toBe('bar')
    expect(matches[0]?.score).toBe(1.0)
    expect(matches[0]?.personId).toBe('p1')
  })

  it('exact email match scores ~0.95', async () => {
    const matches = await findDedupMatches(
      { displayName: 'Differs Entirely', email: 'pmg@court.gov' },
      pool,
    )
    expect(matches[0]?.reason).toBe('email')
    expect(matches[0]?.personId).toBe('p3')
  })

  it('similar name (Jon vs John) hits name-similar', async () => {
    const matches = await findDedupMatches({ displayName: 'Jon Smith' }, pool)
    const top = matches[0]
    expect(top).toBeDefined()
    expect(['name-similar', 'name-tokens']).toContain(top!.reason)
    expect(top!.personId).toBe('p1')
    expect(top!.score).toBeGreaterThanOrEqual(0.7)
  })

  it('returns empty for completely unrelated name', async () => {
    const matches = await findDedupMatches(
      { displayName: 'Bartholomew Xenophon Zumwalt' },
      pool,
    )
    expect(matches.length).toBe(0)
  })
})
