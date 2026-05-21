/**
 * @jest-environment node
 */
import { runRegexStage } from '../extract'

describe('runRegexStage', () => {
  it('extracts a signature-block candidate with bar number + attorney-for context', () => {
    const text = `
ORDER

The Court having considered the motion, it is hereby ORDERED.

Respectfully submitted,

/s/ Jane Q. Lawyer
Jane Q. Lawyer
State Bar No. 12345678
Email: jane@lawfirm.com
Attorney for Movant
    `
    const out = runRegexStage({ chunkId: 'chunk-1', text })
    expect(out.length).toBeGreaterThan(0)
    const sig = out.find((c) => c.intrinsicTags.lawyer)
    expect(sig).toBeDefined()
    expect(sig?.displayName.toLowerCase()).toContain('jane')
    expect(sig?.barNumber).toContain('12345678')
    expect(sig?.email).toBe('jane@lawfirm.com')
    expect(sig?.contextualTagsHint?.lawyerMovant).toBe(true)
  })

  it('detects a judge from Hon. caption', () => {
    const text = `Before the Hon. Patricia M. Garcia, presiding.`
    const out = runRegexStage({ chunkId: 'c', text })
    const judge = out.find((c) => c.intrinsicTags.judge)
    expect(judge).toBeDefined()
    expect(judge?.displayName).toMatch(/Patricia/)
  })

  it('detects plaintiff vs defendant from a caption line', () => {
    const text = `JOHN DOE vs. ACME CORPORATION`
    const out = runRegexStage({ chunkId: 'c', text })
    const plaintiff = out.find((c) => c.contextualTagsHint?.plaintiff)
    const defendant = out.find((c) => c.contextualTagsHint?.defendant)
    expect(plaintiff).toBeDefined()
    expect(defendant).toBeDefined()
    expect(plaintiff?.displayName).toMatch(/John/i)
    expect(defendant?.displayName).toMatch(/Acme/i)
  })

  it('flags a court reporter via Court Reporter line', () => {
    const text = `Court Reporter: Sandra Williams, CSR 4421`
    const out = runRegexStage({ chunkId: 'c', text })
    const reporter = out.find((c) => c.intrinsicTags.courtReporter)
    expect(reporter).toBeDefined()
    expect(reporter?.displayName).toMatch(/Sandra/)
  })

  it('returns an empty list for boring text', () => {
    const out = runRegexStage({ chunkId: 'c', text: 'the quick brown fox\njumps over the lazy dog' })
    expect(out).toEqual([])
  })
})
