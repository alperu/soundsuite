'use client';

/**
 * "Managed by sidecarmaster" banner (task 57 / 3.6).
 *
 * Shown on the GPU Fleet, Mode Types, Role Assignments and Host Provisioning pages
 * while `fleet.source = follow`. The admin APIs put `managedBy` in every GET answer;
 * the pages pass it here. Nothing is shown in local mode.
 */
import Link from 'next/link';

export type MasterPage = 'gpu' | 'roletypes' | 'roleassign' | 'hostprov';

export interface ManagedBy {
  url: string;
  pages?: Partial<Record<MasterPage, string>>;
}

const PAGE_LABEL: Record<MasterPage, string> = {
  gpu: 'GPU Fleet',
  roletypes: 'Mode Types',
  roleassign: 'Role Assignments',
  hostprov: 'Host Provisioning',
};

export default function ManagedByBanner({ managedBy, page }: { managedBy: ManagedBy | null | undefined; page: MasterPage }) {
  if (!managedBy || !managedBy.url) return null;
  const href = managedBy.pages?.[page] ?? `${managedBy.url}/${page}`;
  return (
    <div
      role="status"
      data-testid="managed-by-banner"
      className="bg-amber-50 border border-amber-300 rounded-md p-3 text-sm text-amber-900 flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      <span className="font-semibold">Read only.</span>
      <span>
        Managed by sidecarmaster at{' '}
        <code className="font-mono bg-amber-100 px-1 rounded">{managedBy.url}</code>.
      </span>
      <span className="ml-auto flex items-center gap-3">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-blue-700 hover:text-blue-900 underline font-medium"
        >
          Open {PAGE_LABEL[page]} in sidecarmaster ↗
        </a>
        <Link href="/admin/sidecarmaster" className="text-amber-800 hover:text-amber-950 underline">
          Setting
        </Link>
      </span>
    </div>
  );
}
