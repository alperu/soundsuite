/**
 * @jest-environment jsdom
 *
 * "Managed by sidecarmaster" banner (task 57 / 3.6): shown only while
 * `fleet.source = follow`, names the master URL, links to the matching
 * sidecarmaster page and to the SoundSuite setting.
 */

import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import ManagedByBanner from '../admin/managed-by-banner';

describe('ManagedByBanner', () => {
  it('renders nothing in local mode', () => {
    const { container } = render(<ManagedByBanner managedBy={null} page="gpu" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the master and links to the matching sidecarmaster page', () => {
    render(
      <ManagedByBanner
        managedBy={{ url: 'https://sm.example.test', pages: { roleassign: 'https://sm.example.test/roleassign' } }}
        page="roleassign"
      />,
    );
    const banner = screen.getByTestId('managed-by-banner');
    expect(banner).toHaveTextContent('Read only.');
    expect(banner).toHaveTextContent('Managed by sidecarmaster at https://sm.example.test');
    expect(screen.getByRole('link', { name: /Open Role Assignments in sidecarmaster/ })).toHaveAttribute(
      'href',
      'https://sm.example.test/roleassign',
    );
    expect(screen.getByRole('link', { name: 'Setting' })).toHaveAttribute('href', '/admin/sidecarmaster');
  });

  it('falls back to <url>/<page> when the API gives no page link', () => {
    render(<ManagedByBanner managedBy={{ url: 'https://sm.example.test' }} page="hostprov" />);
    expect(screen.getByRole('link', { name: /Open Host Provisioning in sidecarmaster/ })).toHaveAttribute(
      'href',
      'https://sm.example.test/hostprov',
    );
  });
});
