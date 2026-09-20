/**
 * Developer-mode `#auth=` fragment gate on the admin login form.
 *
 * The fragment is honoured only on localhost AND when /api/health reports
 * devMode: true; it is always stripped from the URL first, and sign-in goes
 * through the same POST /api/admin/auth/login the form uses.
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';

const push = jest.fn();
const refresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));

import LoginForm, { decodeAuthFragment, readAuthFragment, isLocalHost } from '../login-form';

const FRAG = Buffer.from('alice:s3cret').toString('base64');

function setHash(hash: string) {
  // jsdom: location is not redefinable, but same-origin history navigation
  // updates location.hash / pathname. Host is the environment's testURL
  // (http://localhost/ by default; see login-form.remote-host.test.tsx).
  window.history.replaceState(null, '', '/admin/login' + hash);
}

function mockFetch(devMode: boolean, loginOk = true) {
  const fetchMock = jest.fn(async (url: string) => {
    if (url === '/api/health') {
      return { ok: true, status: 200, json: async () => ({ devMode }) } as any;
    }
    if (url === '/api/admin/auth/login') {
      return loginOk
        ? ({ ok: true, status: 200, json: async () => ({ user: { username: 'alice' } }) } as any)
        : ({ ok: false, status: 401, json: async () => ({ error: 'Invalid username or password' }) } as any);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('fragment helpers', () => {
  it('decodes base64 user:pass and rejects malformed values', () => {
    expect(decodeAuthFragment(FRAG)).toEqual({ username: 'alice', password: 's3cret' });
    expect(decodeAuthFragment(Buffer.from('nocolon').toString('base64'))).toBeNull();
    expect(decodeAuthFragment(Buffer.from(':pw').toString('base64'))).toBeNull();
    expect(decodeAuthFragment(Buffer.from('user:').toString('base64'))).toBeNull();
    expect(decodeAuthFragment('%%%not-base64')).toBeNull();
    // password may itself contain ':'
    expect(decodeAuthFragment(Buffer.from('u:a:b').toString('base64'))).toEqual({ username: 'u', password: 'a:b' });
  });

  it('reads and strips #auth= from the URL', () => {
    const replaceState = jest.fn();
    const win = {
      location: { hash: `#auth=${FRAG}`, pathname: '/admin/login', search: '?x=1' },
      history: { replaceState },
    } as any;
    expect(readAuthFragment(win)).toBe(FRAG);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/admin/login?x=1');
  });

  it('ignores other fragments', () => {
    const replaceState = jest.fn();
    const win = { location: { hash: '#general', pathname: '/admin/login', search: '' }, history: { replaceState } } as any;
    expect(readAuthFragment(win)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('accepts only localhost and 127.0.0.1', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('soundsuite.local')).toBe(false);
    expect(isLocalHost('10.0.0.21')).toBe(false);
  });
});

describe('<LoginForm> fragment sign-in', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/admin/login');
    push.mockClear();
    refresh.mockClear();
    delete (global as any).fetch;
  });

  it('signs in through /api/admin/auth/login when local and devMode is on', async () => {
    setHash(`#auth=${FRAG}`);
    const fetchMock = mockFetch(true);
    render(<LoginForm />);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/general'));
    const loginCall = fetchMock.mock.calls.find(([u]) => u === '/api/admin/auth/login');
    expect(loginCall).toBeDefined();
    expect(JSON.parse((loginCall as any)[1].body)).toEqual({ username: 'alice', password: 's3cret' });
    expect(window.location.hash).toBe('');
  });

  it('does nothing when devMode is off, but still strips the fragment', async () => {
    setHash(`#auth=${FRAG}`);
    const fetchMock = mockFetch(false);
    render(<LoginForm />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything()));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/admin/auth/login')).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });

  it('shows the server error when the fragment credentials are wrong', async () => {
    setHash(`#auth=${FRAG}`);
    mockFetch(true, false);
    const { findByText } = render(<LoginForm />);
    expect(await findByText('Invalid username or password')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('renders the plain form without a fragment and touches no network', async () => {
    setHash('');
    const fetchMock = mockFetch(true);
    const { getByText } = render(<LoginForm />);
    expect(getByText('Sign In')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
