import { TextDecoder, TextEncoder } from 'node:util';

// `connectivity` pulls in the prisma client, which touches TextEncoder at
// import time. jest.setup.js polyfills it — but that file is never wired into
// jest.config.js (task #55), so the polyfill has to be applied HERE, before the
// module under test is loaded. Hence require rather than a hoisted import.
Object.assign(globalThis, { TextEncoder, TextDecoder });
const { filedOnFromTags } = require('../connectivity') as typeof import('../connectivity');

/**
 * The read-path fallback for `Filing.filingDate`, which is null across the
 * corpus. The tag is user-authored through the tag panel, so the property that
 * matters is that nothing it can contain throws — a bad date must degrade to
 * "no date", never take the scope graph down with it.
 */

describe('filedOnFromTags', () => {
  it('normalises a plain date string to ISO', () => {
    expect(filedOnFromTags(JSON.stringify({ filedOn: '2026-01-15' }))).toBe(
      '2026-01-15T00:00:00.000Z',
    );
  });

  it('unwraps a Hayson-shaped value', () => {
    expect(filedOnFromTags(JSON.stringify({ filedOn: { _kind: 'date', val: '2026-01-15' } }))).toBe(
      '2026-01-15T00:00:00.000Z',
    );
  });

  it('answers null when the tag is absent', () => {
    expect(filedOnFromTags(JSON.stringify({ motionType: 'abatement' }))).toBeNull();
  });

  it('answers null rather than throwing on junk', () => {
    for (const junk of [
      JSON.stringify({ filedOn: 'sometime last spring' }),
      JSON.stringify({ filedOn: '' }),
      JSON.stringify({ filedOn: 42 }),
      JSON.stringify({ filedOn: null }),
      JSON.stringify({ filedOn: { val: 99 } }),
      'not json at all',
      null,
      undefined,
    ]) {
      expect(filedOnFromTags(junk)).toBeNull();
    }
  });
});
