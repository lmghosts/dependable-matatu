const DB_NAME = 'matatu-identity';
const STORE   = 'kv';
const KEY     = 'device_id';

let cached = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = ()  => reject(req.error);
  });
}

export async function getDeviceId() {
  if (cached) return cached;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const get   = store.get(KEY);
    get.onsuccess = () => {
      if (get.result) { cached = get.result; return resolve(get.result); }
      const id = crypto.randomUUID();
      store.put(id, KEY);
      cached = id;
      resolve(id);
    };
    get.onerror = () => reject(get.error);
  });
}
