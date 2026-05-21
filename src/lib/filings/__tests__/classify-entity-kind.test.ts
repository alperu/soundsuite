import { classifyFilingEntityKind } from '../classify-entity-kind';

describe('classifyFilingEntityKind', () => {
  it('maps Motion to motion entity', () => {
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

  it('maps Brief to motionAttachment with brief hint', () => {
    expect(classifyFilingEntityKind('Brief')).toEqual({
      entityKind: 'motionAttachment',
      attachmentKindHint: 'brief',
    });
  });

  it('maps Response and Reply both to motionAttachment + response hint', () => {
    expect(classifyFilingEntityKind('Response')).toEqual({
      entityKind: 'motionAttachment',
      attachmentKindHint: 'response',
    });
    expect(classifyFilingEntityKind('Reply')).toEqual({
      entityKind: 'motionAttachment',
      attachmentKindHint: 'response',
    });
  });

  it('maps Notice / Petition / Affidavit / Subpoena / Order / Judgment / Decree to motionAttachment with kind hint', () => {
    expect(classifyFilingEntityKind('Notice').attachmentKindHint).toBe('notice');
    expect(classifyFilingEntityKind('Petition').attachmentKindHint).toBe('petition');
    expect(classifyFilingEntityKind('Affidavit').attachmentKindHint).toBe('affidavit');
    expect(classifyFilingEntityKind('Subpoena').attachmentKindHint).toBe('subpoena');
    expect(classifyFilingEntityKind('Order').attachmentKindHint).toBe('order');
    expect(classifyFilingEntityKind('Judgment').attachmentKindHint).toBe('judgment');
    expect(classifyFilingEntityKind('Decree').attachmentKindHint).toBe('judgment');
  });

  it('maps Bill of Review / Demand Letter / Settlement / Transcript', () => {
    expect(classifyFilingEntityKind('Bill of Review').attachmentKindHint).toBe('billOfReview');
    expect(classifyFilingEntityKind('Demand Letter').attachmentKindHint).toBe('email');
    expect(classifyFilingEntityKind('Settlement').attachmentKindHint).toBe('settlement');
    expect(classifyFilingEntityKind('Transcript').attachmentKindHint).toBe('transcript');
  });

  it('maps Request to rfa hint and Supplement/Objection/Designation to supportingDoc', () => {
    expect(classifyFilingEntityKind('Request').attachmentKindHint).toBe('rfa');
    expect(classifyFilingEntityKind('Supplement').attachmentKindHint).toBe('supportingDoc');
    expect(classifyFilingEntityKind('Objection').attachmentKindHint).toBe('supportingDoc');
    expect(classifyFilingEntityKind('Designation').attachmentKindHint).toBe('supportingDoc');
  });

  it('falls through to motionAttachment with no hint for unknown / null input', () => {
    expect(classifyFilingEntityKind('Other')).toEqual({ entityKind: 'motionAttachment' });
    expect(classifyFilingEntityKind(null)).toEqual({ entityKind: 'motionAttachment' });
    expect(classifyFilingEntityKind('')).toEqual({ entityKind: 'motionAttachment' });
  });
});
