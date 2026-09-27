// Persists the crate (audio blobs + tags) in IndexedDB so records survive reloads.

const DB_NAME = 'muszi';
const STORE = 'tracks';
let dbPromise;

function open() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const library = {
  all: () => run('readonly', (s) => s.getAll()),
  put: (record) => run('readwrite', (s) => s.put(record)),
  remove: (id) => run('readwrite', (s) => s.delete(id)),
  clear: () => run('readwrite', (s) => s.clear()),
};
