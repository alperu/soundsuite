'use client';

import { useRouter } from 'next/navigation';
import { CourtCreateModal } from '@/components/courts/court-create-modal';

export default function NewCourtPage() {
  const router = useRouter();
  return (
    <div className="flex-1 flex h-full bg-gray-50">
      <CourtCreateModal
        open
        onClose={() => router.push('/courts')}
        onCreated={(c) => router.push(`/courts/${encodeURIComponent(c.id)}`)}
      />
    </div>
  );
}
