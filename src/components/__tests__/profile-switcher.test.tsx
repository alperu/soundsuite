/**
 * @jest-environment jsdom
 *
 * Profile switcher: the legacy "Default" row is editable (no disabled
 * controls), create sends a display name + folder slug, duplicates and
 * server errors show a clear message, delete asks to confirm and is hidden
 * for the adopted default.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileSwitcher, slugifyProfileName } from '../profile-switcher';

type Row = { name: string; displayName: string; active: boolean; adopted?: boolean; cases: Array<{ id: string }> };
let listing: { active: string; legacy: boolean; profiles: Row[] };
let calls: Array<{ url: string; method: string; body?: unknown }>;
let nextWrite: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextWrite = { status: 200, body: {} };
  listing = { active: 'legacy', legacy: true, profiles: [{ name: 'legacy', displayName: 'Default', active: true, adopted: true, cases: [] }] };
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (method === 'GET') return reply(200, listing);
    return reply(nextWrite.status, nextWrite.body);
  }) as unknown as typeof fetch;
});

describe('slugifyProfileName', () => {
  it('makes a folder name from a display name', () => {
    expect(slugifyProfileName('Test profile')).toBe('test-profile');
    expect(slugifyProfileName('  Çase Ünit #2 ')).toBe('case-unit-2');
  });
});

describe('ProfileSwitcher', () => {
  it('does not disable the selector or the edit button on the legacy layout', async () => {
    render(<ProfileSwitcher collapsed={false} />);
    const select = await screen.findByRole('combobox', { name: 'Profile' });
    expect(select).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit profiles' })).toBeEnabled();
    expect(screen.getByRole('option', { name: /New profile/ })).toBeInTheDocument();
  });

  it('renames the legacy row through PATCH /api/profiles/legacy', async () => {
    render(<ProfileSwitcher collapsed={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit profiles' }));
    const display = screen.getByDisplayValue('Default');
    fireEvent.change(display, { target: { value: 'Main' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('/api/profiles/legacy');
    expect(patch.body).toMatchObject({ displayName: 'Main' });
    // the adopted default never offers delete
    expect(screen.queryByText(/delete profile/)).not.toBeInTheDocument();
  });

  it('creates a profile with a display name and a slug folder name', async () => {
    render(<ProfileSwitcher collapsed={false} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Profile' }), { target: { value: '__new__' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Profile name' }), { target: { value: 'Test profile' } });
    nextWrite = { status: 201, body: { profile: { name: 'test-profile' } } };
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/profiles')).toBe(true));
    expect(calls.find((c) => c.url === '/api/profiles' && c.method === 'POST')!.body).toMatchObject({
      name: 'test-profile',
      displayName: 'Test profile',
    });
  });

  it('refuses a duplicate name before calling the server', async () => {
    render(<ProfileSwitcher collapsed={false} />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Profile' }), { target: { value: '__new__' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Profile name' }), { target: { value: 'default' } });
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('shows the server message on a 409 and an admin hint on a 401', async () => {
    render(<ProfileSwitcher collapsed={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit profiles' }));
    nextWrite = { status: 409, body: { error: { message: 'profile already exists with the name "Main"' } } };
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByText('profile already exists with the name "Main"')).toBeInTheDocument();
    nextWrite = { status: 401, body: { error: 'Unauthorized', code: 'AUTH_REQUIRED' } };
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByText('Unauthorized')).toBeInTheDocument();
  });

  it('asks to confirm before deleting a non-active profile', async () => {
    listing = {
      active: 'default',
      legacy: false,
      profiles: [
        { name: 'default', displayName: 'Main', active: true, adopted: true, cases: [] },
        { name: 'test-profile', displayName: 'Test profile', active: false, cases: [] },
      ],
    };
    render(<ProfileSwitcher collapsed={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit profiles' }));
    fireEvent.change(screen.getByDisplayValue('Main (active)'), { target: { value: 'test-profile' } });
    fireEvent.click(screen.getByRole('button', { name: /delete profile/ }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'yes, delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/profiles/test-profile')).toBe(true));
  });
});
