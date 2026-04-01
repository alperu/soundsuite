'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { getPreference, setPreference } from '@/lib/indexed-db';

/**
 * useState backed by IndexedDB preferences.
 * Loads the persisted value on mount, and writes back on every change.
 */
export function usePersistedState<T>(key: string, initialValue: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initialValue);
  const initialized = useRef(false);

  useEffect(() => {
    getPreference<T>(key).then(stored => {
      if (stored !== null) setValue(stored);
      initialized.current = true;
    }).catch(() => { initialized.current = true; });
  }, [key]);

  const setAndPersist = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      if (initialized.current) setPreference(key, next).catch(() => {});
      return next;
    });
  }, [key]);

  return [value, setAndPersist];
}
