/**
 * Web Worker: SSE → IndexedDB bridge for real-time file sync + background cache refresh.
 *
 * Connects to the SSE watch endpoint, receives delta events,
 * applies them to IndexedDB, and posts messages to the main thread.
 *
 * Messages IN (from main thread):
 *   { type: 'connect', caseId, apiBase }
 *   { type: 'disconnect' }
 *   { type: 'sync_cases', apiBase }         — refresh cases cache
 *   { type: 'sync_filings', caseId, apiBase } — refresh filings cache for a case
 *   { type: 'sync_documents', caseId, apiBase } — refresh documents cache for a case
 *   { type: 'invalidate', store, key }      — invalidate a specific cache entry
 *
 * Messages OUT (to main thread):
 *   { type: 'connected', watcherId }
 *   { type: 'delta', added, removed, modified }
 *   { type: 'doc_status', documentId, caseId, status, fileName }
 *   { type: 'filing_created', caseId, filingId, filingType, title, slug }
 *   { type: 'filing_updated', caseId, filingId, filingType, title, slug }
 *   { type: 'filing_deleted', caseId, filingId }
 *   { type: 'document_added', caseId, documentId, fileName, filePath, status }
 *   { type: 'document_status_changed', caseId, documentId, fileName, status }
 *   { type: 'error', message }
 *   { type: 'reconnecting', attempt }
 *   { type: 'cache_updated', store, key, data }
 */

const DB_NAME = 'legallens-cache';
const DB_VERSION = 2;

let eventSource = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 30000;

// ---------------------------------------------------------------------------
// IndexedDB helpers (duplicated here since workers can't import modules)
// ---------------------------------------------------------------------------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      if (oldVersion < 1) {
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'path' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'path' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'caseId' });
      }
      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains('cases')) db.createObjectStore('cases', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('filings')) db.createObjectStore('filings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('searchResults')) {
          const store = db.createObjectStore('searchResults', { keyPath: 'queryKey' });
          store.createIndex('accessedAt', 'accessedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('preferences')) db.createObjectStore('preferences', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putCacheEntry(storeName, key, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put({ key, data, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteCacheEntry(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function applyDelta(caseId, delta) {
  const db = await openDB();
  const tx = db.transaction(['files', 'meta'], 'readwrite');
  const filesStore = tx.objectStore('files');

  // Get current files
  const existing = await new Promise((resolve) => {
    const req = filesStore.get(caseId);
    req.onsuccess = () => resolve(req.result?.files || []);
    req.onerror = () => resolve([]);
  });

  const fileMap = new Map(existing.map(f => [f.path, f]));

  // Apply removals
  if (delta.removed) {
    for (const r of delta.removed) {
      fileMap.delete(r.path);
    }
  }

  // Apply additions
  if (delta.added) {
    for (const a of delta.added) {
      fileMap.set(a.path, { name: a.name, path: a.path, type: a.size > 0 ? 'file' : 'folder', size: a.size, mtime: a.mtime });
    }
  }

  // Apply modifications
  if (delta.modified) {
    for (const m of delta.modified) {
      fileMap.set(m.path, { name: m.name, path: m.path, type: m.size > 0 ? 'file' : 'folder', size: m.size, mtime: m.mtime });
    }
  }

  filesStore.put({ path: caseId, files: Array.from(fileMap.values()), updatedAt: Date.now() });
  tx.objectStore('meta').put({ caseId, lastSync: Date.now(), hash: '' });

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Background sync: fetch API data and update IndexedDB cache
// ---------------------------------------------------------------------------

async function syncCases(apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/cases`);
    if (!res.ok) return;
    const data = await res.json();
    const cases = data.cases || [];
    await putCacheEntry('cases', '_all', cases);
    self.postMessage({ type: 'cache_updated', store: 'cases', key: '_all', data: cases });
  } catch (err) {
    // Network error, non-critical
  }
}

async function syncFilings(caseId, apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/cases/${caseId}/filings`);
    if (!res.ok) return;
    const data = await res.json();
    const filings = data.filings || [];
    await putCacheEntry('filings', caseId, filings);
    self.postMessage({ type: 'cache_updated', store: 'filings', key: caseId, data: filings });
  } catch (err) {
    // Network error, non-critical
  }
}

async function syncDocuments(caseId, apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/cases/${caseId}/files`);
    if (!res.ok) return;
    const data = await res.json();
    // Cache both the files tree and tracked file status
    if (data.files) {
      const db = await openDB();
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put({ path: caseId, files: data.files, updatedAt: Date.now() });
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    self.postMessage({
      type: 'cache_updated',
      store: 'documents',
      key: caseId,
      data: { files: data.files, trackedFiles: data.trackedFiles },
    });
  } catch (err) {
    // Network error, non-critical
  }
}

// ---------------------------------------------------------------------------
// Background sync: full Case Explorer tree refresh (cases + all filings)
// ---------------------------------------------------------------------------

async function syncExplorerTree(apiBase) {
  try {
    const casesRes = await fetch(`${apiBase}/api/cases`);
    if (!casesRes.ok) return;
    const casesData = await casesRes.json();
    const cases = casesData.cases || [];
    await putCacheEntry('cases', '_all', cases);

    // Fetch filings for each case in parallel
    const filingsResults = await Promise.allSettled(
      cases.map(async (c) => {
        const res = await fetch(`${apiBase}/api/cases/${c.id}/filings`);
        if (!res.ok) return null;
        const data = await res.json();
        const filings = data.filings || [];
        await putCacheEntry('filings', c.id, filings);
        return { caseId: c.id, filings };
      })
    );

    const tree = cases.map((c, i) => {
      const result = filingsResults[i];
      const filings = result?.status === 'fulfilled' && result.value ? result.value.filings : [];
      return { ...c, filings };
    });

    self.postMessage({ type: 'explorer_tree_updated', data: tree });
  } catch (err) {
    // Network error, non-critical
  }
}

// ---------------------------------------------------------------------------
// SSE connection
// ---------------------------------------------------------------------------

function connect(caseId, apiBase) {
  disconnect();

  const url = `${apiBase}/api/cases/${caseId}/watch`;
  eventSource = new EventSource(url);

  eventSource.addEventListener('connected', (e) => {
    reconnectAttempt = 0;
    const data = JSON.parse(e.data);
    self.postMessage({ type: 'connected', watcherId: data.watcherId });
  });

  eventSource.addEventListener('delta', async (e) => {
    const delta = JSON.parse(e.data);
    try {
      await applyDelta(caseId, delta);
    } catch (err) {
      // IndexedDB write failed, non-critical
    }
    self.postMessage({ type: 'delta', ...delta });
  });

  eventSource.addEventListener('doc_status', (e) => {
    const data = JSON.parse(e.data);
    self.postMessage({ type: 'doc_status', ...data });
  });

  // Filing events: created, updated, deleted
  eventSource.addEventListener('filing_created', (e) => {
    const data = JSON.parse(e.data);
    // Invalidate filings cache for this case so next read fetches fresh data
    deleteCacheEntry('filings', caseId).catch(() => {});
    self.postMessage({ type: 'filing_created', ...data });
  });

  eventSource.addEventListener('filing_updated', (e) => {
    const data = JSON.parse(e.data);
    deleteCacheEntry('filings', caseId).catch(() => {});
    self.postMessage({ type: 'filing_updated', ...data });
  });

  eventSource.addEventListener('filing_deleted', (e) => {
    const data = JSON.parse(e.data);
    deleteCacheEntry('filings', caseId).catch(() => {});
    self.postMessage({ type: 'filing_deleted', ...data });
  });

  // Document events: added, status changed
  eventSource.addEventListener('document_added', (e) => {
    const data = JSON.parse(e.data);
    self.postMessage({ type: 'document_added', ...data });
  });

  eventSource.addEventListener('document_status_changed', (e) => {
    const data = JSON.parse(e.data);
    self.postMessage({ type: 'document_status_changed', ...data });
  });

  eventSource.addEventListener('heartbeat', () => {
    // Keep-alive, no action needed
  });

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    scheduleReconnect(caseId, apiBase);
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  reconnectAttempt = 0;
}

function scheduleReconnect(caseId, apiBase) {
  reconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), MAX_RECONNECT_DELAY);
  self.postMessage({ type: 'reconnecting', attempt: reconnectAttempt });

  reconnectTimer = setTimeout(() => {
    connect(caseId, apiBase);
  }, delay);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'connect':
      connect(msg.caseId, msg.apiBase || '');
      break;
    case 'disconnect':
      disconnect();
      break;
    case 'sync_cases':
      syncCases(msg.apiBase || '');
      break;
    case 'sync_filings':
      syncFilings(msg.caseId, msg.apiBase || '');
      break;
    case 'sync_documents':
      syncDocuments(msg.caseId, msg.apiBase || '');
      break;
    case 'sync_explorer':
      syncExplorerTree(msg.apiBase || '');
      break;
    case 'invalidate':
      if (msg.store && msg.key) {
        deleteCacheEntry(msg.store, msg.key).catch(() => {});
      }
      break;
  }
};
