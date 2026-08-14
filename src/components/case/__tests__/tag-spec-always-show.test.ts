import { TAG_SPEC_BY_KIND, rendersWhenEmpty, type TagSpec } from '../tag-spec';

/**
 * #88: an order's `resolves` is the edge the user opens the order to draw, so
 * hiding the row until it HAS a value put the one thing they came for behind
 * the one thing they were trying to do.
 *
 * Two halves are pinned here: the spec says the tag is worth advertising unset,
 * and the predicate the panel renders through honours that — without needing a
 * mounted panel to prove it.
 */

const specFor = (kind: keyof typeof TAG_SPEC_BY_KIND, name: string): TagSpec | undefined =>
  TAG_SPEC_BY_KIND[kind]?.find(s => s.name === name);

describe('resolves is always offered on order-shaped kinds', () => {
  for (const kind of ['order', 'proposedOrder', 'judgment', 'decree'] as const) {
    it(`${kind} lists resolves, flagged to show when empty`, () => {
      const spec = specFor(kind, 'resolves');
      expect(spec).toBeDefined();
      expect(spec?.alwaysShow).toBe(true);
    });
  }

  it('a motion does NOT grow an empty resolves row', () => {
    // The edge lives on the order; a motion's side of it is derived.
    expect(specFor('motion', 'resolves')).toBeUndefined();
  });
});

describe('rendersWhenEmpty', () => {
  const plain: TagSpec = { name: 'signedBy', tier: 'ref', doc: '' };
  const advertised: TagSpec = { name: 'resolves', tier: 'ref', doc: '', alwaysShow: true };

  it('hides an ordinary empty ref in read mode', () => {
    expect(rendersWhenEmpty(plain, false, false)).toBe(false);
  });

  it('shows an ordinary ref once it has a value', () => {
    expect(rendersWhenEmpty(plain, true, false)).toBe(true);
  });

  it('shows everything in edit mode — that is where things get set', () => {
    expect(rendersWhenEmpty(plain, false, true)).toBe(true);
  });

  it('shows an advertised ref even empty, even in read mode', () => {
    expect(rendersWhenEmpty(advertised, false, false)).toBe(true);
  });
});
