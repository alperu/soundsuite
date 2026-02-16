/**
 * IndexedDB client-side cache for Sound Suite.
 *
 * Database: soundsuite-cache
 * Stores:
 *   - folders: keyed by path, stores folder tree snapshots
 *   - files: keyed by path (caseId), stores file entries per case
 *   - meta: keyed by caseId, stores sync timestamps and hashes
 *   - cases: keyed by '_all', stores the full case list with stats
 *   - filings: keyed by caseId, stores filings per case
 *   - documents: keyed by caseId, stores document metadata per case
 *   - searchResults: keyed by query hash, stores cached search results
 *   - preferences: keyed by name, stores user preferences
 *
 * Provides a stale-while-revalidate pattern: cached data is returned
 * immediately and fresh data is fetched in the background.
 */

const DB_NAME = 'soundsuite-cache';
const DB_VERSION = 2;

// Max age before data is considered stale (ms). Stale data is still returned
// but triggers a background refresh.
const STALE_MS = 30_000; // 30 seconds

// Max entries in the searchResults store (LRU eviction)
const MAX_SEARCH_RESULTS = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IDBFileEntry {
  name: string;
  path: string;
  type: 'file' | 'folder';
  size?: number;
  mtime?: number;
  children?: IDBFileEntry[];
}

export interface IDBMeta {
  caseId: string;
  lastSync: number;
  hash: string;
}

export interface IDBCaseRecord {
  id: string;
  name: string;
  path: string;
  caseNumber?: string | null;
  jurisdiction?: string | null;
  county?: string | null;
  state?: string | null;
  country?: string | null;
  totalDocuments: number;
  statusCounts?: {
    QUEUED: number;
    PROCESSING: number;
    INDEXED: number;
    ERROR: number;
  };
  createdAt?: string;
}

export interface IDBFilingRecord {
  id: string;
  filingType: string;
  title: string;
  slug: string;
  filingDate?: string | null;
  description?: string | null;
  documents?: IDBDocumentRecord[];
}

export interface IDBDocumentRecord {
  id: string;
  fileName: string;
  filePath?: string;
  status: string;
  documentType?: string | null;
  exhibitLabel?: string | null;
  pageCount?: number | null;
  documentSummary?: string | null;
  createdAt?: string;
  updatedAt?: string;
  detectedExhibits?: number;
  errorMessage?: string | null;
}

export interface IDBSearchResult {
  queryKey: string;
  query: string;
  results: any[];
  updatedAt: number;
  accessedAt: number;
}

export interface IDBPreference {
  key: string;
  value: any;
  updatedAt: number;
}

/** Wrapper around cached data with staleness info */
export interface CacheResult<T> {
  data: T;
  isStale: boolean;
  updatedAt: number;
}


// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      // Version 1 stores (original)
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'caseId' });
        }
      }

      // Version 2 stores (enhanced cache)
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('cases')) {
          db.createObjectStore('cases', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('filings')) {
          db.createObjectStore('filings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('searchResults')) {
          const store = db.createObjectStore('searchResults', { keyPath: 'queryKey' });
          store.createIndex('accessedAt', 'accessedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('preferences')) {
          db.createObjectStore('preferences', { keyPath: 'key' });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });

  return dbPromise;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

async function getFromStore<T>(storeName: string, key: string): Promise<CacheResult<T> | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => {
      const entry = req.result;
      if (!entry || entry.data === undefined) {
        resolve(null);
        return;
      }
      const updatedAt = entry.updatedAt || 0;
      const isStale = Date.now() - updatedAt > STALE_MS;
      resolve({ data: entry.data as T, isStale, updatedAt });
    };
    req.onerror = () => reject(req.error);
  });
}

async function putInStore<T>(storeName: string, key: string, data: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put({ key, data, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFromStore(storeName: string, key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearStore(storeName: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Folder operations (backward-compatible)
// ---------------------------------------------------------------------------

export async function getFolder(path: string): Promise<IDBFileEntry[] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('folders', 'readonly');
    const req = tx.objectStore('folders').get(path);
    req.onsuccess = () => resolve(req.result?.entries ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setFolder(path: string, entries: IDBFileEntry[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').put({ path, entries, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// File operations (backward-compatible)
// ---------------------------------------------------------------------------

export async function getFiles(caseId: string): Promise<IDBFileEntry[] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const req = tx.objectStore('files').get(caseId);
    req.onsuccess = () => resolve(req.result?.files ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setFiles(caseId: string, files: IDBFileEntry[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put({ path: caseId, files, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Meta operations (backward-compatible)
// ---------------------------------------------------------------------------

export async function getLastSync(caseId: string): Promise<IDBMeta | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(caseId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setLastSync(caseId: string, hash: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ caseId, lastSync: Date.now(), hash });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Cases store
// ---------------------------------------------------------------------------

export async function getCachedCases(): Promise<CacheResult<IDBCaseRecord[]> | null> {
  return getFromStore<IDBCaseRecord[]>('cases', '_all');
}

export async function setCachedCases(cases: IDBCaseRecord[]): Promise<void> {
  return putInStore('cases', '_all', cases);
}

// ---------------------------------------------------------------------------
// Filings store (per case)
// ---------------------------------------------------------------------------

export async function getCachedFilings(caseId: string): Promise<CacheResult<IDBFilingRecord[]> | null> {
  return getFromStore<IDBFilingRecord[]>('filings', caseId);
}

export async function setCachedFilings(caseId: string, filings: IDBFilingRecord[]): Promise<void> {
  return putInStore('filings', caseId, filings);
}

// ---------------------------------------------------------------------------
// Documents store (per case)
// ---------------------------------------------------------------------------

export async function getCachedDocuments(caseId: string): Promise<CacheResult<IDBDocumentRecord[]> | null> {
  return getFromStore<IDBDocumentRecord[]>('documents', caseId);
}

export async function setCachedDocuments(caseId: string, documents: IDBDocumentRecord[]): Promise<void> {
  return putInStore('documents', caseId, documents);
}

// ---------------------------------------------------------------------------
// TrackedFiles store (document status dict per case, stored in documents store)
// ---------------------------------------------------------------------------

export async function getCachedTrackedFiles(caseId: string): Promise<CacheResult<Record<string, any>> | null> {
  return getFromStore<Record<string, any>>('documents', `tracked_${caseId}`);
}

export async function setCachedTrackedFiles(caseId: string, trackedFiles: Record<string, any>): Promise<void> {
  return putInStore('documents', `tracked_${caseId}`, trackedFiles);
}

// ---------------------------------------------------------------------------
// Search results store (with LRU eviction)
// ---------------------------------------------------------------------------

function hashQuery(query: string): string {
  // Simple hash for cache key
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // Convert to 32-bit int
  }
  return `search_${hash}`;
}

export async function getCachedSearch(query: string): Promise<CacheResult<any[]> | null> {
  const queryKey = hashQuery(query);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('searchResults', 'readwrite');
    const store = tx.objectStore('searchResults');
    const req = store.get(queryKey);
    req.onsuccess = () => {
      const entry = req.result as IDBSearchResult | undefined;
      if (!entry) {
        resolve(null);
        return;
      }
      // Update accessedAt for LRU
      store.put({ ...entry, accessedAt: Date.now() });
      const isStale = Date.now() - entry.updatedAt > STALE_MS;
      resolve({ data: entry.results, isStale, updatedAt: entry.updatedAt });
    };
    req.onerror = () => reject(req.error);
  });
}

export async function setCachedSearch(query: string, results: any[]): Promise<void> {
  const queryKey = hashQuery(query);
  const db = await openDB();

  // Evict oldest entries if over limit
  const tx = db.transaction('searchResults', 'readwrite');
  const store = tx.objectStore('searchResults');
  const countReq = store.count();

  return new Promise((resolve, reject) => {
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count >= MAX_SEARCH_RESULTS) {
        // Delete the oldest accessed entries
        const toDelete = count - MAX_SEARCH_RESULTS + 1;
        const idx = store.index('accessedAt');
        const cursorReq = idx.openCursor();
        let deleted = 0;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor && deleted < toDelete) {
            store.delete(cursor.primaryKey);
            deleted++;
            cursor.continue();
          }
        };
      }

      const now = Date.now();
      store.put({
        queryKey,
        query,
        results,
        updatedAt: now,
        accessedAt: now,
      });
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Preferences store
// ---------------------------------------------------------------------------

export async function getPreference<T = any>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('preferences', 'readonly');
    const req = tx.objectStore('preferences').get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setPreference<T = any>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('preferences', 'readwrite');
    tx.objectStore('preferences').put({ key, value, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deletePreference(key: string): Promise<void> {
  return deleteFromStore('preferences', key);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function clearCase(caseId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['folders', 'files', 'meta', 'filings', 'documents'], 'readwrite');
    tx.objectStore('files').delete(caseId);
    tx.objectStore('meta').delete(caseId);
    tx.objectStore('filings').delete(caseId);
    tx.objectStore('documents').delete(caseId);
    tx.objectStore('documents').delete(`tracked_${caseId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const storeNames = [
      'folders', 'files', 'meta', 'cases', 'filings',
      'documents', 'searchResults', 'preferences',
    ];
    const tx = db.transaction(storeNames, 'readwrite');
    for (const name of storeNames) {
      tx.objectStore(name).clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSearchCache(): Promise<void> {
  return clearStore('searchResults');
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate helper
//
// Returns cached data immediately if available, then fetches fresh data
// from the API and updates the cache + calls onUpdate with fresh data.
// ---------------------------------------------------------------------------

export interface SWROptions<T> {
  cacheGet: () => Promise<CacheResult<T> | null>;
  cachePut: (data: T) => Promise<void>;
  fetchFn: () => Promise<T>;
  onUpdate?: (data: T) => void;
}

export async function staleWhileRevalidate<T>(
  opts: SWROptions<T>
): Promise<{ data: T | null; isFromCache: boolean }> {
  const { cacheGet, cachePut, fetchFn, onUpdate } = opts;

  let cached: CacheResult<T> | null = null;
  try {
    cached = await cacheGet();
  } catch {
    // IndexedDB not available
  }

  if (cached && !cached.isStale) {
    // Fresh cache hit — no need to revalidate
    return { data: cached.data, isFromCache: true };
  }

  if (cached) {
    // Stale cache — return immediately but revalidate in background
    fetchFn()
      .then(async (fresh) => {
        try { await cachePut(fresh); } catch {}
        onUpdate?.(fresh);
      })
      .catch(() => {});
    return { data: cached.data, isFromCache: true };
  }

  // No cache — must fetch
  try {
    const fresh = await fetchFn();
    try { await cachePut(fresh); } catch {}
    return { data: fresh, isFromCache: false };
  } catch {
    return { data: null, isFromCache: false };
  }
}
