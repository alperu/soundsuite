'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CacheResult } from '@/lib/indexed-db';

/**
 * React hook for stale-while-revalidate data fetching with IndexedDB cache.
 *
 * On mount:
 *   1. Reads from IndexedDB cache (instant)
 *   2. If cache hit, sets data immediately and renders
 *   3. If cache is stale or missing, fetches from API in background
 *   4. Updates state and cache when API responds
 *
 * @param key - Unique cache key (changing this triggers a refetch)
 * @param cacheGet - Function to read from IndexedDB
 * @param cachePut - Function to write to IndexedDB
 * @param fetchFn - Function to fetch fresh data from API
 */
export function useCachedData<T>(
  key: string | null,
  cacheGet: () => Promise<CacheResult<T> | null>,
  cachePut: (data: T) => Promise<void>,
  fetchFn: () => Promise<T>,
): {
  data: T | null;
  loading: boolean;
  isFromCache: boolean;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [isFromCache, setIsFromCache] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!key) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Step 1: Try cache
    let cached: CacheResult<T> | null = null;
    try {
      cached = await cacheGet();
    } catch {
      // IndexedDB unavailable
    }

    if (cached) {
      if (mountedRef.current) {
        setData(cached.data);
        setIsFromCache(true);
        setLoading(false);
      }

      if (cached.isStale) {
        // Revalidate in background
        try {
          const fresh = await fetchFn();
          if (mountedRef.current) {
            setData(fresh);
            setIsFromCache(false);
          }
          try { await cachePut(fresh); } catch {}
        } catch {
          // Keep stale data on network error
        }
      }
      return;
    }

    // Step 2: No cache, fetch from API
    try {
      const fresh = await fetchFn();
      if (mountedRef.current) {
        setData(fresh);
        setIsFromCache(false);
        setLoading(false);
      }
      try { await cachePut(fresh); } catch {}
    } catch {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [key, cacheGet, cachePut, fetchFn]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, [load]);

  const refresh = useCallback(async () => {
    if (!key) return;
    try {
      const fresh = await fetchFn();
      if (mountedRef.current) {
        setData(fresh);
        setIsFromCache(false);
      }
      try { await cachePut(fresh); } catch {}
    } catch {
      // silent
    }
  }, [key, fetchFn, cachePut]);

  return { data, loading, isFromCache, refresh };
}
