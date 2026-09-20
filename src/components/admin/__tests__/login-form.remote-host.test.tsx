/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "http://soundsuite.local/admin/login"}
 *
 * On a non-local host the `#auth=` fragment is stripped but never honoured:
 * no health probe, no login call.
 */
import React from 'react';
import { render } from '@testing-library/react';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: jest.fn() }) }));

import LoginForm from '../login-form';

const FRAG = Buffer.from('alice:s3cret').toString('base64');

it('never probes health or signs in on a non-local host', async () => {
  window.history.replaceState(null, '', `/admin/login#auth=${FRAG}`);
  expect(window.location.hostname).toBe('soundsuite.local');
  const fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
  render(<LoginForm />);
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  expect(window.location.hash).toBe('');
});
