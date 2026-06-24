const DB_NAME = 'dm-journeys';
const DB_VERSION = 1;
const STORE = 'journeys';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function journeyId(fromId, toId) {
  return `${fromId}|${toId}`;
}

export async function saveJourney(fromId, fromName, toId, toName) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({ id: journeyId(fromId, toId), fromId, fromName, toId, toName, savedAt: Date.now() });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

export async function removeJourney(fromId, toId) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(journeyId(fromId, toId));
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

export async function listJourneys() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).index('savedAt').getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = e => resolve([...e.target.result].reverse()); // newest first
    req.onerror = e => reject(e.target.error);
  });
}

export async function isJourneySaved(fromId, toId) {
  const db = await openDb();
  const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(journeyId(fromId, toId));
  return new Promise((resolve, reject) => {
    req.onsuccess = e => resolve(!!e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}
