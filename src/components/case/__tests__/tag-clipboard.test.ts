import {
  canonicalizeTagValue,
  parseClipboardForSpec,
  clipboardSupport,
} from '../tag-clipboard';
import type { TagSpec } from '../tag-spec';

const refSpec: TagSpec = {
  name: 'judge',
  tier: 'refs',
  doc: '',
  valueType: 'ref',
  refTarget: 'person',
};
const fileRefSpec: TagSpec = {
  name: 'fileRef',
  tier: 'ref',
  doc: '',
  valueType: 'ref',
  refTarget: 'doc',
};
const dateSpec: TagSpec = {
  name: 'filedAt',
  tier: 'value',
  doc: '',
  valueType: 'date',
};
const numSpec: TagSpec = {
  name: 'revisionSeq',
  tier: 'value',
  doc: '',
  valueType: 'number',
};
const textSpec: TagSpec = {
  name: 'note',
  tier: 'value',
  doc: '',
  valueType: 'text',
};
const boolSpec: TagSpec = {
  name: 'urgent',
  tier: 'marker',
  doc: '',
  valueType: 'bool',
};
const computedSpec: TagSpec = {
  name: 'caseStatus',
  tier: 'value',
  doc: '',
  valueType: 'text',
  info: {
    whatItIs: 'x',
    mapsTo: 'computed (something)',
  },
};

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('canonicalizeTagValue', () => {
  test('Document ref + label → copies the full filePath (not the UUID)', () => {
    const value = { _kind: 'ref', val: UUID };
    const fullPath = '/Users/alper/Court/03-25-00905-CV/Motion/X.pdf';
    expect(canonicalizeTagValue(fileRefSpec, value, fullPath)).toBe(fullPath);
  });

  test('Document ref without label → falls back to UUID', () => {
    const value = { _kind: 'ref', val: UUID };
    expect(canonicalizeTagValue(fileRefSpec, value)).toBe(UUID);
    expect(canonicalizeTagValue(fileRefSpec, value, '')).toBe(UUID);
  });

  test('Non-Document ref ignores label (UUID is the canonical copy)', () => {
    const value = { _kind: 'ref', val: UUID };
    expect(canonicalizeTagValue(refSpec, value, 'Hon. Smith')).toBe(UUID);
  });

  test('ref Hayson → bare UUID (not display name)', () => {
    const value = { _kind: 'ref', val: UUID, dis: 'Hon. Jane Smith' };
    expect(canonicalizeTagValue(refSpec, value)).toBe(UUID);
  });

  test('raw "@<id>" string ref → stripped UUID', () => {
    expect(canonicalizeTagValue(refSpec, `@${UUID}`)).toBe(UUID);
  });

  test('date Hayson → ISO string', () => {
    expect(canonicalizeTagValue(dateSpec, { _kind: 'date', val: '2026-05-28' })).toBe('2026-05-28');
  });

  test('dateTime Hayson → ISO string', () => {
    expect(canonicalizeTagValue(dateSpec, { _kind: 'dateTime', val: '2026-05-28T12:00:00+00:00' })).toBe('2026-05-28T12:00:00+00:00');
  });

  test('plain string → unchanged', () => {
    expect(canonicalizeTagValue(textSpec, 'hello')).toBe('hello');
  });

  test('number → JSON-stringified', () => {
    expect(canonicalizeTagValue(numSpec, 1.5)).toBe('1.5');
  });

  test('bool → JSON-stringified', () => {
    expect(canonicalizeTagValue(boolSpec, true)).toBe('true');
  });

  test('null / undefined → empty string', () => {
    expect(canonicalizeTagValue(textSpec, null)).toBe('');
    expect(canonicalizeTagValue(textSpec, undefined)).toBe('');
  });

  test('array of refs → comma-joined UUIDs', () => {
    const arr = [
      { _kind: 'ref', val: UUID, dis: 'A' },
      { _kind: 'ref', val: '11111111-1111-1111-1111-111111111111', dis: 'B' },
    ];
    expect(canonicalizeTagValue(refSpec, arr)).toBe(
      `${UUID}, 11111111-1111-1111-1111-111111111111`,
    );
  });
});

describe('parseClipboardForSpec', () => {
  test('valid UUID → ref Hayson payload', () => {
    const res = parseClipboardForSpec(refSpec, UUID);
    expect(res.value).toEqual({ _kind: 'ref', val: UUID });
  });

  test('UUID with leading @ → ref Hayson payload', () => {
    const res = parseClipboardForSpec(refSpec, `@${UUID}`);
    expect(res.value).toEqual({ _kind: 'ref', val: UUID });
  });

  test('non-UUID for ref → error', () => {
    const res = parseClipboardForSpec(refSpec, 'Hon. Jane Smith');
    expect(res.error).toMatch(/UUID/);
  });

  test('ISO date string → date Hayson', () => {
    expect(parseClipboardForSpec(dateSpec, '2026-05-28').value).toEqual({
      _kind: 'date', val: '2026-05-28',
    });
  });

  test('ISO dateTime → date Hayson with date-portion', () => {
    expect(parseClipboardForSpec(dateSpec, '2026-05-28T12:34:00Z').value).toEqual({
      _kind: 'date', val: '2026-05-28',
    });
  });

  test('garbage date → error', () => {
    const res = parseClipboardForSpec(dateSpec, 'not a date');
    expect(res.error).toBeDefined();
  });

  test('number string → number', () => {
    expect(parseClipboardForSpec(numSpec, '42').value).toBe(42);
  });

  test('non-numeric for number spec → error', () => {
    expect(parseClipboardForSpec(numSpec, 'abc').error).toBeDefined();
  });

  test('bool "true"/"false"/"1"/"0" parse', () => {
    expect(parseClipboardForSpec(boolSpec, 'true').value).toBe(true);
    expect(parseClipboardForSpec(boolSpec, 'False').value).toBe(false);
    expect(parseClipboardForSpec(boolSpec, '1').value).toBe(true);
    expect(parseClipboardForSpec(boolSpec, '0').value).toBe(false);
  });

  test('empty clipboard → error', () => {
    expect(parseClipboardForSpec(textSpec, '   ').error).toMatch(/empty/i);
  });

  test('text spec → trimmed string', () => {
    expect(parseClipboardForSpec(textSpec, '  hello  ').value).toBe('hello');
  });
});

describe('clipboardSupport', () => {
  test('markers → no copy/paste', () => {
    expect(clipboardSupport(boolSpec)).toEqual({ copy: false, paste: false });
  });
  test('value spec → both', () => {
    expect(clipboardSupport(textSpec)).toEqual({ copy: true, paste: true });
  });
  test('computed spec → copy-only', () => {
    expect(clipboardSupport(computedSpec)).toEqual({ copy: true, paste: false });
  });
});
