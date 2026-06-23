const DB_NAME = 'matatu-offline';
const STORE   = 'fare-queue';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e =>
      e.target.result.createObjectStore(STORE, { keyPath: 'qid', autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = ()  => reject(req.error);
  });
}

function idbOp(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    if (req) req.onsuccess = () => resolve(req.result);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function enqueue(payload) {
  const db = await openDb();
  await idbOp(db, 'readwrite', store => store.add(payload));
}

export async function queueSize() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function flushQueue(submitFn) {
  if (!navigator.onLine) return 0;

  const db = await openDb();
  const items = await new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });

  let sent = 0;
  for (const item of items) {
    const { qid, ...payload } = item;
    try {
      await submitFn(payload);
      await idbOp(db, 'readwrite', store => store.delete(qid));
      sent++;
    } catch {
      break; // leave remainder in queue, retry next time online
    }
  }
  return sent;
}
