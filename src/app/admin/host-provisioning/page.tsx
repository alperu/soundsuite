import { redirect } from 'next/navigation';

/**
 * Friendly path `/admin/host-provisioning` → the dashboard's `hostprov` tab
 * (matches every other admin section that lives under [[...tab]]).
 */
export default function HostProvisioningPage() {
  redirect('/admin/hostprov');
}
