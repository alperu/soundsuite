'use client';

import { createContext, useContext, useMemo } from 'react';
import type { EntityKind } from './tag-spec';

export interface SelectedEntity {
  entityKind: EntityKind | null;
  entityId: string | null;
  /** Optional human-friendly label for the panel header (e.g. case name). */
  entityLabel?: string;
}

const Ctx = createContext<SelectedEntity>({ entityKind: null, entityId: null });

export function SelectedEntityProvider({
  entityKind,
  entityId,
  entityLabel,
  children,
}: {
  entityKind: EntityKind | null;
  entityId: string | null;
  entityLabel?: string;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ entityKind, entityId, entityLabel }),
    [entityKind, entityId, entityLabel],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSelectedEntity(): SelectedEntity {
  return useContext(Ctx);
}
