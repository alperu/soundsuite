/**
 * Draft-detector unit tests. All fixtures are SYNTHETIC — invented names,
 * placeholder cause numbers, generic titles.
 */
import { detectDraftStatus, hasFileStamp, recordStatusFromTags, DRAFT_THRESHOLD } from '../draft-detector';

const CAPTION = `CAUSE NO. 00-0000-XX

JANE ROE,                          §   IN THE DISTRICT COURT
   Petitioner,                     §
v.                                 §   000TH JUDICIAL DISTRICT
JOHN DOE,                          §
   Respondent.                     §   EXAMPLE COUNTY, TEXAS

MOTION FOR CONTINUANCE
`;

const FILED_HEADER = `Filed 3/14/2024 9:02 AM
Pat Example, District Clerk
Example County, Texas
Envelope No. 12345678
`;

const BODY = `Petitioner respectfully moves this Court for a continuance of the hearing currently set and in support shows the following.

1. The parties have exchanged discovery.
2. Counsel has a conflict on the current setting.

WHEREFORE, Petitioner prays the Court grant this motion.
`;

const SIGNED = `Respectfully submitted,

/s/ Alex Example
Alex Example
State Bar No. 00000000
Attorney for Petitioner
`;

describe('detectDraftStatus', () => {
  it('flags a DRAFT watermark repeated across pages as a draft', () => {
    const pages = [
      `DRAFT\n${CAPTION}${BODY}`,
      `DRAFT\n${BODY}`,
      `DRAFT\n${SIGNED}`,
    ].join('\n\n');
    const r = detectDraftStatus({ fileName: 'motion.pdf', firstPagesText: pages, pageCount: 3 });
    expect(r.isDraft).toBe(true);
    expect(r.recordStatus).toBe('draft');
    expect(r.confidence).toBeGreaterThanOrEqual(DRAFT_THRESHOLD);
    expect(r.signals).toEqual(expect.arrayContaining([expect.stringMatching(/^body:draft-watermark/), 'stamp:no-file-stamp']));
  });

  it('classifies a file-stamped filing as filed, not draft', () => {
    const r = detectDraftStatus({ fileName: 'motion.pdf', firstPagesText: `${FILED_HEADER}${CAPTION}${BODY}`, lastPagesText: SIGNED });
    expect(r.isDraft).toBe(false);
    expect(r.hasFileStamp).toBe(true);
    expect(r.recordStatus).toBe('filed');
    expect(r.confidence).toBe(0);
  });

  it('returns unknown (NOT draft) when there is no stamp and no draft signal', () => {
    const r = detectDraftStatus({ fileName: 'motion.pdf', firstPagesText: `${CAPTION}${BODY}`, lastPagesText: SIGNED });
    expect(r.isDraft).toBe(false);
    expect(r.hasFileStamp).toBe(false);
    expect(r.recordStatus).toBe('unknown');
    expect(r.confidence).toBe(0);
    // Absence of a stamp alone must not even register as a signal.
    expect(r.signals).not.toContain('stamp:no-file-stamp');
  });

  it('flags filename motion-draft-v2.pdf with bracketed placeholders and blank signature lines', () => {
    const last = `Dated: ____________

______________________________
JUDGE PRESIDING

[INSERT ATTORNEY NAME]
Attorney for Petitioner`;
    const r = detectDraftStatus({ fileName: 'motion-draft-v2.pdf', firstPagesText: `${CAPTION}${BODY}`, lastPagesText: last });
    expect(r.isDraft).toBe(true);
    expect(r.recordStatus).toBe('draft');
    expect(r.signals).toEqual(expect.arrayContaining([
      'filename:draft',
      'filename:version',
      expect.stringMatching(/^body:bracket-placeholders/),
      expect.stringMatching(/^body:blank-signature-or-date/),
    ]));
  });

  it('treats "NOT FOR FILING" as a strong draft signal', () => {
    const r = detectDraftStatus({ fileName: 'response.pdf', firstPagesText: `CONFIDENTIAL DRAFT — NOT FOR FILING\n${CAPTION}${BODY}` });
    expect(r.isDraft).toBe(true);
  });

  it('does not flag a filed document whose prose mentions a "draft order"', () => {
    const prose = `${FILED_HEADER}${CAPTION}Petitioner attaches a proposed draft order for the Court's consideration. ${BODY}`;
    const r = detectDraftStatus({ fileName: 'motion.pdf', firstPagesText: prose, lastPagesText: SIGNED });
    expect(r.isDraft).toBe(false);
    expect(r.recordStatus).toBe('filed');
  });

  it('a version suffix alone is not enough to call something a draft', () => {
    const r = detectDraftStatus({ fileName: 'brief-v3.pdf', firstPagesText: `${CAPTION}${BODY}`, lastPagesText: SIGNED });
    expect(r.isDraft).toBe(false);
    expect(r.recordStatus).toBe('unknown');
  });

  it('a file stamp outweighs a filename draft hint', () => {
    const r = detectDraftStatus({ fileName: 'motion-draft.pdf', firstPagesText: `${FILED_HEADER}${CAPTION}${BODY}`, lastPagesText: SIGNED });
    expect(r.isDraft).toBe(false);
    expect(r.recordStatus).toBe('filed');
  });

  it('handles empty input without throwing', () => {
    const r = detectDraftStatus({ fileName: '', firstPagesText: '' });
    expect(r).toEqual({ isDraft: false, confidence: 0, signals: [], hasFileStamp: false, recordStatus: 'unknown' });
  });
});

describe('hasFileStamp', () => {
  it('recognises e-file envelope numbers and clerk stamps', () => {
    expect(hasFileStamp('Envelope No. 87654321')).toBe(true);
    expect(hasFileStamp('E-FILED 01/02/2024 4:15 PM')).toBe(true);
    expect(hasFileStamp('FILED FOR RECORD')).toBe(true);
    expect(hasFileStamp('nothing of the sort here')).toBe(false);
  });
});

describe('recordStatusFromTags', () => {
  it('normalises the tag bag to a RecordStatus', () => {
    expect(recordStatusFromTags({ recordStatus: 'draft' })).toBe('draft');
    expect(recordStatusFromTags({ recordStatus: 'filed' })).toBe('filed');
    expect(recordStatusFromTags({ recordStatus: 'bogus' })).toBe('unknown');
    expect(recordStatusFromTags(null)).toBe('unknown');
    expect(recordStatusFromTags('{}')).toBe('unknown');
  });
});

describe('detectDraftStatus — prose false positives', () => {
  // Regression: bare "not filed" matched ordinary litigation prose about a
  // party's conduct and flagged genuinely filed documents as drafts.
  it('does not treat "has not filed a bond" prose as a draft marker', () => {
    const r = detectDraftStatus({
      fileName: 'motion.pdf',
      firstPagesText:
        'CAUSE NO. 00-0000-XX\nRespondent has not filed a supersedeas bond, cash deposit in lieu ' +
        'of bond, or other security pursuant to the applicable rule.',
    });
    expect(r.signals).not.toContain('body:not-for-filing');
    expect(r.recordStatus).not.toBe('draft');
    expect(r.isDraft).toBe(false);
  });

  it('still flags an explicit NOT FOR FILING marker', () => {
    const r = detectDraftStatus({
      fileName: 'order.pdf',
      firstPagesText: 'DRAFT — NOT FOR FILING\nCAUSE NO. 00-0000-XX\nProposed order granting relief.',
    });
    expect(r.signals).toContain('body:not-for-filing');
    expect(r.recordStatus).toBe('draft');
  });

  it('still flags an explicit DO NOT FILE marker', () => {
    const r = detectDraftStatus({
      fileName: 'order.pdf',
      firstPagesText: 'DO NOT FILE — attorney working copy\nCAUSE NO. 00-0000-XX\nDated: ______',
    });
    expect(r.signals).toContain('body:not-for-filing');
  });
});
