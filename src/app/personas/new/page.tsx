'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PersonaCreateModal } from '@/components/personas/persona-create-modal';

/**
 * Dedicated "new persona" route. Reuses the create modal; on close or
 * successful creation, navigates back to the pool.
 */
export default function NewPersonaPage() {
  const router = useRouter();
  const [open, setOpen] = useState(true);

  return (
    <div className="p-6">
      <PersonaCreateModal
        open={open}
        onClose={() => { setOpen(false); router.push('/personas'); }}
        onCreated={(p) => { setOpen(false); router.push(`/personas/${encodeURIComponent(p.id)}`); }}
      />
      {!open && (
        <p className="text-sm text-gray-500">Redirecting…</p>
      )}
    </div>
  );
}
