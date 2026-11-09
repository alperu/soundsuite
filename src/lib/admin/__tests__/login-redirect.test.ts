import {
  afterLoginPath,
  loginUrlFor,
  loginUrlForCurrentPage,
  safeNextPath,
  DEFAULT_AFTER_LOGIN,
  LOGIN_PATH,
} from '../login-redirect';

describe('safeNextPath', () => {
  it('accepts a same-origin path with a query', () => {
    expect(safeNextPath('/case-management/00-0000-XX/motion?doc=1')).toBe('/case-management/00-0000-XX/motion?doc=1');
  });

  it('takes the first value of an array', () => {
    expect(safeNextPath(['/a', '/b'])).toBe('/a');
  });

  it('drops a fragment and keeps the normalised path', () => {
    expect(safeNextPath('/case-management/x#frag')).toBe('/case-management/x');
  });

  it('never resolves off the probe origin', () => {
    // Belt and braces: anything the regex misses must still fail the origin check.
    expect(safeNextPath('/%09/evil.example')).toBe('/%09/evil.example');
    expect(new URL('/%09/evil.example', 'https://h.test').host).toBe('h.test');
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['relative'],
    ['https://evil.example/x'],
    ['//evil.example/x'],
    ['/\\evil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['/ok\r\nSet-Cookie: x'],
    ['/a\\b'],
    [LOGIN_PATH],
    [`${LOGIN_PATH}?next=/x`],
    [`${LOGIN_PATH}/deeper`],
  ])('rejects %p', (raw) => {
    expect(safeNextPath(raw as any)).toBeNull();
  });
});

describe('afterLoginPath', () => {
  it('falls back to the admin dashboard', () => {
    expect(afterLoginPath(undefined)).toBe(DEFAULT_AFTER_LOGIN);
    expect(afterLoginPath('//evil')).toBe(DEFAULT_AFTER_LOGIN);
  });
  it('returns the validated path', () => {
    expect(afterLoginPath('/case-management')).toBe('/case-management');
  });
});

describe('loginUrlFor', () => {
  it('encodes next into the login URL', () => {
    expect(loginUrlFor('/case-management/x?doc=1')).toBe(`${LOGIN_PATH}?next=${encodeURIComponent('/case-management/x?doc=1')}`);
  });
  it('omits next when unsafe', () => {
    expect(loginUrlFor('https://evil.example')).toBe(LOGIN_PATH);
  });
  it('reads the current page from a location-like object', () => {
    expect(loginUrlForCurrentPage({ pathname: '/case-management/x', search: '?a=1' })).toBe(
      `${LOGIN_PATH}?next=${encodeURIComponent('/case-management/x?a=1')}`,
    );
  });
});
