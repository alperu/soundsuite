import { extractStructureHint, speakersInclude } from '../structure-hints';

describe('extractStructureHint', () => {
  it('detects "table on page N"', () => {
    expect(extractStructureHint('what does the table on page 12 show?')).toEqual({ tablePage: 12 });
    expect(extractStructureHint('summarize the tables from page 209')).toEqual({ tablePage: 209 });
  });

  it('detects speaker asks and normalizes the label', () => {
    expect(extractStructureHint('what did the court say about the stay?')).toEqual({ speaker: 'THE COURT' });
    expect(extractStructureHint('What did Mr Doe argue at the hearing?')).toEqual({ speaker: 'MR. DOE' });
    expect(extractStructureHint('what did the witness testify regarding the account?'))
      .toEqual({ speaker: 'THE WITNESS' });
  });

  it('returns empty for content queries', () => {
    expect(extractStructureHint('receivership order net proceeds routing')).toEqual({});
    expect(extractStructureHint('table stakes for the motion')).toEqual({});
  });
});

describe('speakersInclude', () => {
  it('matches exact delimited labels only', () => {
    expect(speakersInclude('|THE COURT|MR. DOE|', 'THE COURT')).toBe(true);
    expect(speakersInclude('|THE COURT REPORTER|', 'THE COURT')).toBe(false);
    expect(speakersInclude(undefined, 'THE COURT')).toBe(false);
  });
});
