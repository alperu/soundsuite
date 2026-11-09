/**
 * A 401 from the case API (remote deployment, no dashboard session) must send
 * the browser to the sign-in page with a `next` back to this URL, not render
 * "Exhibit not found".
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';

const replace = jest.fn();
const push = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  useParams: () => ({ caseNumber: '00-0000-XX', filingSlug: 'motion', exhibitLabel: 'A' }),
}));

import ExhibitDetailPage from '../page';

const PAGE = '/case-management/00-0000-XX/motion/A';

describe('<ExhibitDetailPage> on 401', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', PAGE);
    replace.mockClear();
    push.mockClear();
  });
  afterEach(() => {
    delete (global as any).fetch;
  });

  it('redirects to sign-in with next=<this page>', async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'AUTH_REQUIRED' }),
    }));
    const { findByText, queryByText } = render(<ExhibitDetailPage />);
    expect(await findByText('Sign-in required')).toBeTruthy();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/admin/login?next=${encodeURIComponent(PAGE)}`));
    expect(queryByText('Exhibit not found')).toBeNull();
  });

  it('still says "Exhibit not found" on a real miss', async () => {
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.startsWith('/api/cases?')) {
        return { ok: true, status: 200, json: async () => ({ case: { id: 'c1' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ filings: [] }) };
    });
    const { findByText } = render(<ExhibitDetailPage />);
    expect(await findByText('Exhibit not found')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
