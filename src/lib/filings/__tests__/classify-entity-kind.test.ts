import { classifyFilingEntityKind } from '../classify-entity-kind';

describe('classifyFilingEntityKind', () => {
  it('maps Motion to motion entity (no hint)', () => {
    expect(classifyFilingEntityKind('Motion')).toEqual({ entityKind: 'motion' });
  });

  it("maps Clerk's Record to clerksRecord (apostrophe variants)", () => {
    expect(classifyFilingEntityKind("Clerk's Record")).toEqual({ entityKind: 'clerksRecord' });
    expect(classifyFilingEntityKind('Clerks Record')).toEqual({ entityKind: 'clerksRecord' });
    expect(classifyFilingEntityKind('CR')).toEqual({ entityKind: 'clerksRecord' });
  });

  it("maps Reporter's Record to reportersRecord", () => {
    expect(classifyFilingEntityKind("Reporter's Record")).toEqual({ entityKind: 'reportersRecord' });
    expect(classifyFilingEntityKind('Reporters Record')).toEqual({ entityKind: 'reportersRecord' });
    expect(classifyFilingEntityKind('RR')).toEqual({ entityKind: 'reportersRecord' });
  });

  // Per-filing-type entity kinds. Each canonical filing type now maps to its
  // own EntityKind (no longer collapsed to `motionAttachment`).
  it.each([
    ['Notice', 'notice', 'notice'],
    ['Letter', 'letter', 'letter'],
    ['Order', 'order', 'order'],
    ['Petition', 'petition', 'petition'],
    ['Affidavit', 'affidavit', 'affidavit'],
    ['Subpoena', 'subpoena', 'subpoena'],
    ['Brief', 'brief', 'brief'],
    ['Response', 'response', 'response'],
    ['Reply', 'reply', 'reply'],
    ['Judgment', 'judgment', 'judgment'],
    ['Decree', 'decree', 'decree'],
    ['Transcript', 'transcript', 'transcript'],
    ['Settlement', 'settlement', 'settlement'],
    ['Bill of Review', 'billOfReview', 'billOfReview'],
    ['Return of Service', 'returnOfService', 'returnOfService'],
    ['Demand Letter', 'demandLetter', 'demandLetter'],
    ['Objection', 'objection', 'objection'],
    ['Request', 'request', 'request'],
    ['Supplement', 'supplement', 'supplement'],
    ['Designation', 'designation', 'designation'],
    ['Other', 'other', 'other'],
  ])('maps %s to entityKind=%s with hint=%s', (label, kind, hint) => {
    expect(classifyFilingEntityKind(label)).toEqual({
      entityKind: kind,
      attachmentKindHint: hint,
    });
  });

  it('falls through to "other" for unknown / null / empty input', () => {
    expect(classifyFilingEntityKind(null)).toEqual({
      entityKind: 'other',
      attachmentKindHint: 'other',
    });
    expect(classifyFilingEntityKind('')).toEqual({
      entityKind: 'other',
      attachmentKindHint: 'other',
    });
    expect(classifyFilingEntityKind('Some Made-Up Type')).toEqual({
      entityKind: 'other',
      attachmentKindHint: 'other',
    });
  });
});
